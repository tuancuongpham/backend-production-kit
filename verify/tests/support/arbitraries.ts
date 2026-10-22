// Generators for property tests (fast-check): the inputs users, models and providers send, a few hundred per
// property instead of the handful a person thinks of, and a failure shrunk to the smallest input that still fails.
// Runs are deterministic (a fixed seed), so CI is repeatable. To explore further:
//   KIT_FC_SEED=random npm test      a new seed each run; a failure prints its seed
//   KIT_FC_SEED=<seed> npm test      reproduces that failure
//   KIT_FC_RUNS=5000 npm test        more inputs per property
import fc from 'fast-check';

const seed = process.env.KIT_FC_SEED;
fc.configureGlobal({
  seed: seed === undefined ? 20261022 : seed === 'random' ? Math.floor(Math.random() * 2 ** 31) : Number(seed),
  numRuns: Number(process.env.KIT_FC_RUNS ?? 300),
});

export { fc };

// ---------- Text ----------

/** Characters that break code written for ASCII words: NUL, the line breaks, half an emoji, escapes, templates. */
const AWKWARD = ['\u0000', '\r', '\n', '\r\n', '\t', ' ', ' ', '﻿', '​', '‮', '\uD83D', '\uDE00', '\\', '\\u0000', '"', "'", '<', '%', '$&', "$'", '$1', '{{answer}}'];
/** Vietnamese as people type it: precomposed (NFC), decomposed (NFD), and đ, which has no decomposition. */
const VIETNAMESE = ['ạ', 'ă', 'â', 'đ', 'Đ', 'ê', 'ơ', 'ư', 'ữ', 'Nguyễn', 'Nguyễn'.normalize('NFD'), 'giao hàng', 'thanh toán'];

/** One "character" of user text: any grapheme (emoji included), any code point, or one of the above. */
export const textUnit = fc.oneof(
  { weight: 4, arbitrary: fc.string({ unit: 'grapheme', minLength: 1, maxLength: 1 }) },
  { weight: 2, arbitrary: fc.string({ unit: 'binary', minLength: 1, maxLength: 1 }) },
  { weight: 2, arbitrary: fc.constantFrom(...AWKWARD) },
  { weight: 2, arbitrary: fc.constantFrom(...VIETNAMESE) },
);

/** Any text a person, a provider or a model may send. */
export const anyText = (maxLength = 60) => fc.string({ unit: textUnit, maxLength });

/** Words around personal data in a sentence. No digits, @ or +, so nothing glues onto the data itself. */
export const filler = fc
  .array(fc.constantFrom('Liên hệ', 'nhé', 'cảm ơn', 'ship', 'giao', 'đơn hàng', 'ạ', '🙏', 'Hà Nội', 'TP.HCM', ':', ',', 'gọi', 'email', 'note'), { maxLength: 4 })
  .map((words) => words.join(' '));

// ---------- Personal data, written the ways people write it ----------

export interface Pii {
  kind: 'phone' | 'email' | 'card' | 'national_id';
  /** As written in the text. */
  text: string;
  /** What must not survive redaction: digits only for numbers, the whole address for emails. */
  secret: string;
}

const digits = (n: number) => fc.array(fc.integer({ min: 0, max: 9 }), { minLength: n, maxLength: n });
/** Digits, each optionally preceded by one separator, as people group numbers. */
const grouped = (ds: number[], seps: string[]) =>
  fc.array(fc.constantFrom('', '', ...seps), { minLength: ds.length, maxLength: ds.length }).map((s) => ds.map((d, i) => `${i === 0 ? '' : s[i]}${d}`).join(''));

/** A Vietnamese mobile number: 0, 84, +84 or (+84), then 3/5/7/8/9 and eight digits, in any grouping. */
export const vnMobile: fc.Arbitrary<Pii> = fc
  .tuple(fc.constantFrom('0', '84', '+84', '(+84)', '(84)'), fc.constantFrom('', ' ', '.', '-'), fc.constantFrom(3, 5, 7, 8, 9), digits(8))
  .chain(([prefix, sep, first, rest]) =>
    grouped([first, ...rest], [' ', '.', '-']).map((number) => ({ kind: 'phone' as const, text: `${prefix}${sep}${number}`, secret: [first, ...rest].join('') })),
  );

