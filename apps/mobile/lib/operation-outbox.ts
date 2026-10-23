import { withStorageKey, encryptStored, decryptStored } from "./storage-crypto";
import * as SQLite from "expo-sqlite";
import { requireActiveAccount } from "./account-scope";
export interface PendingOperation {
  id: string;
  peer: string;
  kind: "command_request" | "kill_request" | "approval_decision" | "chat_message";
  body: unknown;
  expiresAt: number;
}
const databases = new Map<string, Promise<SQLite.SQLiteDatabase>>();
async function database(owner: string) {
  let pending = databases.get(owner);
  if (!pending) {
    pending = (async () => {
      const db = await SQLite.openDatabaseAsync(`bimax_outbox_${owner}.db`);
      await db.execAsync(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,peer TEXT NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,expires_at INTEGER NOT NULL)",
      );
      const version = await db.getFirstAsync<{ user_version: number }>("PRAGMA user_version");
      if ((version?.user_version ?? 0) < 2) {
        await withStorageKey(
          owner,
          async (key) => {
            await db.withTransactionAsync(async () => {
              for (const row of await db.getAllAsync<{
                id: string;
                body: string;
                peer: string;
                kind: string;
                expires_at: number;
              }>("SELECT * FROM operations"))
                await db.runAsync("UPDATE operations SET body=? WHERE id=?", [
                  encryptStored(
                    key,
                    row.body,
                    `${owner}:operation:${row.id}:${row.peer}:${row.kind}:${row.expires_at}`,
                  ),
                  row.id,
                ]);
              await db.execAsync("PRAGMA user_version=2");
            });
          },
          true,
        );
        await db.execAsync(
          "PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);",
        );
      }
      return db;
    })();
    databases.set(owner, pending);
    void pending.catch(() => databases.delete(owner));
  }
  return pending;
}
export async function enqueueOperation(operation: PendingOperation) {
  const owner = requireActiveAccount();
  const db = await database(owner);
  await db.runAsync("DELETE FROM operations WHERE expires_at < ?", [Date.now()]);
  await db.runAsync(
    "INSERT OR IGNORE INTO operations SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM operations)<100",
    [
      operation.id,
      operation.peer,
      operation.kind,
      await withStorageKey(owner, async (key) =>
        encryptStored(
          key,
          JSON.stringify(operation.body),
          `${owner}:operation:${operation.id}:${operation.peer}:${operation.kind}:${operation.expiresAt}`,
        ),
      ),
      operation.expiresAt,
    ],
  );
  if (!(await db.getFirstAsync("SELECT id FROM operations WHERE id=?", [operation.id])))
    throw new Error("Too many pending actions");
}
export async function pendingOperations(peer: string): Promise<PendingOperation[]> {
  const owner = requireActiveAccount();
  const db = await database(owner);
  await db.runAsync("DELETE FROM operations WHERE expires_at < ?", [Date.now()]);
  const rows = await db.getAllAsync<{
    id: string;
    peer: string;
    kind: PendingOperation["kind"];
    body: string;
    expires_at: number;
  }>("SELECT * FROM operations WHERE peer=? ORDER BY rowid", [peer]);
  return withStorageKey(owner, async (key) =>
    rows.map((row) => ({
      id: row.id,
      peer: row.peer,
      kind: row.kind,
      body: JSON.parse(
        decryptStored(
          key,
          row.body,
          `${owner}:operation:${row.id}:${row.peer}:${row.kind}:${row.expires_at}`,
        ),
      ),
      expiresAt: row.expires_at,
    })),
  );
}
export async function acknowledgeOperation(id: string) {
  const owner = requireActiveAccount();
  const db = await database(owner);
  await db.runAsync("DELETE FROM operations WHERE id=?", [id]);
}
