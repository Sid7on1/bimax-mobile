ALTER TABLE usage ADD COLUMN request_id TEXT;
ALTER TABLE usage ADD COLUMN cost_microusd INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_request ON usage(request_id);
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
CREATE TABLE IF NOT EXISTS relay_rooms (room_id TEXT PRIMARY KEY,user_id TEXT NOT NULL);
