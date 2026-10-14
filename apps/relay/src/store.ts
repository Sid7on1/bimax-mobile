import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import type { Sql } from "./logic";

export interface DeviceRow {
  device_id: string;
  role: string;
  last_seen: number;
}

export class RelayStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const targetPath = dbPath || process.env.DB_PATH || path.resolve(__dirname, "../relay.db");
    const dir = path.dirname(path.resolve(targetPath));
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(targetPath);
    this.db.pragma("journal_mode = WAL");

    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY,
        to_device TEXT NOT NULL,
        envelope TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_outbox_to ON outbox(to_device, created_at);
      CREATE TABLE IF NOT EXISTS pins (
        device_id TEXT PRIMARY KEY,
        pubkey TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS devices (
        device_id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        last_seen INTEGER NOT NULL
      );
    `);
  }

  getSql(): Sql {
    const db = this.db;
    return {
      exec: (sql: string, ...params: unknown[]) => {
        const stmt = db.prepare(sql);
        if (stmt.reader) {
          return { rows: stmt.all(...params) as Record<string, unknown>[] };
        }
        stmt.run(...params);
        return { rows: [] };
      },
    };
  }

  recordDevice(deviceId: string, role: string, lastSeen: number): void {
    const stmt = this.db.prepare(`
      INSERT INTO devices (device_id, role, last_seen)
      VALUES (?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        role = excluded.role,
        last_seen = excluded.last_seen
    `);
    stmt.run(deviceId, role, lastSeen);
  }

  updateLastSeen(deviceId: string, lastSeen: number): void {
    const stmt = this.db.prepare(`
      UPDATE devices SET last_seen = ? WHERE device_id = ?
    `);
    stmt.run(lastSeen, deviceId);
  }

  getOtherDevices(excludeDeviceId: string): DeviceRow[] {
    const stmt = this.db.prepare(`
      SELECT device_id, role, last_seen FROM devices WHERE device_id != ?
    `);
    return stmt.all(excludeDeviceId) as DeviceRow[];
  }

  getAllDevices(): DeviceRow[] {
    const stmt = this.db.prepare(`
      SELECT device_id, role, last_seen FROM devices
    `);
    return stmt.all() as DeviceRow[];
  }

  close(): void {
    this.db.close();
  }
}
