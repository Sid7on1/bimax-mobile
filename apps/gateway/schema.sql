-- schema.sql: bimax_gateway D1 Schema
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  usage_missing INTEGER NOT NULL DEFAULT 0,
  request_id TEXT UNIQUE,
  cost_microusd INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_usage_user_created ON usage(user_id, created_at);

CREATE TABLE IF NOT EXISTS quotas (
  user_id TEXT PRIMARY KEY,
  monthly_tokens INTEGER NOT NULL
);

-- Every provider request requires an explicit, expiring entitlement.
CREATE TABLE IF NOT EXISTS entitlements (
  user_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('active','suspended')),
  expires_at TEXT NOT NULL,
  monthly_microusd INTEGER NOT NULL CHECK(monthly_microusd >= 0)
);
CREATE TABLE IF NOT EXISTS rate_limits (
  user_id TEXT NOT NULL, bucket TEXT NOT NULL, count INTEGER NOT NULL,
  PRIMARY KEY(user_id,bucket)
);
CREATE TABLE IF NOT EXISTS reservations (
  request_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, month TEXT NOT NULL,
  model TEXT NOT NULL, tokens INTEGER NOT NULL, microusd INTEGER NOT NULL,
  input_price INTEGER NOT NULL, output_price INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','settled')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reservations_user_month ON reservations(user_id,month,status);
CREATE INDEX IF NOT EXISTS idx_reservations_status_created ON reservations(status,created_at);
CREATE TABLE IF NOT EXISTS relay_rooms (room_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z');
CREATE TABLE IF NOT EXISTS relay_devices(room_id TEXT NOT NULL,device_id TEXT NOT NULL,hello_pubkey TEXT NOT NULL,renewal_id TEXT,PRIMARY KEY(room_id,device_id));
CREATE TABLE IF NOT EXISTS budget_totals (
  user_id TEXT NOT NULL, month TEXT NOT NULL, tokens INTEGER NOT NULL DEFAULT 0,
  microusd INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id,month)
);
CREATE TRIGGER IF NOT EXISTS reservation_budget_insert AFTER INSERT ON reservations BEGIN
  INSERT INTO budget_totals VALUES (NEW.user_id,NEW.month,NEW.tokens,NEW.microusd)
    ON CONFLICT(user_id,month) DO UPDATE SET tokens=tokens+NEW.tokens,microusd=microusd+NEW.microusd;
  INSERT INTO budget_totals VALUES ('*',NEW.month,NEW.tokens,NEW.microusd)
    ON CONFLICT(user_id,month) DO UPDATE SET tokens=tokens+NEW.tokens,microusd=microusd+NEW.microusd;
END;
CREATE TRIGGER IF NOT EXISTS usage_budget_insert AFTER INSERT ON usage BEGIN
  INSERT INTO budget_totals VALUES (NEW.user_id,substr(NEW.created_at,1,7)||'-01T00:00:00.000Z',NEW.prompt_tokens+NEW.completion_tokens,NEW.cost_microusd)
    ON CONFLICT(user_id,month) DO UPDATE SET tokens=tokens+NEW.prompt_tokens+NEW.completion_tokens,microusd=microusd+NEW.cost_microusd;
  INSERT INTO budget_totals VALUES ('*',substr(NEW.created_at,1,7)||'-01T00:00:00.000Z',NEW.prompt_tokens+NEW.completion_tokens,NEW.cost_microusd)
    ON CONFLICT(user_id,month) DO UPDATE SET tokens=tokens+NEW.prompt_tokens+NEW.completion_tokens,microusd=microusd+NEW.cost_microusd;
END;
CREATE TRIGGER IF NOT EXISTS reservation_budget_settle AFTER UPDATE OF status ON reservations
WHEN OLD.status='pending' AND NEW.status='settled' BEGIN
  UPDATE budget_totals SET tokens=tokens-OLD.tokens,microusd=microusd-OLD.microusd
    WHERE month=OLD.month AND user_id IN (OLD.user_id,'*');
END;
CREATE TABLE IF NOT EXISTS billing_control(id INTEGER PRIMARY KEY CHECK(id=1),paused INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO billing_control(id,paused) VALUES(1,0);
CREATE INDEX IF NOT EXISTS idx_rate_bucket ON rate_limits(bucket);

CREATE TRIGGER IF NOT EXISTS usage_budget_reconcile AFTER UPDATE OF prompt_tokens,completion_tokens,cost_microusd ON usage BEGIN
  UPDATE budget_totals SET tokens=tokens+NEW.prompt_tokens+NEW.completion_tokens-OLD.prompt_tokens-OLD.completion_tokens,
    microusd=microusd+NEW.cost_microusd-OLD.cost_microusd
    WHERE month=substr(OLD.created_at,1,7)||'-01T00:00:00.000Z' AND user_id IN(OLD.user_id,'*');
END;

-- A reconciliation and its audit record commit together in one INSERT transaction.
CREATE TABLE IF NOT EXISTS billing_reconciliations (
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
CREATE TRIGGER IF NOT EXISTS billing_reconciliation_guard BEFORE INSERT ON billing_reconciliations BEGIN
  SELECT RAISE(ABORT,'Usage is not an unsettled estimate') WHERE NOT EXISTS (
    SELECT 1 FROM usage u JOIN reservations r ON r.request_id=u.request_id
    WHERE u.request_id=NEW.request_id AND u.usage_missing=1 AND r.status='settled'
      AND u.prompt_tokens=NEW.old_prompt_tokens
      AND u.completion_tokens=NEW.old_completion_tokens
      AND u.cost_microusd=NEW.old_cost_microusd
  );
END;
CREATE TRIGGER IF NOT EXISTS billing_reconciliation_apply AFTER INSERT ON billing_reconciliations BEGIN
  UPDATE usage SET prompt_tokens=NEW.prompt_tokens, completion_tokens=NEW.completion_tokens,
    cost_microusd=NEW.cost_microusd, usage_missing=0 WHERE request_id=NEW.request_id;
END;
CREATE TRIGGER IF NOT EXISTS billing_reconciliation_no_update BEFORE UPDATE ON billing_reconciliations BEGIN
  SELECT RAISE(ABORT,'Reconciliation audit records are immutable');
END;
CREATE TRIGGER IF NOT EXISTS billing_reconciliation_no_delete BEFORE DELETE ON billing_reconciliations BEGIN
  SELECT RAISE(ABORT,'Reconciliation audit records are immutable');
END;
