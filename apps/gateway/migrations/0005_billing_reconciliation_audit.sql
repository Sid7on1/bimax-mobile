-- A reconciliation and its audit record commit together in one INSERT transaction.
CREATE TABLE billing_reconciliations (
  request_id TEXT PRIMARY KEY REFERENCES reservations(request_id),
  provider_request_id TEXT NOT NULL,
  operator TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64),
  verified_at TEXT NOT NULL,
  old_prompt_tokens INTEGER NOT NULL,
  old_completion_tokens INTEGER NOT NULL,
  old_cost_microusd INTEGER NOT NULL,
  prompt_tokens INTEGER NOT NULL CHECK(prompt_tokens>=0),
  completion_tokens INTEGER NOT NULL CHECK(completion_tokens>=0),
  cost_microusd INTEGER NOT NULL CHECK(cost_microusd>=0)
);
CREATE TRIGGER billing_reconciliation_guard BEFORE INSERT ON billing_reconciliations BEGIN
  SELECT RAISE(ABORT,'Usage is not an unsettled estimate') WHERE NOT EXISTS (
    SELECT 1 FROM usage u JOIN reservations r ON r.request_id=u.request_id
    WHERE u.request_id=NEW.request_id AND u.usage_missing=1 AND r.status='settled'
      AND u.prompt_tokens=NEW.old_prompt_tokens
      AND u.completion_tokens=NEW.old_completion_tokens
      AND u.cost_microusd=NEW.old_cost_microusd
  );
END;
CREATE TRIGGER billing_reconciliation_apply AFTER INSERT ON billing_reconciliations BEGIN
  UPDATE usage SET prompt_tokens=NEW.prompt_tokens, completion_tokens=NEW.completion_tokens,
    cost_microusd=NEW.cost_microusd, usage_missing=0 WHERE request_id=NEW.request_id;
END;
CREATE TRIGGER billing_reconciliation_no_update BEFORE UPDATE ON billing_reconciliations BEGIN
  SELECT RAISE(ABORT,'Reconciliation audit records are immutable');
END;
CREATE TRIGGER billing_reconciliation_no_delete BEFORE DELETE ON billing_reconciliations BEGIN
  SELECT RAISE(ABORT,'Reconciliation audit records are immutable');
END;
