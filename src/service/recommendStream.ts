import type { ChatOpenAI } from "@langchain/openai";
import * as planStore from "../db/planStore.js";
import type { PlanOwner } from "../db/planStore.js";
import {
  isAbortError,
  isRateLimitError,
  readRetryAfterSec,
} from "../utils/llmErrors.js";
import {
  extractJsonBlock,
  parsePlanJson,
  toTextContent,
  type ParsedPlan,
} from "../utils/planJson.js";
import { extractPlanPartial } from "../utils/planPartialParse.js";
import { getTravelPrompt } from "./recommendPrompt.js";

export type RecommendStreamEvent =
  | { type: "stage"; content: "generating" }
  | { type: "meta"; content: { city?: string; days?: number; totalBudget?: number } }
  | { type: "day"; content: unknown }
  | { type: "budget"; content: unknown }
  | { type: "done"; content: ParsedPlan }
  | { type: "error"; message: string; code?: string; retryAfter?: number };

export class RecommendStreamError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "RecommendStreamError";
  }
}

export type RecommendStreamParams = {
  city: string;
  budget: number;
  days: number;
  llm: ChatOpenAI;
  owner: PlanOwner | null;
  signal?: AbortSignal;
  onEvent: (event: RecommendStreamEvent) => void;
};

const persistPlan = (
  owner: PlanOwner | null,
  parsed: ParsedPlan,
  fallback: { city: string; budget: number; days: number },
): ParsedPlan => {
  if (!owner) return parsed;
  try {
    const saved = planStore.createPlan(owner, {
      city: String(parsed.city || fallback.city),
      days: Number(parsed.days) || fallback.days,
      totalBudget: Number(parsed.totalBudget) || fallback.budget,
      content: parsed,
    });
    return { ...parsed, id: saved.id };
  } catch (saveError) {
    console.error("保存规划记录失败", saveError);
    return parsed;
  }
};

export async function runRecommendStream(
  params: RecommendStreamParams,
): Promise<void> {
  const { city, budget, days, llm, owner, signal, onEvent } = params;

  if (days < 1 || days > 30) {
    throw new RecommendStreamError("旅行天数需在 1–30 天之间");
  }
  if (budget < 100) {
    throw new RecommendStreamError("预算需不少于 100 元");
  }

  const messages = getTravelPrompt(city, budget, days);
  let buffer = "";
  let sentMeta = false;
  let sentBudget = false;
  const emittedDays = new Set<number>();

  try {
    const stream = await llm.stream(messages, { signal });
    for await (const chunk of stream) {
      if (signal?.aborted) return;
      const text = toTextContent(chunk.content);
      if (!text) continue;
      buffer += text;

      const partial = extractPlanPartial(buffer);
      if (!sentMeta && partial.meta) {
        onEvent({ type: "meta", content: partial.meta });
        sentMeta = true;
      }
      for (const day of partial.days) {
        const n = Number(day.day);
        if (!emittedDays.has(n)) {
          emittedDays.add(n);
          onEvent({ type: "day", content: day });
        }
      }
      if (!sentBudget && partial.budget) {
        onEvent({ type: "budget", content: partial.budget });
        sentBudget = true;
      }
    }
  } catch (error) {
    if (isAbortError(error, signal)) return;
    if (isRateLimitError(error)) {
      throw new RecommendStreamError(
        "当前规划请求较多，请稍后再试",
        "RATE_LIMITED",
        readRetryAfterSec(error) ?? 12,
      );
    }
    throw error;
  }

  if (signal?.aborted) return;

  const jsonText = extractJsonBlock(buffer);
  if (!jsonText) {
    throw new RecommendStreamError("规划结果格式无效，请重试", "PARSE_FAILED");
  }

  let parsed: ParsedPlan;
  try {
    parsed = parsePlanJson(jsonText);
  } catch {
    throw new RecommendStreamError("规划结果格式无效，请重试", "PARSE_FAILED");
  }

  if (parsed.success === false) {
    throw new RecommendStreamError(
      typeof parsed.message === "string" ? parsed.message : "生成旅游规划失败",
      "PARSE_FAILED",
    );
  }

  onEvent({
    type: "done",
    content: persistPlan(owner, parsed, { city, budget, days }),
  });
}
