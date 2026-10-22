// Static checks for a migration file: the statements that take long locks or break the running app.
// Pattern-based (like squawk or strong_migrations, much smaller): run it in CI on every new migration.
// Operations on a table created in the same migration are exempt: it is empty and nothing uses it yet.

export interface Finding {
  rule: string;
  severity: 'error' | 'warning';
  statement: string;
  message: string;
}

const VOLATILE_DEFAULT = /\bDEFAULT\s+(?:random\(|clock_timestamp\(|timeofday\(|gen_random_uuid\(|uuid_generate_v[14]\(|nextval\()/i;
const SERIAL_TYPE = /\bADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?\S+\s+(?:big|small)?serial\b|\bGENERATED\s+(?:ALWAYS|BY\s+DEFAULT)\s+AS\s+(?:IDENTITY|\()/i;
/** Each column definition of an ALTER TABLE … ADD [COLUMN], up to the next comma (not ADD CONSTRAINT and friends). */
const ADD_COLUMN = /\bADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?!CONSTRAINT\b|PRIMARY\b|UNIQUE\b|FOREIGN\b|CHECK\b|EXCLUDE\b)"?\w+"?\s+([^,]*)/gi;

export function lintMigration(sql: string): Finding[] {
  const statements = splitStatements(sql);
  const hasTransaction = statements.some((s) => /^(BEGIN|START\s+TRANSACTION)\b/i.test(s));
  const created = new Set<string>();
  const findings: Finding[] = [];
  const add = (rule: string, severity: Finding['severity'], statement: string, message: string) =>
    findings.push({ rule, severity, statement: statement.length > 120 ? `${statement.slice(0, 117)}...` : statement, message });

  for (const s of statements) {
    const createTable = /^CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w."]+)/i.exec(s);
    if (createTable) {
      created.add(norm(createTable[1]));
      continue;
    }
    const target = tableOf(s);
    const isNew = target !== null && created.has(target);

    if (/\bCONCURRENTLY\b/i.test(s) && hasTransaction) {
      add('concurrently-in-transaction', 'error', s, 'CONCURRENTLY cannot run inside a transaction block: run this file without BEGIN/COMMIT.');
    }
    if (/^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?!CONCURRENTLY)/i.test(s) && !isNew) {
      add('index-not-concurrent', 'error', s, 'CREATE INDEX blocks every write to the table until the build ends. Use CREATE INDEX CONCURRENTLY.');
    }
    if (/^DROP\s+INDEX\s+(?!CONCURRENTLY)/i.test(s)) {
      add('drop-index-not-concurrent', 'warning', s, 'DROP INDEX takes an ACCESS EXCLUSIVE lock on the table. Use DROP INDEX CONCURRENTLY.');
    }
    if (/^ALTER\s+TABLE/i.test(s) && !isNew) {
      if (/\bADD\s+(?:COLUMN\b)?/i.test(s) && (VOLATILE_DEFAULT.test(s) || SERIAL_TYPE.test(s))) {
        add('add-column-volatile-default', 'error', s, 'A volatile default (or serial/identity) rewrites the whole table under an ACCESS EXCLUSIVE lock. Add the column without it, backfill in batches, then set the default.');
      }
      for (const [, definition] of s.matchAll(ADD_COLUMN)) {
        if (/\bNOT\s+NULL\b/i.test(definition) && !/\b(?:DEFAULT|GENERATED)\b/i.test(definition)) {
          add('add-column-not-null', 'error', s, 'A NOT NULL column without a default fails on any table that has rows, and the deploy with it. Give it a constant DEFAULT (instant since PostgreSQL 11), or add it nullable, backfill, then SET NOT NULL through a validated CHECK.');
        }
      }
      if (/\bALTER\s+(?:COLUMN\s+)?\S+\s+(?:SET\s+DATA\s+)?TYPE\b/i.test(s)) {
        add('alter-column-type', 'warning', s, 'Changing a column type usually rewrites the table and its indexes under an ACCESS EXCLUSIVE lock. Add a new column, backfill, switch reads, drop the old one.');
      }
      if (/\bSET\s+NOT\s+NULL\b/i.test(s)) {
        add('set-not-null', 'warning', s, 'SET NOT NULL scans the table under an ACCESS EXCLUSIVE lock, unless a validated CHECK (col IS NOT NULL) already proves it: add the CHECK NOT VALID, VALIDATE it, then SET NOT NULL.');
      }
      if (/\bADD\s+(?:CONSTRAINT\s+\S+\s+)?(?:FOREIGN\s+KEY|CHECK)\b/i.test(s) && !/\bNOT\s+VALID\b/i.test(s)) {
        add('constraint-not-valid', 'error', s, 'Adding a foreign key or check validates every row while holding a lock that blocks writes. Add it NOT VALID, then VALIDATE CONSTRAINT in a separate step.');
      }
      if (/\bADD\s+(?:CONSTRAINT\s+\S+\s+)?(?:UNIQUE|PRIMARY\s+KEY)\b/i.test(s) && !/\bUSING\s+INDEX\b/i.test(s)) {
        add('unique-without-index', 'error', s, 'This builds a unique index under an ACCESS EXCLUSIVE lock. Build it with CREATE UNIQUE INDEX CONCURRENTLY, then ADD CONSTRAINT … USING INDEX.');
      }
      if (/\bRENAME\b|\bDROP\s+COLUMN\b/i.test(s)) {
        add('breaks-running-code', 'warning', s, 'The deployed code still uses the old column or name. Expand/contract: ship code that stops using it first, then drop or rename in a later release.');
      }
    }
    if (/^DROP\s+TABLE\b/i.test(s)) {
      add('breaks-running-code', 'warning', s, 'The deployed code still uses this table. Stop using it in a release first.');
    }
    if (/^(?:VACUUM\s+(?:\(.*FULL.*\)|FULL)|CLUSTER)\b/i.test(s) || (/^REINDEX\b/i.test(s) && !/\bCONCURRENTLY\b/i.test(s))) {
      add('table-rewrite', 'error', s, 'This holds an exclusive lock for the whole rewrite. Use REINDEX … CONCURRENTLY, or pg_repack for a table rewrite.');
    }
    if (/^(?:UPDATE|DELETE\s+FROM)\b/i.test(s) && !/\bWHERE\b/i.test(s)) {
      add('unbatched-dml', 'warning', s, 'One statement over the whole table: long row locks and a burst of WAL. Backfill in batches (backfill()).');
    }
    if (/^LOCK\s+TABLE\b/i.test(s)) {
      add('lock-table', 'warning', s, 'An explicit table lock queues every query behind it while it waits. Keep it short and set lock_timeout.');
    }
  }
  return findings;
}

/** The table a statement works on, normalized; null if none. */
function tableOf(s: string): string | null {
  const m =
    /^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([\w."]+)/i.exec(s) ??
    /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:[\w."]+\s+)?ON\s+(?:ONLY\s+)?([\w."]+)/i.exec(s);
  return m ? norm(m[1]) : null;
}

const norm = (name: string) => name.replace(/"/g, '').toLowerCase().replace(/^public\./, '');

/** Statements without comments, split on semicolons outside quotes and dollar-quoted bodies. */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  while (i < sql.length) {
    const rest = sql.slice(i);
    if (rest.startsWith('--')) {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end;
      continue;
    }
    if (rest.startsWith('/*')) {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
      continue;
    }
    // $$ or $tag$, where a tag is an identifier: $body$, $fn1$ (digits allowed after the first character).
    const dollar = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(rest);
    if (dollar) {
      const end = sql.indexOf(dollar[0], i + dollar[0].length);
      const stop = end < 0 ? sql.length : end + dollar[0].length;
      cur += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (sql[i] === "'") {
      // In an E'…' string a backslash escapes the next character, so E'it\'s' doesn't end at \'. (An E right before
      // the quote, and not the end of a longer identifier.)
      const escapes = /[Ee]/.test(sql[i - 1] ?? '') && !/[\w$]/.test(sql[i - 2] ?? '');
      let j = i + 1;
      while (j < sql.length && !(sql[j] === "'" && sql[j + 1] !== "'")) j += sql[j] === "'" || (escapes && sql[j] === '\\') ? 2 : 1;
      cur += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (sql[i] === ';') {
      if (cur.trim()) out.push(cur.trim().replace(/\s+/g, ' '));
      cur = '';
      i++;
      continue;
    }
    cur += sql[i++];
  }
  if (cur.trim()) out.push(cur.trim().replace(/\s+/g, ' '));
  return out;
}
