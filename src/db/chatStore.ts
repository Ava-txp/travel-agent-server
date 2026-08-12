import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ChatAttachment } from "./uploadStore.js";

export type ChatRole = "user" | "assistant";

export type ChatSceneHint = "spot_sign" | "ticket_itinerary" | "food_menu";

/** 会话归属：登录用户优先 userId，否则匿名 clientId */
export type ConversationOwner = {
  clientId: string;
  userId?: string | null;
};

export interface ConversationRow {
  id: string;
  client_id: string;
  user_id: string | null;
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
  attachments?: ChatAttachment[];
  sceneHint?: ChatSceneHint;
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
    attachments?: ChatAttachment[];
    sceneHint?: ChatSceneHint;
  }[];
}

export type AddMessageOptions = {
  attachments?: ChatAttachment[];
  sceneHint?: ChatSceneHint;
};

const MAX_HISTORY_MESSAGES = 20;
const TITLE_MAX_LEN = 20;

const dataDir = path.resolve(process.cwd(), "data");
const dbPath = path.join(dataDir, "chat.db");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
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

const conversationColumns = db
  .prepare(`PRAGMA table_info(conversations)`)
  .all() as { name: string }[];

if (!conversationColumns.some((col) => col.name === "pinned")) {
  db.exec(
    `ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`,
  );
}

if (!conversationColumns.some((col) => col.name === "user_id")) {
  db.exec(`ALTER TABLE conversations ADD COLUMN user_id TEXT`);
}

const messageColumns = db.prepare(`PRAGMA table_info(messages)`).all() as {
  name: string;
}[];

if (!messageColumns.some((col) => col.name === "attachments_json")) {
  db.exec(`ALTER TABLE messages ADD COLUMN attachments_json TEXT`);
}

if (!messageColumns.some((col) => col.name === "scene_hint")) {
  db.exec(`ALTER TABLE messages ADD COLUMN scene_hint TEXT`);
}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_conversations_client_pinned_updated
    ON conversations(client_id, pinned DESC, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_conversations_user_pinned_updated
    ON conversations(user_id, pinned DESC, updated_at DESC);
`);

const parseAttachmentsJson = (
  raw: string | null | undefined,
): ChatAttachment[] | undefined => {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
    return parsed as ChatAttachment[];
  } catch {
    return undefined;
  }
};

const parseSceneHint = (
  raw: string | null | undefined,
): ChatSceneHint | undefined => {
  if (
    raw === "spot_sign" ||
    raw === "ticket_itinerary" ||
    raw === "food_menu"
  ) {
    return raw;
  }
  return undefined;
};

const mapMessageRow = (row: {
  id: string;
  conversation_id: string;
  role: ChatRole;
  content: string;
  created_at: number;
  attachments_json?: string | null;
  scene_hint?: string | null;
}): MessageRow => {
  const attachments = parseAttachmentsJson(row.attachments_json);
  const sceneHint = parseSceneHint(row.scene_hint);
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    role: row.role,
    content: row.content,
    created_at: row.created_at,
    ...(attachments ? { attachments } : {}),
    ...(sceneHint ? { sceneHint } : {}),
  };
};

const now = () => Date.now();

const ownerWhere = (
  owner: ConversationOwner,
): { sql: string; params: string[] } => {
  if (owner.userId) {
    return { sql: `user_id = ?`, params: [owner.userId] };
  }
  return {
    sql: `client_id = ? AND (user_id IS NULL OR user_id = '')`,
    params: [owner.clientId],
  };
};

export const truncateTitle = (text: string, maxLen = TITLE_MAX_LEN): string => {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) return "新对话";
  return normalized.length > maxLen
    ? `${normalized.slice(0, maxLen)}…`
    : normalized;
};

export const createConversation = (
  owner: ConversationOwner | string,
  title = "新对话",
): ConversationRow => {
  const normalized: ConversationOwner =
    typeof owner === "string" ? { clientId: owner } : owner;

  const id = randomUUID();
  const ts = now();
  const userId = normalized.userId ?? null;

  db.prepare(
    `INSERT INTO conversations (id, client_id, user_id, title, pinned, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
  ).run(id, normalized.clientId, userId, title, ts, ts);

  return {
    id,
    client_id: normalized.clientId,
    user_id: userId,
    title,
    pinned: 0,
    created_at: ts,
    updated_at: ts,
  };
};

