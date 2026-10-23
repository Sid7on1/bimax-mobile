ALTER TABLE relay_rooms ADD COLUMN updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';
CREATE INDEX idx_reservations_status_created ON reservations(status,created_at);
CREATE TABLE relay_devices (
  room_id TEXT NOT NULL, device_id TEXT NOT NULL, hello_pubkey TEXT NOT NULL,
  PRIMARY KEY(room_id,device_id)
);
CREATE TRIGGER usage_budget_reconcile AFTER UPDATE OF prompt_tokens,completion_tokens,cost_microusd ON usage BEGIN
  UPDATE budget_totals SET tokens=tokens+NEW.prompt_tokens+NEW.completion_tokens-OLD.prompt_tokens-OLD.completion_tokens,
    microusd=microusd+NEW.cost_microusd-OLD.cost_microusd
    WHERE month=substr(OLD.created_at,1,7)||'-01T00:00:00.000Z' AND user_id IN(OLD.user_id,'*');
END;
