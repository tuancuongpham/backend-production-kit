// PII / secret redaction for logs, traces, error reports and audit trails.
// Two mechanisms: key-based (drop values under sensitive keys) and pattern-based
// (find PII inside free text). Apply at the sink boundary (logger, span exporter,
// error tracker) so call sites can't forget.
import { createHmac } from 'node:crypto';

export interface Detector {
  name: string; // used in the placeholder: [EMAIL], [PHONE]...
  pattern: RegExp; // must be global (g)
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

// Order matters: secrets first (they may contain digits/emails), then specific → generic.
export const defaultDetectors: Detector[] = [
  { name: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g },
  { name: 'BEARER', pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]{8,}=*/gi },
  { name: 'API_KEY', pattern: /\b(?:sk|pk|rk|whsec)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{16,}/g },
  { name: 'EMAIL', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  // 13–19 digits, optional single space/dash separators, Luhn-checked so order ids survive.
  { name: 'CARD', pattern: /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g, validate: luhnValid },
  // Vietnamese citizen ID (CCCD): 12 digits starting with a 0xx province code.
  { name: 'NATIONAL_ID', pattern: /(?<!\d)0\d{11}(?!\d)/g },
  // Vietnamese mobile numbers: 0 or +84/84, then 3/5/7/8/9 and 8 digits, separators allowed.
  { name: 'PHONE', pattern: /(?<![\d+])(?:\+?84|0)[ .-]?[35789](?:[ .-]?\d){8}(?!\d)/g },
];

export const defaultSensitiveKeys =
  /^(pass(word)?|pwd|secret|.*_secret|token|.*_token|access_?token|refresh_?token|authorization|cookie|set-cookie|api_?key|x-api-key|cvv|cvc|otp|pin|private_?key)$/i;

export function createRedactor(opts: RedactorOptions = {}) {
  const detectors = opts.detectors ?? defaultDetectors;
  const sensitiveKeys = opts.sensitiveKeys ?? defaultSensitiveKeys;
  const maxDepth = opts.maxDepth ?? 8;

  const placeholder = (name: string, value: string) =>
    opts.hmacKey
      ? `[${name}:${createHmac('sha256', opts.hmacKey).update(value).digest('hex').slice(0, 6)}]`
      : `[${name}]`;

  function redactString(input: string): string {
    let out = input;
    for (const d of detectors) {
      out = out.replace(d.pattern, (m) => (d.validate && !d.validate(m) ? m : placeholder(d.name, m)));
    }
    return out;
  }

  function redactValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
    if (typeof value === 'string') return redactString(value);
    if (value === null || typeof value !== 'object') return value;
    if (depth >= maxDepth) return '[DEPTH]';
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);

    if (value instanceof Error) {
      return {
        name: value.name,
        message: redactString(value.message),
        stack: value.stack ? redactString(value.stack) : undefined,
      };
    }
    if (value instanceof Date) return value;
    if (ArrayBuffer.isView(value)) return `[BINARY ${value.byteLength}B]`;
    if (value instanceof Map) {
      return redactValue(Object.fromEntries(value), depth, seen);
    }
    if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1, seen));

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = sensitiveKeys.test(k) ? '[REDACTED]' : redactValue(v, depth + 1, seen);
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
