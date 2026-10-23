import { withStorageKey, encryptStored, decryptStored } from "./storage-crypto";
import { requireActiveAccount } from "./account-scope";
// lib/chat-store.ts
import * as SQLite from "expo-sqlite";

export interface Conversation {
  id: string;
  title: string;
  model: string;
  created_at: number;
  updated_at: number;
}

export interface ChatMessageRow {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  reasoning?: string | null;
  created_at: number;
}

const databases = new Map<string, Promise<SQLite.SQLiteDatabase>>();

async function sealDatabase(db: SQLite.SQLiteDatabase, owner: string): Promise<void> {
  await db.execAsync("PRAGMA secure_delete=ON; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;");
  const version = await db.getFirstAsync<{ user_version: number }>("PRAGMA user_version");
  if ((version?.user_version ?? 0) >= 2) return;
  await withStorageKey(
    owner,
    async (key) => {
      await db.withTransactionAsync(async () => {
        for (const row of await db.getAllAsync<Conversation>("SELECT * FROM conversations"))
          await db.runAsync("UPDATE conversations SET title=? WHERE id=?", [
            encryptStored(key, row.title, `${owner}:title:${row.id}`),
            row.id,
          ]);
        for (const row of await db.getAllAsync<ChatMessageRow>("SELECT * FROM messages"))
          await db.runAsync("UPDATE messages SET content=?,reasoning=? WHERE id=?", [
            encryptStored(key, row.content, `${owner}:content:${row.id}`),
            row.reasoning == null
              ? null
              : encryptStored(key, row.reasoning, `${owner}:reasoning:${row.id}`),
            row.id,
          ]);
        await db.execAsync("PRAGMA user_version=2");
      });
    },
    true,
  );
  await db.execAsync("PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);");
}

/** Preserve unowned history in encrypted form without assigning it to a signed-in account. */
export async function sealLegacyHistory(): Promise<void> {
  const db = await SQLite.openDatabaseAsync("bimax_chat.db");
  try {
    const tables = await db.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('messages','conversations')",
    );
    if (tables.length === 2) await sealDatabase(db, "legacy-unowned");
  } finally {
    await db.closeAsync();
  }
}

async function getDB(owner: string): Promise<SQLite.SQLiteDatabase> {
  let pending = databases.get(owner);
  if (!pending) {
    pending = (async () => {
      const db = await SQLite.openDatabaseAsync(`bimax_chat_${owner}.db`);
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY NOT NULL,title TEXT NOT NULL,model TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY NOT NULL,conversation_id TEXT NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,reasoning TEXT,created_at INTEGER NOT NULL,
          FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE);
        CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id,created_at);
      `);
      await sealDatabase(db, owner);
      return db;
    })();
    databases.set(owner, pending);
    void pending.catch(() => databases.delete(owner));
  }
  return pending;
}
async function usingDB<T>(
  fn: (db: SQLite.SQLiteDatabase, owner: string, key: Uint8Array) => Promise<T>,
): Promise<T> {
  const owner = requireActiveAccount();
  const db = await getDB(owner);
  return withStorageKey(owner, (key) => fn(db, owner, key));
}
function conversation(row: Conversation, owner: string, key: Uint8Array): Conversation {
  return { ...row, title: decryptStored(key, row.title, `${owner}:title:${row.id}`) };
}
export async function listConversations(): Promise<Conversation[]> {
  return usingDB(async (db, owner, key) =>
    (
      await db.getAllAsync<Conversation>(
        "SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 200",
      )
    ).map((row) => conversation(row, owner, key)),
  );
}
export async function getConversation(id: string): Promise<Conversation | null> {
  return usingDB(async (db, owner, key) => {
    const row = await db.getFirstAsync<Conversation>("SELECT * FROM conversations WHERE id=?", [
      id,
    ]);
    return row ? conversation(row, owner, key) : null;
  });
}
export async function createConversation(
  id: string,
  title: string,
  model: string,
): Promise<Conversation> {
  return usingDB(async (db, owner, key) => {
    const now = Date.now();
    await db.runAsync("INSERT INTO conversations VALUES (?,?,?,?,?)", [
      id,
      encryptStored(key, title, `${owner}:title:${id}`),
      model,
      now,
      now,
    ]);
    return { id, title, model, created_at: now, updated_at: now };
  });
}
export async function updateConversation(id: string, title: string, model?: string): Promise<void> {
  return usingDB(async (db, owner, key) => {
    await db.runAsync(
      "UPDATE conversations SET title=?,model=COALESCE(?,model),updated_at=? WHERE id=?",
      [encryptStored(key, title, `${owner}:title:${id}`), model ?? null, Date.now(), id],
    );
  });
}
export async function deleteConversation(id: string): Promise<void> {
  return usingDB(async (db) => {
    await db.runAsync("DELETE FROM conversations WHERE id=?", [id]);
  });
}
export async function listMessages(id: string): Promise<ChatMessageRow[]> {
  return usingDB(async (db, owner, key) =>
    (
      await db.getAllAsync<ChatMessageRow>(
        "SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at ASC LIMIT 1000",
        [id],
      )
    ).map((row) => ({
      ...row,
      content: decryptStored(key, row.content, `${owner}:content:${row.id}`),
      reasoning:
        row.reasoning == null
          ? null
          : decryptStored(key, row.reasoning, `${owner}:reasoning:${row.id}`),
    })),
  );
}
export async function addMessage(msg: ChatMessageRow): Promise<void> {
  return usingDB(async (db, owner, key) => {
    await db.runAsync("INSERT INTO messages VALUES (?,?,?,?,?,?)", [
      msg.id,
      msg.conversation_id,
      msg.role,
      encryptStored(key, msg.content, `${owner}:content:${msg.id}`),
      msg.reasoning == null
        ? null
        : encryptStored(key, msg.reasoning, `${owner}:reasoning:${msg.id}`),
      msg.created_at,
    ]);
    await db.runAsync("UPDATE conversations SET updated_at=? WHERE id=?", [
      Date.now(),
      msg.conversation_id,
    ]);
  });
}
export async function updateMessageContent(
  id: string,
  content: string,
  reasoning?: string | null,
): Promise<void> {
  return usingDB(async (db, owner, key) => {
    await db.runAsync("UPDATE messages SET content=?,reasoning=? WHERE id=?", [
      encryptStored(key, content, `${owner}:content:${id}`),
      reasoning == null ? null : encryptStored(key, reasoning, `${owner}:reasoning:${id}`),
      id,
    ]);
  });
}