const LOCAL = 'abcdefghijklmnopqrstuvwxyz0123456789ăâđêôơư'.split('');
const LABEL = 'abcdefghijklmnopqrstuvwxyz0123456789đ'.split('');
/** An email address, ASCII or with Vietnamese letters (nguyễn@ví-dụ.vn). */
export const email: fc.Arbitrary<Pii> = fc
  .tuple(
    fc.string({ unit: fc.constantFrom(...LOCAL), minLength: 1, maxLength: 20 }),
    fc.option(fc.tuple(fc.constantFrom('.', '_', '+', '-'), fc.string({ unit: fc.constantFrom(...LOCAL), minLength: 1, maxLength: 10 })), { nil: undefined }),
    fc.array(fc.string({ unit: fc.constantFrom(...LABEL), minLength: 1, maxLength: 12 }), { minLength: 1, maxLength: 3 }),
    fc.constantFrom('vn', 'com', 'com.vn', 'io', 'việt'),
  )
  .map(([local, tail, labels, tld]) => {
    const address = `${local}${tail ? tail.join('') : ''}@${labels.join('.')}.${tld}`;
    return { kind: 'email' as const, text: address, secret: address };
  });

/** A card number that passes the Luhn check: 13 to 19 digits, grouped by spaces or dashes. */
export const cardNumber: fc.Arbitrary<Pii> = fc
  .integer({ min: 12, max: 18 })
  .chain((n) => digits(n))
  .map((body) => {
    let sum = 0;
    for (let i = 0; i < body.length; i++) {
      let d = body[body.length - 1 - i];
      if (i % 2 === 0) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
      sum += d;
    }
    return [...body, (10 - (sum % 10)) % 10];
  })
  .chain((ds) => grouped(ds, [' ', '-']).map((text) => ({ kind: 'card' as const, text, secret: ds.join('') })));

/** A citizen id: the 12-digit CCCD on its own, or a CCCD or 9-digit CMND after its label. */
export const nationalId: fc.Arbitrary<Pii> = fc.oneof(
  digits(11).map((ds) => ({ kind: 'national_id' as const, text: `0${ds.join('')}`, secret: `0${ds.join('')}` })),
  fc
    .tuple(fc.constantFrom('CMND', 'CCCD', 'cmnd số', 'Số CCCD:', 'căn cước công dân', 'số chứng minh nhân dân:'), fc.constantFrom(9, 12))
    .chain(([label, n]) => digits(n).chain((ds) => grouped(ds, [' ', '.']).map((number) => ({ kind: 'national_id' as const, text: `${label} ${number}`, secret: ds.join('') })))),
);

export const pii: fc.Arbitrary<Pii> = fc.oneof(vnMobile, email, cardNumber, nationalId);

// ---------- What models send ----------

/** A date as a model writes one: often valid, sometimes a day that doesn't exist, a 24th hour, a strange offset. */
export const dateLike = fc
  .tuple(
    fc.integer({ min: 0, max: 9999 }),
    fc.integer({ min: 0, max: 13 }),
    fc.integer({ min: 0, max: 32 }),
    fc.option(
      fc.tuple(
        fc.integer({ min: 0, max: 25 }),
        fc.integer({ min: 0, max: 61 }),
        fc.option(fc.integer({ min: 0, max: 61 }), { nil: undefined }),
        fc.option(fc.integer({ min: 0, max: 999_999 }), { nil: undefined }),
        fc.constantFrom('', 'Z', '+07:00', '-0230', '+14:00', '+25:00', '+0700'),
      ),
      { nil: undefined },
    ),
  )
  .map(([y, m, d, time]) => {
    const pad = (n: number, w = 2) => String(n).padStart(w, '0');
    const day = `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
    if (!time) return day;
    const [h, min, s, frac, zone] = time;
    return `${day}T${pad(h)}:${pad(min)}${s === undefined ? '' : `:${pad(s)}${frac === undefined ? '' : `.${frac}`}`}${zone}`;
  });

/** A value where a model was asked for a string, number or date: the right type or not, null, nested, huge. */
export const modelValue = fc.oneof(
  { weight: 4, arbitrary: anyText(80) },
  { weight: 2, arbitrary: dateLike },
  { weight: 2, arbitrary: fc.oneof(fc.integer(), fc.double(), fc.constantFrom(0, -0, 1e21, Number.MAX_SAFE_INTEGER + 2, 5e-324)) },
  { weight: 1, arbitrary: fc.constantFrom(null, true, false, '', ' ', 'null', 'undefined', '[]', '{}') },
  { weight: 1, arbitrary: fc.jsonValue({ maxDepth: 2 }) },
);
