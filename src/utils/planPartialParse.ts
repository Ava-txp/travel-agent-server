/** 从尚未闭合的规划 JSON 里抽出已完整的 meta / 天 / 预算，供 SSE 增量推送。 */

export type PlanMeta = {
  city?: string;
  days?: number;
  totalBudget?: number;
};

export type PlanPartial = {
  meta: PlanMeta | null;
  days: Array<Record<string, unknown>>;
  budget: Record<string, unknown> | null;
};

const findMatchingBrace = (source: string, start: number): number => {
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (char === "\\") {
        escape = true;
        continue;
      }
      if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
};

const isPeriod = (value: unknown): boolean => {
  if (!value || typeof value !== "object") return false;
  const spot = (value as { spot?: unknown }).spot;
  return typeof spot === "string" && spot.trim().length > 0;
};

const isCompleteDay = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== "object") return false;
  const day = value as Record<string, unknown>;
  return (
    Number.isFinite(Number(day.day)) &&
    isPeriod(day.morning) &&
    isPeriod(day.afternoon) &&
    isPeriod(day.evening)
  );
};

const extractCompleteObjectsAfterKey = (
  source: string,
  key: string,
  asArray: boolean,
): unknown[] => {
  const keyIdx = source.indexOf(`"${key}"`);
  if (keyIdx < 0) return [];
  const startChar = asArray ? "[" : "{";
  const open = source.indexOf(startChar, keyIdx);
  if (open < 0) return [];

  if (!asArray) {
    const close = findMatchingBrace(source, open);
    if (close < 0) return [];
    try {
      return [JSON.parse(source.slice(open, close + 1))];
    } catch {
      return [];
    }
  }

  const items: unknown[] = [];
  let i = open + 1;
  while (i < source.length) {
    while (i < source.length && (source[i] === "," || /\s/.test(source[i]))) {
      i += 1;
    }
    if (source[i] === "]") break;
    if (source[i] !== "{") break;
    const close = findMatchingBrace(source, i);
    if (close < 0) break;
    try {
      items.push(JSON.parse(source.slice(i, close + 1)));
    } catch {
      // 单日 JSON 不完整则停止，避免把半截对象推给前端
      break;
    }
    i = close + 1;
  }
  return items;
};

export function extractPlanPartial(buffer: string): PlanPartial {
  const city = buffer.match(/"city"\s*:\s*"([^"]+)"/);
  const days = buffer.match(/"days"\s*:\s*(\d+)/);
  const totalBudget = buffer.match(/"totalBudget"\s*:\s*(\d+)/);

  const meta: PlanMeta = {};
  if (city?.[1]) meta.city = city[1];
  if (days?.[1]) meta.days = Number(days[1]);
  if (totalBudget?.[1]) meta.totalBudget = Number(totalBudget[1]);

  const dayItems = extractCompleteObjectsAfterKey(
    buffer,
    "dailyItinerary",
    true,
  ).filter(isCompleteDay);

  const budgetItems = extractCompleteObjectsAfterKey(
    buffer,
    "budgetBreakdown",
    false,
  );
  const budget =
    budgetItems[0] && typeof budgetItems[0] === "object"
      ? (budgetItems[0] as Record<string, unknown>)
      : null;

  return {
    meta: meta.city || meta.days || meta.totalBudget ? meta : null,
    days: dayItems,
    budget,
  };
}
