// PII / secret redaction for logs, traces, error reports and audit trails.
// Two mechanisms: key-based (drop values under sensitive keys) and pattern-based
// (find PII inside free text). Apply at the sink boundary (logger, span exporter,
// error tracker) so call sites can't forget.
import { createHmac } from 'node:crypto';

export interface Detector {
  name: string; // used in the placeholder: [EMAIL], [PHONE]...
  /**
   * Must be global (g). Keep every quantifier bounded ({1,64}, not +): logs carry attacker-controlled
   * strings, and an unbounded quantifier that fails late turns one big log line into an O(n²) scan.
   */
  pattern: RegExp;
  /** Cheap non-global pre-check; the full pattern only runs when it matches (most strings have no PII). */
  hint?: RegExp;
  /** Optional extra check to cut false positives (e.g. Luhn for cards). */
  validate?: (match: string) => boolean;
}

export interface RedactorOptions {
  /** If set, placeholders carry a short HMAC so the same value correlates across log lines: [EMAIL:3f9a1c]. */
  hmacKey?: string;
  /** Keys whose whole value is replaced, matched case-insensitively against the key name. */
  sensitiveKeys?: RegExp;
  detectors?: Detector[];
  maxDepth?: number;
  /** Longer strings are truncated before scanning (bounds CPU per log line). Default 16 KiB. */
  maxStringLength?: number;
}

