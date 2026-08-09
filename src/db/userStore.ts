import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface UserRow {
  id: string;
  account: string;
  password_hash: string;
  nickname: string;
  created_at: number;
  updated_at: number;
}

export interface PublicUser {
  id: string;
  account: string;
  nickname: string;
  createdAt: number;
}

const dataDir = path.resolve(process.cwd(), "data");
const dbPath = path.join(dataDir, "chat.db");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    account TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    nickname TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_users_account ON users(account);
`);

const now = () => Date.now();

const toPublic = (row: UserRow): PublicUser => ({
  id: row.id,
  account: row.account,
  nickname: row.nickname,
  createdAt: row.created_at,
});

export const createUser = (
  account: string,
  passwordHash: string,
  nickname: string,
): PublicUser => {
  const id = randomUUID();
  const ts = now();
  db.prepare(
    `INSERT INTO users (id, account, password_hash, nickname, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, account, passwordHash, nickname, ts, ts);

  return {
    id,
    account,
    nickname,
    createdAt: ts,
  };
};

export const findUserByAccount = (account: string): UserRow | null => {
  const row = db
    .prepare(
      `SELECT id, account, password_hash, nickname, created_at, updated_at
       FROM users WHERE account = ?`,
    )
    .get(account) as UserRow | undefined;
  return row ?? null;
};

export const findUserById = (id: string): UserRow | null => {
  const row = db
    .prepare(
      `SELECT id, account, password_hash, nickname, created_at, updated_at
       FROM users WHERE id = ?`,
    )
    .get(id) as UserRow | undefined;
  return row ?? null;
};

export const getPublicUserById = (id: string): PublicUser | null => {
  const row = findUserById(id);
  return row ? toPublic(row) : null;
};
