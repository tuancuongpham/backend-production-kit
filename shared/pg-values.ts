// Values from users, providers and models, made storable in Postgres. Vendored into each skill that imports it:
// edit shared/pg-values.ts, then run `npm run sync:shared`. `npm run validate` fails if a copy drifts.
//
// Postgres text and jsonb can't hold U+0000. One NUL in a form field, a chat message, a provider payload or a
// model's output fails the whole statement (22021 for text, 22P05 for jsonb): the webhook is never stored and the
// provider retries it forever, or the order's transaction rolls back because of a note. jsonb also refuses half of a
// surrogate pair (22P02), which is what `text.slice(0, n)` leaves when it cuts an emoji in two: a preview, a
// truncated model answer. These replace both with U+FFFD, the replacement character, which keeps the rest of the
// value and shows where something was dropped. (A text parameter needs no help with surrogates: the driver encodes a
// lone one as U+FFFD itself.)
//
// A BigInt, which ORMs return for bigint columns, is stored as its decimal string: JSON.stringify throws on it, and
// the response, result or payload holding it would fail to store after the work it describes was done.

const NUL = '\u0000';
const REPLACEMENT = '�';

/** `s` with every NUL replaced, for a text parameter. Other values pass through unchanged. */
export function pgText<T>(s: T): T {
  return (typeof s === 'string' && s.includes(NUL) ? s.replaceAll(NUL, REPLACEMENT) : s) as T;
}

/**
 * JSON.stringify writes a NUL as the escape \u0000 and a lone surrogate as \udXXX (a whole pair comes out as the
 * character itself). Only those escapes are replaced, not a backslash that is text followed by "u0000" (written
 * \\u0000): an escape is preceded by an even run of backslashes.
 */
const UNSTORABLE_ESCAPE = /(?<!\\)((?:\\\\)*)\\u(?:0000|d[89a-f][0-9a-f]{2})/gi;

const bigintAsString = (_key: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);

/** JSON text for a jsonb parameter: NUL and lone surrogates replaced in keys and values alike, BigInts as strings. */
export function pgJson(value: unknown): string {
  const json = JSON.stringify(value, bigintAsString) ?? 'null';
  return json.includes('\\u') ? json.replace(UNSTORABLE_ESCAPE, '$1\\ufffd') : json;
}