export function luhnValid(digits: string): boolean {
  const d = digits.replace(/\D/g, '');
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = d.charCodeAt(d.length - 1 - i) - 48;
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

// Order matters: secrets first (they may contain digits or look like an email), then specific → generic. Each
// detector skips what an earlier one already replaced.

/**
 * Nine digits, grouped any way (0901 234 567, 09 01 23 45 67, 4111-1111-…): the fewest any number detector matches.
 * Not three digits in a row: a number written in pairs has none, and its detector would never run.
 */
const NINE_DIGITS = /\d(?:\D?\d){8}/;

/**
 * Names that say "secret": the end of a longer name (access_token, DB_PASSWORD, X-Amz-Signature, STRIPE_SECRET_KEY)
 * or a whole short name (sig, otp, pin). Not a bare `key`: cache keys and sort keys fill debug logs.
 */
const SECRET_NAME = String.raw`(?:[\w.-]{0,64}?(?:token|secret|password|passwd|pwd|credential|signature|(?:api|access|secret|private|signing|encryption|client|master)[_-]?key|apikey)|sig|otp|pin|cvv|cvc)`;
const SECRET_HINT = /token|secret|passw|pwd|credential|signature|key|sig|otp|pin|cvv|cvc/i;
/** A placeholder ([JWT], [EMAIL:3f9a1c]) is not a value to redact again. */
const NOT_PLACEHOLDER = String.raw`(?!\[[A-Z_]{1,32}(?::[0-9a-f]{6})?\])`;

export const defaultDetectors: Detector[] = [
  // ---- Secrets.
  { name: 'JWT', hint: /eyJ/, pattern: /\beyJ[A-Za-z0-9_-]{5,4096}\.[A-Za-z0-9_-]{5,8192}\.[A-Za-z0-9_-]{5,1024}/g },
  { name: 'BEARER', hint: /bearer|basic/i, pattern: /\b(Bearer|Basic)\s{1,8}[A-Za-z0-9._~+/-]{8,4096}={0,2}/gi },
  // user:password inside a URL (connection strings, webhook targets). Scheme and host stay readable:
  // postgres://[URL_CREDENTIALS]@db.internal:5432/shop.
  { name: 'URL_CREDENTIALS', hint: /:\/\/[^\s/]{1,300}@/, pattern: /(?<=\b[a-z][a-z0-9+.-]{1,20}:\/\/)[^\s:/@]{1,128}:[^\s/@]{1,256}(?=@)/gi },
  // Key formats: sk_/pk_/rk_/whsec_ prefixes (Stripe, OpenAI, Anthropic), GitHub (classic and fine-grained), AWS
  // access key ids, Google API keys, Slack.
  {
    name: 'API_KEY',
    hint: /(?:sk|pk|rk|whsec)[-_]|gh[pousr]_|github_pat_|AKIA|ASIA|AIza|xox[abposr]-/,
    pattern:
      /\b(?:(?:sk|pk|rk|whsec)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{16,256}|(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xox[abposr]-[A-Za-z0-9-]{10,250})\b)/g,
  },
  // Any other value under a secret's name: in query strings and env dumps (access_token=…, X-Amz-Signature=…,
  // DB_PASSWORD=…), and in JSON text, a raw request body logged as a string ("password": "…"). Only the value goes.
  {
    name: 'SECRET',
    hint: SECRET_HINT,
    pattern: new RegExp(
      String.raw`(?<=(?:^|[\s?&;,"'({])${SECRET_NAME}=)${NOT_PLACEHOLDER}[^\s&#"',;)]{1,4096}` +
        String.raw`|(?<="${SECRET_NAME}"\s{0,8}:\s{0,8}")${NOT_PLACEHOLDER}(?:[^"\\\n]|\\.){1,4096}(?=")`,
      'gi',
    ),
  },
  // ---- Personal data.
  // Letters and marks of any script: addresses such as nguyễn@ví-dụ.vn, precomposed or decomposed. RFC 5321 limits
  // (local part ≤ 64, domain ≤ 253) bound the work per match, and a match only starts where a run of address
  // characters starts: retrying at every character of a long run cost 50 ms on a 16 KiB line without a dot.
  { name: 'EMAIL', hint: /@/, pattern: /(?<![\p{L}\p{M}\p{N}._%+-])[\p{L}\p{M}\p{N}._%+-]{1,64}@[\p{L}\p{M}\p{N}.-]{1,253}\.\p{L}{2,24}/gu },
  // 13–19 digits, optional single space/dash separators, Luhn-checked so order ids survive.
  { name: 'CARD', hint: NINE_DIGITS, pattern: /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g, validate: luhnValid },
  // Vietnamese citizen ids: the 12-digit CCCD (a 0xx province code) anywhere; after its label, also the older 9-digit
  // CMND and a CCCD written with separators. Nine digits on their own are everywhere (order ids, amounts).
  {
    name: 'NATIONAL_ID',
    hint: NINE_DIGITS,
    pattern:
      /(?<!\d)0\d{11}(?!\d)|(?<=(?:cmnd|cccd|cmt|căn cước(?: công dân)?|chứng minh(?: nhân dân| thư)?|số định danh)[^\d\n]{0,24})\d(?:[ .]?\d){8}(?:(?:[ .]?\d){3})?(?!\d)/giu,
  },
  // Vietnamese mobile numbers: 0, 84 or +84 (also in parentheses), then 3/5/7/8/9 and 8 digits, separators allowed.
  { name: 'PHONE', hint: NINE_DIGITS, pattern: /(?<![\d+])(?:\(\+?84\)|\+?84|0)[ .-]?[35789](?:[ .-]?\d){8}(?!\d)/g },
];

/** String(value), without throwing for a value that has no string form (an object without a prototype). */
function textOf(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '[UNREADABLE]';
  }
}

export const defaultSensitiveKeys =
  /^(pass(word)?|pwd|secret|.*_secret|token|.*_token|access_?token|refresh_?token|authorization|cookie|set-cookie|api_?key|x-api-key|cvv|cvc|otp|pin|private_?key)$/i;

/**
 * The redactor is a plain object of closures, not a class instance: its functions are meant to be passed around
 * detached (`{ redact: redactor.redactString }`), which would lose `this` on a class method.
 */
