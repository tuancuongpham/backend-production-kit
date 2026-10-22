-- Guardrails for agent tool calls: approvals, results by tool-call id, and an audit trail.

-- A human approval for one exact call: bound to the tool and its arguments, used once, expiring.
CREATE TABLE IF NOT EXISTS tool_approvals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    text NOT NULL,
  requested_by text NOT NULL,          -- the user whose agent session asked
  session_id   text NOT NULL,
  tool         text NOT NULL,
  args         jsonb NOT NULL,         -- shown to the approver exactly as it will run
  args_hash    text NOT NULL,          -- sha256 of the canonical arguments: other arguments never match
  reason       text NOT NULL,          -- destructive tool, or untrusted content in the context
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'used')),
  decided_by   text,
  decided_at   timestamptz,
  used_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS tool_approvals_pending_idx ON tool_approvals (tenant_id, created_at) WHERE status = 'pending';

-- Write results by tool-call id: a call the agent retries returns the first result instead of running twice.
CREATE TABLE IF NOT EXISTS tool_results (
  tenant_id    text NOT NULL,
  tool_call_id text NOT NULL,
  tool         text NOT NULL,
  args_hash    text NOT NULL,
  status       text NOT NULL CHECK (status IN ('running', 'done')),
  result       jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, tool_call_id)
);

-- Every call, allowed or not: who, what, under which approval, with which outcome.
CREATE TABLE IF NOT EXISTS tool_audit (
  id           bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  tenant_id    text NOT NULL,
  user_id      text NOT NULL,
  session_id   text NOT NULL,
  tool_call_id text,
  tool         text NOT NULL,
  tier         text,
  args_hash    text,
  outcome      text NOT NULL CHECK (outcome IN ('ok', 'error', 'approval_required', 'rejected', 'replayed')),
  approval_id  uuid,
  untrusted_context boolean NOT NULL,
  detail       text
);
CREATE INDEX IF NOT EXISTS tool_audit_tenant_at_idx ON tool_audit (tenant_id, at);
