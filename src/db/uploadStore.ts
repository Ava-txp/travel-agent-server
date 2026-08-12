import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ConversationOwner } from "./chatStore.js";

export type UploadRecord = {
  id: string;
  client_id: string;
  user_id: string | null;
  filename: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  created_at: number;
};

export type ChatAttachment = {
  id: string;
  type: "image";
  url: string;
  mime: string;
  width?: number;
  height?: number;
};

const dataDir = path.resolve(process.cwd(), "data");
const uploadsDir = path.join(dataDir, "uploads");
const dbPath = path.join(dataDir, "chat.db");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS uploads (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    user_id TEXT,
    filename TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_uploads_client_created
    ON uploads(client_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_uploads_user_created
    ON uploads(user_id, created_at DESC);
`);

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

export const UPLOADS_DIR = uploadsDir;
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const ALLOWED_IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export const publicUploadUrl = (id: string): string =>
  `/api/travel/uploads/files/${id}`;

export const absoluteUploadPath = (filename: string): string =>
  path.join(uploadsDir, filename);

const ownerMatches = (
  row: UploadRecord,
  owner: ConversationOwner,
): boolean => {
  if (owner.userId) {
    return row.user_id === owner.userId;
  }
  return (
    row.client_id === owner.clientId &&
    (row.user_id === null || row.user_id === "")
  );
};

export const saveUpload = (params: {
  owner: ConversationOwner;
  buffer: Buffer;
  mime: string;
  width?: number;
  height?: number;
}): ChatAttachment => {
  const mime = params.mime.toLowerCase();
  if (!ALLOWED_IMAGE_MIMES.has(mime)) {
    throw new Error("Unsupported image type");
  }
  if (params.buffer.length > MAX_UPLOAD_BYTES) {
    throw new Error("Image too large");
  }

  const id = randomUUID();
  const ext = EXT_BY_MIME[mime] || ".jpg";
  const filename = `${id}${ext}`;
  const filePath = absoluteUploadPath(filename);
  fs.writeFileSync(filePath, params.buffer);

  const ts = Date.now();
  const userId = params.owner.userId ?? null;

  db.prepare(
    `INSERT INTO uploads
      (id, client_id, user_id, filename, mime, size, width, height, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    params.owner.clientId,
    userId,
    filename,
    mime,
    params.buffer.length,
    params.width ?? null,
    params.height ?? null,
    ts,
  );

  return {
    id,
    type: "image",
    url: publicUploadUrl(id),
    mime,
    ...(typeof params.width === "number" ? { width: params.width } : {}),
    ...(typeof params.height === "number" ? { height: params.height } : {}),
  };
};

export const getUploadById = (id: string): UploadRecord | null => {
  const row = db
    .prepare(
      `SELECT id, client_id, user_id, filename, mime, size, width, height, created_at
       FROM uploads
       WHERE id = ?`,
    )
    .get(id) as UploadRecord | undefined;
  return row ?? null;
};

export const getOwnedUpload = (
  id: string,
  owner: ConversationOwner,
): UploadRecord | null => {
  const row = getUploadById(id);
  if (!row) return null;
  if (!ownerMatches(row, owner)) return null;
  return row;
};

export const toChatAttachment = (row: UploadRecord): ChatAttachment => ({
  id: row.id,
  type: "image",
  url: publicUploadUrl(row.id),
  mime: row.mime,
  ...(typeof row.width === "number" ? { width: row.width } : {}),
  ...(typeof row.height === "number" ? { height: row.height } : {}),
});

/** 读本地文件为 data URL，供 Vision 模型使用 */
export const readUploadAsDataUrl = (row: UploadRecord): string => {
  const filePath = absoluteUploadPath(row.filename);
  const buf = fs.readFileSync(filePath);
  return `data:${row.mime};base64,${buf.toString("base64")}`;
};