export function createRedactor(opts: RedactorOptions = {}) {
  const detectors = opts.detectors ?? defaultDetectors;
  for (const d of detectors) {
    // replace() with a non-global pattern stops after the first match: the second email in a line would leak.
    if (!d.pattern.global) throw new TypeError(`redactor: detector ${d.name}: pattern must be global (g flag), or only its first match per string is redacted`);
    // test() on a g or y regex resumes at lastIndex: the hint would skip every other string.
    if (d.hint && (d.hint.global || d.hint.sticky)) throw new TypeError(`redactor: detector ${d.name}: hint must not have the g or y flag`);
  }
  const sensitiveKeys = opts.sensitiveKeys ?? defaultSensitiveKeys;
  const maxDepth = opts.maxDepth ?? 8;
  const maxLen = opts.maxStringLength ?? 16 * 1024;
  // The shortest thing any default detector matches ("pin=1" is 5 chars).
  const minLen = opts.detectors ? 1 : 5;

  const placeholder = (name: string, value: string) =>
    opts.hmacKey
      ? `[${name}:${createHmac('sha256', opts.hmacKey).update(value).digest('hex').slice(0, 6)}]`
      : `[${name}]`;

  function redactString(input: string): string {
    if (input.length < minLen) return input;
    // A cut inside an emoji would leave half of it: invalid text for whatever reads the log line next.
    let out = input.length > maxLen ? `${input.slice(0, maxLen).toWellFormed()}…[TRUNCATED ${input.length - maxLen} chars]` : input;
    // Detectors that share a hint sit next to each other (cards, ids, phones): once it fails, it fails again until a
    // detector changes the text, so it isn't tested again. Most lines hold no PII, and the hints are their whole cost.
    let failed: RegExp | undefined;
    for (const d of detectors) {
      if (d.hint && (d.hint === failed || !d.hint.test(out))) {
        failed = d.hint;
        continue;
      }
      const next = out.replace(d.pattern, (m) => (d.validate && !d.validate(m) ? m : placeholder(d.name, m)));
      if (next !== out) {
        out = next;
        failed = undefined;
      }
    }
    return out;
  }

  function redactValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
    if (typeof value === 'string') return redactString(value);
    if (value === null || typeof value !== 'object') return value;
    if (depth >= maxDepth) return '[DEPTH]';
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);
    // Reading an object can run code: an ORM entity's lazy relation, a Proxy, a library's error with a getter for
    // its message. Logging must not throw because of it: a property that can't be read is replaced on its own, an
    // object that can't be read at all is replaced whole.
    try {
      return redactObject(value, depth, seen);
    } catch {
      return '[UNREADABLE]';
    }
  }

  function redactObject(value: object, depth: number, seen: WeakSet<object>): unknown {
    if (value instanceof Error) {
      // What makes an error debuggable, and nothing else: an HTTP client's error also carries the request config, with
      // its Authorization header. Postgres puts the offending value in `detail`: Key (email)=(an@email.vn) already exists.
      const e = value as Error & { code?: unknown; detail?: unknown; cause?: unknown };
      return {
        name: textOf(e.name),
        message: redactString(textOf(e.message)),
        ...(typeof e.code === 'string' || typeof e.code === 'number' ? { code: e.code } : {}),
        ...(typeof e.detail === 'string' ? { detail: redactString(e.detail) } : {}),
        stack: e.stack ? redactString(textOf(e.stack)) : undefined,
        ...(e.cause !== undefined ? { cause: redactValue(e.cause, depth + 1, seen) } : {}),
      };
    }
    if (value instanceof Date) return value;
    if (ArrayBuffer.isView(value)) return `[BINARY ${value.byteLength}B]`;
    if (value instanceof Map) return redactValue(Object.fromEntries([...value].map(([k, v]) => [textOf(k), v])), depth, seen);
    if (value instanceof Set) return redactValue([...value], depth, seen);
    if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1, seen));

    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value)) {
      if (sensitiveKeys.test(k)) {
        out[k] = '[REDACTED]'; // not even read
        continue;
      }
      try {
        out[k] = redactValue((value as Record<string, unknown>)[k], depth + 1, seen);
      } catch {
        out[k] = '[UNREADABLE]'; // its getter threw
      }
    }
    return out;
  }

  return { redactString, redactValue: (v: unknown) => redactValue(v) };
}

export type Redactor = ReturnType<typeof createRedactor>;

/**
 * pino integration:
 *   const redactor = createRedactor({ hmacKey: process.env.LOG_HMAC_KEY });
 *   const logger = pino({ ...pinoRedactionOptions(redactor), redact: ['req.headers.authorization'] });
 * `redact` paths (pino's fast path) handle known locations; the formatter catches free text.
 */
export function pinoRedactionOptions(redactor: Redactor) {
  return {
    formatters: {
      log: (obj: Record<string, unknown>) => redactor.redactValue(obj) as Record<string, unknown>,
    },
    hooks: {
      logMethod(this: unknown, args: unknown[], method: (...a: unknown[]) => void) {
        method.apply(this, args.map((a) => (typeof a === 'string' ? redactor.redactString(a) : a)));
      },
    },
  };
}