export const getConversation = (
  id: string,
  owner: ConversationOwner | string,
): ConversationRow | null => {
  const normalized: ConversationOwner =
    typeof owner === "string" ? { clientId: owner } : owner;
  const { sql, params } = ownerWhere(normalized);

  const row = db
    .prepare(
      `SELECT id, client_id, user_id, title, pinned, created_at, updated_at
       FROM conversations
       WHERE id = ? AND ${sql}`,
    )
    .get(id, ...params) as ConversationRow | undefined;

  return row ?? null;
};

export const listConversations = (
  owner: ConversationOwner | string,
): ConversationSummary[] => {
  const normalized: ConversationOwner =
    typeof owner === "string" ? { clientId: owner } : owner;
  const { sql, params } = ownerWhere(normalized);

  const rows = db
    .prepare(
      `SELECT
         c.id,
         c.title,
         c.pinned,
         c.updated_at AS updatedAt,
         COALESCE(
           (
             SELECT CASE
               WHEN TRIM(m.content) != '' THEN m.content
               WHEN m.attachments_json IS NOT NULL AND m.attachments_json != '' AND m.attachments_json != '[]'
                 THEN '[图片]'
               ELSE ''
             END
             FROM messages m
             WHERE m.conversation_id = c.id
             ORDER BY m.created_at DESC
             LIMIT 1
           ),
           ''
         ) AS preview
       FROM conversations c
       WHERE ${sql}
       ORDER BY c.pinned DESC, c.updated_at DESC`,
    )
    .all(...params) as {
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
  owner: ConversationOwner | string,
  title: string,
): ConversationRow | null => {
  const normalized: ConversationOwner =
    typeof owner === "string" ? { clientId: owner } : owner;
  const { sql, params } = ownerWhere(normalized);

  const cleaned = title.trim().replace(/\s+/g, " ");
  if (!cleaned) return null;

  const truncated = truncateTitle(cleaned, 40);
  const result = db
    .prepare(
      `UPDATE conversations
       SET title = ?
       WHERE id = ? AND ${sql}`,
    )
    .run(truncated, id, ...params);

  if (result.changes === 0) return null;
  return getConversation(id, normalized);
};

export const setConversationPinned = (
  id: string,
  owner: ConversationOwner | string,
  pinned: boolean,
): ConversationRow | null => {
  const normalized: ConversationOwner =
    typeof owner === "string" ? { clientId: owner } : owner;
  const { sql, params } = ownerWhere(normalized);

  const result = db
    .prepare(
      `UPDATE conversations
       SET pinned = ?
       WHERE id = ? AND ${sql}`,
    )
    .run(pinned ? 1 : 0, id, ...params);

  if (result.changes === 0) return null;
  return getConversation(id, normalized);
};

export const deleteConversation = (
  id: string,
  owner: ConversationOwner | string,
): boolean => {
  const normalized: ConversationOwner =
    typeof owner === "string" ? { clientId: owner } : owner;
  const { sql, params } = ownerWhere(normalized);

  const result = db
    .prepare(`DELETE FROM conversations WHERE id = ? AND ${sql}`)
    .run(id, ...params);
  return result.changes > 0;
};

export const addMessage = (
  conversationId: string,
  role: ChatRole,
  content: string,
  options?: AddMessageOptions,
): MessageRow => {
  const id = randomUUID();
  const ts = now();
  const attachments = options?.attachments?.length
    ? options.attachments
    : undefined;
  const sceneHint = options?.sceneHint;
  const attachmentsJson = attachments ? JSON.stringify(attachments) : null;

  db.prepare(
    `INSERT INTO messages
      (id, conversation_id, role, content, created_at, attachments_json, scene_hint)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    conversationId,
    role,
    content,
    ts,
    attachmentsJson,
    sceneHint ?? null,
  );

  return {
    id,
    conversation_id: conversationId,
    role,
    content,
    created_at: ts,
    ...(attachments ? { attachments } : {}),
    ...(sceneHint ? { sceneHint } : {}),
  };
};

export const listMessages = (conversationId: string): MessageRow[] => {
  const rows = db
    .prepare(
      `SELECT id, conversation_id, role, content, created_at, attachments_json, scene_hint
       FROM messages
       WHERE conversation_id = ?
       ORDER BY created_at ASC`,
    )
    .all(conversationId) as Array<{
    id: string;
    conversation_id: string;
    role: ChatRole;
    content: string;
    created_at: number;
    attachments_json?: string | null;
    scene_hint?: string | null;
  }>;

  return rows.map(mapMessageRow);
};

export const listRecentMessages = (
  conversationId: string,
  limit = MAX_HISTORY_MESSAGES,
): MessageRow[] => {
  const rows = db
    .prepare(
      `SELECT id, conversation_id, role, content, created_at, attachments_json, scene_hint
       FROM messages
       WHERE conversation_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(conversationId, limit) as Array<{
    id: string;
    conversation_id: string;
    role: ChatRole;
    content: string;
    created_at: number;
    attachments_json?: string | null;
    scene_hint?: string | null;
  }>;

  return rows.reverse().map(mapMessageRow);
};

export const touchConversation = (
  id: string,
  owner: ConversationOwner | string,
  title?: string,
): void => {
  const normalized: ConversationOwner =
    typeof owner === "string" ? { clientId: owner } : owner;
  const { sql, params } = ownerWhere(normalized);
  const ts = now();

  if (title !== undefined) {
    db.prepare(
      `UPDATE conversations
       SET updated_at = ?, title = ?
       WHERE id = ? AND ${sql}`,
    ).run(ts, title, id, ...params);
    return;
  }

  db.prepare(
    `UPDATE conversations
     SET updated_at = ?
     WHERE id = ? AND ${sql}`,
  ).run(ts, id, ...params);
};

export const getConversationDetail = (
  id: string,
  owner: ConversationOwner | string,
): ConversationDetail | null => {
  const conversation = getConversation(id, owner);
  if (!conversation) return null;

  const messages = listMessages(id).map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    createdAt: m.created_at,
    ...(m.attachments?.length ? { attachments: m.attachments } : {}),
    ...(m.sceneHint ? { sceneHint: m.sceneHint } : {}),
  }));

  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.created_at,
    updatedAt: conversation.updated_at,
    messages,
  };
};

/** 将当前设备匿名会话合并到登录用户
 * =============== 正确使用方式 ===============
 * 通过run注入参数可以防止sql注入
 *
 * =============== 错误使用方式 ===============
 * exec(`UPDATE conversations SET user_id = '${userId}' WHERE client_id = '${clientId}'`);
 * 模板字符串可能会导致sql注入，eg.clientId = '; DROP TABLE conversations; --'
 *
 * =============== 注意事项 ===============
 * user_id IS NULL OR user_id = ''
 * 只合并「还没挂到正式用户」的会话，避免覆盖已经属于别人的记录。
 *
 * :clientId, :userId 是命名占位符，需要通过run注入对象形式的参数。
 * ? 位置占位符，需要通过run按顺序注入参数(平铺模式)。
 */
export const mergeAnonymousConversations = (
  userId: string,
  clientId: string,
): number => {
  const result = db
    .prepare(
      `UPDATE conversations
       SET user_id = :userId
       WHERE client_id = :clientId
         AND (user_id IS NULL OR user_id = '')`,
    )
    .run({ userId, clientId });
  return result.changes;
};

export const MAX_CHAT_HISTORY = MAX_HISTORY_MESSAGES;
