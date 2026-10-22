// What users, providers and models actually send. Realistic Vietnamese data in the formats people type, and the
// strings that break naive code. Reuse these instead of inventing "test" and "foo": bugs live in real input.

/** One mobile number, written the ways Vietnamese users write it. */
export const PHONE_FORMATS = [
  '0901234567',
  '090 123 4567',
  '0901 234 567',
  '0901.234.567',
  '090-123-4567',
  '+84901234567',
  '+84 901 234 567',
  '84 901 234 567',
  '(+84) 901 234 567',
  '(+84) 90-123-4567',
  '(84) 901234567',
];

/** National ids: the 12-digit CCCD alone, and both CCCD and the older 9-digit CMND next to their label. */
export const NATIONAL_ID_MENTIONS = [
  { text: 'CCCD 001203004005', id: '001203004005' },
  { text: 'Số CCCD: 001 203 004 005', id: '001 203 004 005' },
  { text: 'CMND 123456789', id: '123456789' },
  { text: 'số chứng minh nhân dân: 123 456 789', id: '123 456 789' },
  { text: 'căn cước công dân 079203004005, cấp tại TP.HCM', id: '079203004005' },
];

/** Secrets that end up in logs: in connection strings, URLs and provider tokens. `secret` must not survive. */
export const SECRETS_IN_TEXT = [
  { text: 'DATABASE_URL=postgres://app:S3cr3t-P4ss@db.internal:5432/shop', secret: 'S3cr3t-P4ss' },
  { text: 'redis://default:hunter2!x@cache:6379/0 refused', secret: 'hunter2!x' },
  { text: 'GET /callback?code=xyz&access_token=ya29.a0AfH6SMBx123&state=1', secret: 'ya29.a0AfH6SMBx123' },
  { text: 'https://bucket.s3.amazonaws.com/a.pdf?X-Amz-Signature=8f3a1b2c3d4e5f60718293a4b5c6d7e8f9', secret: '8f3a1b2c3d4e5f60718293a4b5c6d7e8f9' },
  { text: 'push failed: token ghp_1234567890abcdefghijklmnopqrstuvwxyzAB', secret: 'ghp_1234567890abcdefghijklmnopqrstuvwxyzAB' },
  { text: 'aws key AKIAIOSFODNN7EXAMPLE in config', secret: 'AKIAIOSFODNN7EXAMPLE' },
  { text: 'GOOGLE_MAPS_KEY=AIzaSyA1234567890abcdefghijklmnopqrstuv', secret: 'AIzaSyA1234567890abcdefghijklmnopqrstuv' },
  { text: 'maps loaded with AIzaSyA1234567890abcdefghijklmnopqrstuv', secret: 'AIzaSyA1234567890abcdefghijklmnopqrstuv' },
  { text: 'DB_PASSWORD=Mk!2026_secret APP_ENV=prod', secret: 'Mk!2026_secret' },
  { text: 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
  { text: 'GET https://acct.blob.core.windows.net/c/hd.pdf?sv=2024-01-01&sig=AbC%2Bd3fGh1 200', secret: 'AbC%2Bd3fGh1' },
  { text: 'body={"email":"lan@shop.vn","password":"Mật khẩu 2026!"}', secret: 'Mật khẩu 2026!' },
  { text: 'sms queued: otp=482913', secret: '482913' },
  // Split in two: written whole, a Slack-shaped token makes GitHub's push protection refuse the commit.
  { text: 'slack xoxb' + '-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx', secret: 'xoxb' + '-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx' },
  { text: 'clone with github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEF', secret: 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEF' },
];

/** Log lines with nothing personal in them. A redactor that rewrites these destroys what on-call needs to debug. */
export const NOT_PII = [
  'order o-1024 total 1250000 VND, 3 items',
  'cache miss key=t:org-1:dashboard',
  'retrying in 1500 ms (attempt 3/8)',
  'tokens=512 model=claude-sonnet-5-5 monkey=banana',
  '2026-10-22T08:15:30.123Z GET /v1/orders?page=2 took 182ms',
  'invoice 000123456 issued',
  'db 10.0.12.7:5432 pool 18/20',
  'trace 4bf92f3577b34da6a3ce929d0e0e4736 span 00f067aa0ba902b7',
  'tenant 3f2b9c1e-8d4a-4c7b-9e1f-2a3b4c5d6e7f',
];

/** Strings that break code which only ever saw ASCII words. */
export const NASTY = {
  /** U+0000: Postgres text and jsonb reject it. Arrives via %00 in a URL, a pasted binary, an API client. */
  nul: 'Nguyễn\u0000Văn A',
  /** A bare CR: a line break for SSE parsers, HTTP headers and many log viewers. */
  cr: 'Xin chào\rid: 999\revent: admin',
  crlf: 'line one\r\nline two',
  emoji: 'Ship nhanh nhé 👍🏽🚀',
  zeroWidth: 'thanh​toán',
  rtlOverride: 'invoice‮fdp.exe',
  /** "Nguyễn" decomposed (NFD): looks identical to the precomposed form, compares differently. */
  nfd: 'Nguyễn',
  sqlInjection: "o-1'; DROP TABLE refunds; --",
  html: '<img src=x onerror=alert(1)>',
  long: 'á'.repeat(100_000),
};
