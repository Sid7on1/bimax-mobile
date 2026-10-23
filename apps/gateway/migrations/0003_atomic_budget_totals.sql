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

-- Backfill pre-migration usage without pretending to know missing historical prices.
INSERT INTO budget_totals(user_id,month,tokens,microusd)
SELECT user_id,substr(created_at,1,7)||'-01T00:00:00.000Z',SUM(prompt_tokens+completion_tokens),SUM(cost_microusd) FROM usage GROUP BY user_id,substr(created_at,1,7)
ON CONFLICT(user_id,month) DO UPDATE SET tokens=excluded.tokens,microusd=excluded.microusd;
INSERT INTO budget_totals(user_id,month,tokens,microusd)
SELECT '*',substr(created_at,1,7)||'-01T00:00:00.000Z',SUM(prompt_tokens+completion_tokens),SUM(cost_microusd) FROM usage GROUP BY substr(created_at,1,7)
ON CONFLICT(user_id,month) DO UPDATE SET tokens=excluded.tokens,microusd=excluded.microusd;
INSERT INTO budget_totals(user_id,month,tokens,microusd)
SELECT user_id,month,SUM(tokens),SUM(microusd) FROM reservations WHERE status='pending' GROUP BY user_id,month
ON CONFLICT(user_id,month) DO UPDATE SET tokens=budget_totals.tokens+excluded.tokens,microusd=budget_totals.microusd+excluded.microusd;
INSERT INTO budget_totals(user_id,month,tokens,microusd)
SELECT '*',month,SUM(tokens),SUM(microusd) FROM reservations WHERE status='pending' GROUP BY month
ON CONFLICT(user_id,month) DO UPDATE SET tokens=budget_totals.tokens+excluded.tokens,microusd=budget_totals.microusd+excluded.microusd;
CREATE INDEX IF NOT EXISTS idx_rate_bucket ON rate_limits(bucket);
