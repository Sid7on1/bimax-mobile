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

let dbInstance: SQLite.SQLiteDatabase | null = null;

async function getDB(): Promise<SQLite.SQLiteDatabase> {
  if (!dbInstance) {
    dbInstance = await SQLite.openDatabaseAsync("bimax_chat.db");
    await dbInstance.execAsync(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY NOT NULL,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        reasoning TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
    `);
  }
  return dbInstance;
}

export async function listConversations(): Promise<Conversation[]> {
  const db = await getDB();
  return db.getAllAsync<Conversation>(
    "SELECT * FROM conversations ORDER BY updated_at DESC"
  );
}

export async function getConversation(id: string): Promise<Conversation | null> {
  const db = await getDB();
  return db.getFirstAsync<Conversation>(
    "SELECT * FROM conversations WHERE id = ?",
    [id]
  );
}

export async function createConversation(
  id: string,
  title: string,
  model: string
): Promise<Conversation> {
  const db = await getDB();
  const now = Date.now();
  await db.runAsync(
    "INSERT INTO conversations (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    [id, title, model, now, now]
  );
  return { id, title, model, created_at: now, updated_at: now };
}

export async function updateConversation(
  id: string,
  title: string,
  model?: string
): Promise<void> {
  const db = await getDB();
  const now = Date.now();
  if (model) {
    await db.runAsync(
      "UPDATE conversations SET title = ?, model = ?, updated_at = ? WHERE id = ?",
      [title, model, now, id]
    );
  } else {
    await db.runAsync(
      "UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?",
      [title, now, id]
    );
  }
}

export async function deleteConversation(id: string): Promise<void> {
  const db = await getDB();
  await db.runAsync("DELETE FROM messages WHERE conversation_id = ?", [id]);
  await db.runAsync("DELETE FROM conversations WHERE id = ?", [id]);
}

export async function listMessages(conversationId: string): Promise<ChatMessageRow[]> {
  const db = await getDB();
  return db.getAllAsync<ChatMessageRow>(
    "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
    [conversationId]
  );
}

export async function addMessage(
  msg: ChatMessageRow
): Promise<void> {
  const db = await getDB();
  await db.runAsync(
    "INSERT INTO messages (id, conversation_id, role, content, reasoning, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [msg.id, msg.conversation_id, msg.role, msg.content, msg.reasoning ?? null, msg.created_at]
  );
  await db.runAsync(
    "UPDATE conversations SET updated_at = ? WHERE id = ?",
    [Date.now(), msg.conversation_id]
  );
}

export async function updateMessageContent(
  id: string,
  content: string,
  reasoning?: string | null
): Promise<void> {
  const db = await getDB();
  await db.runAsync(
    "UPDATE messages SET content = ?, reasoning = ? WHERE id = ?",
    [content, reasoning ?? null, id]
  );
}
