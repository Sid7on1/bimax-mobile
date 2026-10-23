import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

// Local operator command. Stop the LAN relay first; never expose this through the network.
const [filename, deviceId] = process.argv.slice(2);
if (!filename || !deviceId || !/^[A-Za-z0-9_-]{1,128}$/.test(deviceId))
  throw new Error("Usage: node scripts/reset-lan-device.mjs <relay.db> <device-id>");
const source = path.resolve(filename);
if (!fs.existsSync(source)) throw new Error("Relay database does not exist");
const db = new Database(source, { fileMustExist: true });
try {
  const backup = source + `.before-reset-${Date.now()}`;
  await db.backup(backup);
  fs.chmodSync(backup, 0o600);
  db.transaction(() => {
    for (const table of ["pins", "devices", "hello_replays"])
      db.prepare(`DELETE FROM ${table} WHERE device_id=?`).run(deviceId);
    db.prepare("DELETE FROM outbox_v3 WHERE from_device=? OR to_device=?").run(deviceId, deviceId);
  })();
  console.log(`Removed local relay registration for ${deviceId}; backup: ${backup}`);
} finally {
  db.close();
}
