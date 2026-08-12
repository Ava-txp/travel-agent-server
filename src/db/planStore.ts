import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ConversationOwner } from "./chatStore.js";

export type PlanOwner = ConversationOwner;

export interface PlanRow {
  id: string;
  client_id: string;
  user_id: string | null;
  city: string;
  days: number;
  total_budget: number;
  content: string;
  created_at: number;
  updated_at: number;
}

export interface PlanSummary {
  id: string;
  city: string;
  days: number;
  totalBudget: number;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface PlanDetail extends PlanSummary {
  plan: Record<string, unknown>;
}

const dataDir = path.resolve(process.cwd(), "data");
const dbPath = path.join(dataDir, "plans.db");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS travel_plans (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    user_id TEXT,
    city TEXT NOT NULL,
    days INTEGER NOT NULL,
    total_budget INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_plans_client_updated
    ON travel_plans(client_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_plans_user_updated
    ON travel_plans(user_id, updated_at DESC);
`);

const now = () => Date.now();

const ownerWhere = (owner: PlanOwner): { sql: string; params: string[] } => {
  if (owner.userId) {
    return { sql: `user_id = ?`, params: [owner.userId] };
  }
  return {
    sql: `client_id = ? AND (user_id IS NULL OR user_id = '')`,
    params: [owner.clientId],
  };
};

const buildTitle = (city: string, days: number) =>
  `${city.trim() || "旅行"}行程规划 · ${days}天`;

const parsePlanContent = (raw: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return {};
};

const toSummary = (row: PlanRow): PlanSummary => ({
  id: row.id,
  city: row.city,
  days: row.days,
  totalBudget: row.total_budget,
  title: buildTitle(row.city, row.days),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const createPlan = (
  owner: PlanOwner,
  input: {
    city: string;
    days: number;
    totalBudget: number;
    content: unknown;
  },
): PlanSummary => {
  const id = randomUUID();
  const ts = now();
  const userId = owner.userId ?? null;
  const city = String(input.city || "").trim() || "未知城市";
  const days = Number(input.days) || 1;
  const totalBudget = Number(input.totalBudget) || 0;
  const content = JSON.stringify(input.content ?? {});

  db.prepare(
    `INSERT INTO travel_plans
      (id, client_id, user_id, city, days, total_budget, content, created_at, updated_at)
     VALUES (:id, :clientId, :userId, :city, :days, :totalBudget, :content, :createdAt, :updatedAt)`,
  ).run({
    id,
    clientId: owner.clientId,
    userId,
    city,
    days,
    totalBudget,
    content,
    createdAt: ts,
    updatedAt: ts,
  });

  return {
    id,
    city,
    days,
    totalBudget,
    title: buildTitle(city, days),
    createdAt: ts,
    updatedAt: ts,
  };
};

export const getPlan = (id: string, owner: PlanOwner): PlanRow | null => {
  const { sql, params } = ownerWhere(owner);
  const row = db
    .prepare(
      `SELECT id, client_id, user_id, city, days, total_budget, content, created_at, updated_at
       FROM travel_plans
       WHERE id = ? AND ${sql}`,
    )
    .get(id, ...params) as PlanRow | undefined;

  return row ?? null;
};

export const getPlanDetail = (
  id: string,
  owner: PlanOwner,
): PlanDetail | null => {
  const row = getPlan(id, owner);
  if (!row) return null;

  return {
    ...toSummary(row),
    plan: parsePlanContent(row.content),
  };
};

export const listPlans = (owner: PlanOwner): PlanSummary[] => {
  const { sql, params } = ownerWhere(owner);
  const rows = db
    .prepare(
      `SELECT id, client_id, user_id, city, days, total_budget, content, created_at, updated_at
       FROM travel_plans
       WHERE ${sql}
       ORDER BY updated_at DESC`,
    )
    .all(...params) as PlanRow[];

  return rows.map(toSummary);
};

export const deletePlan = (id: string, owner: PlanOwner): boolean => {
  const { sql, params } = ownerWhere(owner);
  const result = db
    .prepare(`DELETE FROM travel_plans WHERE id = ? AND ${sql}`)
    .run(id, ...params);
  return result.changes > 0;
};

/** 将当前设备匿名规划合并到登录用户 */
export const mergeAnonymousPlans = (
  userId: string,
  clientId: string,
): number => {
  const result = db
    .prepare(
      `UPDATE travel_plans
       SET user_id = :userId
       WHERE client_id = :clientId
         AND (user_id IS NULL OR user_id = '')`,
    )
    .run({ userId, clientId });
  return result.changes;
};
