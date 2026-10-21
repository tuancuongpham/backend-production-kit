-- Transactional outbox + consumer-side dedup = "effectively once".
CREATE TABLE IF NOT EXISTS outbox (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- doubles as the broker message id (dedup key)
  aggregate_type text NOT NULL,                              -- 'order'
  aggregate_id   text NOT NULL,                              -- ordering key / partition key
  event_type     text NOT NULL,                              -- 'order.placed'
  payload        jsonb NOT NULL,
  headers        jsonb NOT NULL DEFAULT '{}',                -- traceparent, tenant id, schema version
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  seq            bigserial,                                  -- insert order; equals commit order per aggregate
                                                             -- as long as writes to one aggregate are serialized
                                                             -- (row lock on the aggregate), not globally
  published_at   timestamptz,
  attempts       int NOT NULL DEFAULT 0,
  last_error     text
);
CREATE INDEX IF NOT EXISTS outbox_unpublished_idx ON outbox (seq) WHERE published_at IS NULL;

-- Each consumer records what it has applied, in the same transaction as its side effects.
CREATE TABLE IF NOT EXISTS processed_messages (
  consumer     text NOT NULL,
  message_id   uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, message_id)
);

-- Optional: wake the relay immediately instead of waiting for the next poll.
CREATE OR REPLACE FUNCTION outbox_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('outbox', NEW.id::text);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS outbox_notify_trg ON outbox;
CREATE TRIGGER outbox_notify_trg AFTER INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION outbox_notify();
