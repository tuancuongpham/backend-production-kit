-- Idempotency keys: one row per (caller, key). A retried request with the same Idempotency-Key gets the
-- stored response instead of running again.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope            text NOT NULL,                 -- tenant + principal from authentication: callers never collide
  key              text NOT NULL,                 -- the client's Idempotency-Key (1–255 visible ASCII characters)
  fingerprint      text NOT NULL,                 -- sha256 of method, path and canonical body: same key, other request → 422
  status           text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'done')),
  response_status  int,
  response_body    jsonb,
  response_headers jsonb,
  locked_at        timestamptz NOT NULL DEFAULT now(), -- external effects: an old in_progress claim belongs to a dead process
  claim_token      uuid,                          -- new on every claim: only its holder may store the response or release the key
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  PRIMARY KEY (scope, key)
);
ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS claim_token uuid; -- upgrade from 0.4.0
-- pruneIdempotencyKeys: expired keys by age, so each batch is an index range, not a table scan.
CREATE INDEX IF NOT EXISTS idempotency_keys_expires_idx ON idempotency_keys (expires_at);
