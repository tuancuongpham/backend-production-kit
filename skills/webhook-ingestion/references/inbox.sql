-- Webhook inbox: every inbound event is stored once, then processed asynchronously.
-- UNIQUE (provider, event_id) is what makes retries/duplicates from the provider harmless.
CREATE TABLE IF NOT EXISTS webhook_inbox (
  id              bigserial PRIMARY KEY,
  provider        text NOT NULL,                -- 'stripe', 'vnpay', 'momo', 'github', ...
  event_id        text NOT NULL,                -- provider's id (or a hash of the payload if it has none)
  event_type      text NOT NULL,
  payload         jsonb NOT NULL,
  source          text NOT NULL DEFAULT 'webhook' CHECK (source IN ('webhook', 'reconcile')),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'dead')),
  attempts        int  NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at       timestamptz,
  lease_id        uuid,                         -- new on every claim: only its holder may finish the row
  last_error      text,
  received_at     timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz,
  UNIQUE (provider, event_id)
);
ALTER TABLE webhook_inbox ADD COLUMN IF NOT EXISTS lease_id uuid; -- upgrade from 0.4.0

-- Worker claim paths: ready-to-run rows, and rows stuck in 'processing' after a crash.
CREATE INDEX IF NOT EXISTS webhook_inbox_ready_idx ON webhook_inbox (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS webhook_inbox_stuck_idx ON webhook_inbox (locked_at) WHERE status = 'processing';
-- Retention (pruneInbox): processed rows by age, so each batch is an index range, not a table scan.
CREATE INDEX IF NOT EXISTS webhook_inbox_done_idx ON webhook_inbox (processed_at) WHERE status = 'done';
-- Dead-letter view for dashboards/alerts.
CREATE OR REPLACE VIEW webhook_dead_letters AS
  SELECT id, provider, event_id, event_type, attempts, last_error, received_at
  FROM webhook_inbox WHERE status = 'dead';
