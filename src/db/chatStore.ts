import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type ChatRole = "user" | "assistant";

export interface ConversationRow {
  id: string;
  client_id: string;
  title: string;
  pinned: number;
  created_at: number;
  updated_at: number;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: ChatRole;
  content: string;
  created_at: number;
}

export interface ConversationSummary {
  id: string;
  title: string;
  pinned: boolean;
  updatedAt: number;
  preview: string;
}

export interface ConversationDetail {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: {
    id: string;
    role: ChatRole;
    content: string;
    createdAt: number;
  }[];
}

const MAX_HISTORY_MESSAGES = 20;
const TITLE_MAX_LEN = 20;

const dataDir = path.resolve(process.cwd(), "data");
const dbPath = path.join(dataDir, "chat.db");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// 打开（或创建）data/chat.db，得到数据库连接对象 db
const db = new Database(dbPath);
// Write-Ahead Logging: db-wal文件，尚未完全合并的改动流水
db.pragma("journal_mode = WAL");
// 外键约束  => ON表示级联删除，OFF表示禁止级联删除
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_conversations_client_updated
    ON conversations(client_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
    ON messages(conversation_id, created_at ASC);
`);

/** 兼容旧库：补充 pinned 列 */
const conversationColumns = db
  .prepare(`PRAGMA table_info(conversations)`)
  .all() as { name: string }[];
if (!conversationColumns.some((col) => col.name === "pinned")) {
  db.exec(
    `ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`,
  );
}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_conversations_client_pinned_updated
    ON conversations(client_id, pinned DESC, updated_at DESC);
`);

const now = () => Date.now();

export const truncateTitle = (text: string, maxLen = TITLE_MAX_LEN): string => {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) return "新对话";
  return normalized.length > maxLen
    ? `${normalized.slice(0, maxLen)}…`
    : normalized;
};

export const createConversation = (
  clientId: string,
  title = "新对话",
): ConversationRow => {
  const id = randomUUID();
  const ts = now();
  db.prepare(
    `INSERT INTO conversations (id, client_id, title, pinned, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?)`,
  ).run(id, clientId, title, ts, ts);

  return {
    id,
    client_id: clientId,
    title,
    pinned: 0,
    created_at: ts,
    updated_at: ts,
  };
};

export const getConversation = (
  id: string,
  clientId: string,
): ConversationRow | null => {
  const row = db
    .prepare(
      `SELECT id, client_id, title, pinned, created_at, updated_at
       FROM conversations
       WHERE id = ? AND client_id = ?`,
    )
    .get(id, clientId) as ConversationRow | undefined;

  return row ?? null;
};

export const listConversations = (clientId: string): ConversationSummary[] => {
  const rows = db
    .prepare(
      `SELECT
         c.id,
         c.title,
         c.pinned,
         c.updated_at AS updatedAt,
         COALESCE(
           (
             SELECT m.content
             FROM messages m
             WHERE m.conversation_id = c.id
             ORDER BY m.created_at DESC
             LIMIT 1
           ),
           ''
         ) AS preview
       FROM conversations c
       WHERE c.client_id = ?
       ORDER BY c.pinned DESC, c.updated_at DESC`,
    )
    .all(clientId) as {
    id: string;
    title: string;
    pinned: number;
    updatedAt: number;
    preview: string;
  }[];

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    pinned: row.pinned === 1,
    updatedAt: row.updatedAt,
    preview: row.preview,
  }));
};

export const renameConversation = (
  id: string,
  clientId: string,
  title: string,
): ConversationRow | null => {
  const normalized = title.trim().replace(/\s+/g, " ");
  if (!normalized) return null;

  const truncated = truncateTitle(normalized, 40);
  const result = db
    .prepare(
      `UPDATE conversations
       SET title = ?
       WHERE id = ? AND client_id = ?`,
    )
    .run(truncated, id, clientId);

  if (result.changes === 0) return null;
  return getConversation(id, clientId);
};

export const setConversationPinned = (
  id: string,
  clientId: string,
  pinned: boolean,
): ConversationRow | null => {
  const result = db
    .prepare(
      `UPDATE conversations
       SET pinned = ?
       WHERE id = ? AND client_id = ?`,
    )
    .run(pinned ? 1 : 0, id, clientId);

  if (result.changes === 0) return null;
  return getConversation(id, clientId);
};

export const deleteConversation = (id: string, clientId: string): boolean => {
  const result = db
    .prepare(`DELETE FROM conversations WHERE id = ? AND client_id = ?`)
    .run(id, clientId);
  return result.changes > 0;
};

export const addMessage = (
  conversationId: string,
  role: ChatRole,
  content: string,
): MessageRow => {
  const id = randomUUID();
  const ts = now();

  db.prepare(
    `INSERT INTO messages (id, conversation_id, role, content, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, conversationId, role, content, ts);

  return {
    id,
    conversation_id: conversationId,
    role,
    content,
    created_at: ts,
  };
};

export const listMessages = (conversationId: string): MessageRow[] => {
  return db
    .prepare(
      `SELECT id, conversation_id, role, content, created_at
       FROM messages
       WHERE conversation_id = ?
       ORDER BY created_at ASC`,
    )
    .all(conversationId) as MessageRow[];
};

/** 取最近 N 条消息，供 LLM 多轮上下文（按时间正序返回） */
export const listRecentMessages = (
  conversationId: string,
  limit = MAX_HISTORY_MESSAGES,
): MessageRow[] => {
  const rows = db
    .prepare(
      `SELECT id, conversation_id, role, content, created_at
       FROM messages
       WHERE conversation_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(conversationId, limit) as MessageRow[];

  return rows.reverse();
};

export const touchConversation = (
  id: string,
  clientId: string,
  title?: string,
): void => {
  const ts = now();
  if (title !== undefined) {
    db.prepare(
      `UPDATE conversations
       SET updated_at = ?, title = ?
       WHERE id = ? AND client_id = ?`,
    ).run(ts, title, id, clientId);
    return;
  }

  db.prepare(
    `UPDATE conversations
     SET updated_at = ?
     WHERE id = ? AND client_id = ?`,
  ).run(ts, id, clientId);
};

export const getConversationDetail = (
  id: string,
  clientId: string,
): ConversationDetail | null => {
  const conversation = getConversation(id, clientId);
  if (!conversation) return null;

  const messages = listMessages(id).map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    createdAt: m.created_at,
  }));

  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.created_at,
    updatedAt: conversation.updated_at,
    messages,
  };
};

export const MAX_CHAT_HISTORY = MAX_HISTORY_MESSAGES;
