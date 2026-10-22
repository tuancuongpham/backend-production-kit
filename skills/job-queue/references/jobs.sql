-- Background jobs in Postgres: enqueued in the caller's transaction, claimed with SKIP LOCKED, leased while
-- running, retried with backoff, dead-lettered, and run on a schedule.
CREATE TABLE IF NOT EXISTS jobs (
  id            bigserial PRIMARY KEY,
  queue         text NOT NULL DEFAULT 'default',
  kind          text NOT NULL,                     -- which handler runs it
  payload       jsonb NOT NULL DEFAULT '{}',
  priority      smallint NOT NULL DEFAULT 0,       -- lower runs first
  -- scheduled: waiting for run_at · available: due, waiting for a worker · running: leased · done · dead
  status        text NOT NULL CHECK (status IN ('scheduled', 'available', 'running', 'done', 'dead')),
  run_at        timestamptz NOT NULL DEFAULT now(),
  attempts      int NOT NULL DEFAULT 0,
  max_attempts  int NOT NULL DEFAULT 8,
  lease_id      uuid,                              -- new on every claim: a worker that lost the job can't complete it
  locked_until  timestamptz,                       -- pushed forward by heartbeats; past it the worker is presumed dead
  dedup_key     text,                              -- at most one scheduled, available or running job per (queue, key)
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);

-- Claim path. Only due jobs are 'available', in the order workers take them: delayed jobs and history stay
-- out of this index, so a claim or an idle poll costs the same next to 1 or 1,000,000 of them.
CREATE INDEX IF NOT EXISTS jobs_available_idx ON jobs (queue, priority, run_at, id) WHERE status = 'available';
-- Promotion of delayed jobs and retries once due.
CREATE INDEX IF NOT EXISTS jobs_scheduled_idx ON jobs (run_at) WHERE status = 'scheduled';
-- Rescue of jobs whose worker stopped heartbeating.
CREATE INDEX IF NOT EXISTS jobs_running_idx ON jobs (locked_until) WHERE status = 'running';
-- Retention of finished jobs, and the dead-letter list.
CREATE INDEX IF NOT EXISTS jobs_done_idx ON jobs (finished_at) WHERE status = 'done';
CREATE INDEX IF NOT EXISTS jobs_dead_idx ON jobs (finished_at) WHERE status = 'dead';
-- Unique jobs: a duplicate enqueue is dropped until the job with that key has finished.
CREATE UNIQUE INDEX IF NOT EXISTS jobs_dedup_idx ON jobs (queue, dedup_key)
  WHERE dedup_key IS NOT NULL AND status IN ('scheduled', 'available', 'running');

-- Dead letters for dashboards and alerts.
CREATE OR REPLACE VIEW job_dead_letters AS
  SELECT id, queue, kind, attempts, last_error, created_at, finished_at FROM jobs WHERE status = 'dead';

-- Queue health, one partial index per row source (no scan of the history). Alert on oldest_wait_sec of
-- 'available' (how long due work has waited), not on depth.
CREATE OR REPLACE VIEW job_queue_stats AS
  SELECT queue, 'available' AS status, count(*) AS jobs, extract(epoch FROM now() - min(run_at))::float8 AS oldest_wait_sec
    FROM jobs WHERE status = 'available' GROUP BY queue
  UNION ALL
  SELECT queue, 'scheduled', count(*), NULL FROM jobs WHERE status = 'scheduled' GROUP BY queue
  UNION ALL
  SELECT queue, 'running', count(*), NULL FROM jobs WHERE status = 'running' GROUP BY queue
  UNION ALL
  SELECT queue, 'dead', count(*), NULL FROM jobs WHERE status = 'dead' GROUP BY queue;

-- Recurring jobs: one row per schedule, moved forward in the same transaction that enqueues its run.
CREATE TABLE IF NOT EXISTS job_schedules (
  name        text PRIMARY KEY,
  next_run_at timestamptz NOT NULL
);
