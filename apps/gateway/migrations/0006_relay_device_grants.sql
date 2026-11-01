-- A paired Mac receives relay-only renewal authority; removal/recreation cannot revive old grants.
ALTER TABLE relay_devices ADD COLUMN renewal_id TEXT;
