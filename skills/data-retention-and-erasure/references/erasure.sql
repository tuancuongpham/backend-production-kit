-- Erasure requests ("delete my data"): the durable record of what was erased where and when.
-- subject_id is kept only while some store still has to be erased; afterwards the hash alone remains, which is
-- enough to prove the request was handled without keeping the person's identity.
CREATE TABLE IF NOT EXISTS erasure_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id    text,                          -- NULL once every store is done
  subject_hash  text NOT NULL,                 -- sha256(pepper || subject id)
  requested_at  timestamptz NOT NULL DEFAULT now(),
  due_at        timestamptz NOT NULL,          -- the legal deadline you committed to
  db_done_at    timestamptz,                   -- every inventoried table, in one transaction
  db_rows       jsonb NOT NULL DEFAULT '{}',   -- table → rows deleted or anonymized
  stores        jsonb NOT NULL DEFAULT '{}',   -- store → { status: pending|done, attempts, error, done_at }
  lease_id      uuid,                          -- the run working on it: only that run may write the outcome back
  locked_until  timestamptz,                   -- after this, another run may take the request over
  completed_at  timestamptz
);
ALTER TABLE erasure_requests ADD COLUMN IF NOT EXISTS lease_id uuid;            -- upgrade from 0.4.0
ALTER TABLE erasure_requests ADD COLUMN IF NOT EXISTS locked_until timestamptz;
CREATE INDEX IF NOT EXISTS erasure_requests_open_idx ON erasure_requests (requested_at) WHERE completed_at IS NULL;
