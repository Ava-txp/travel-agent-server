import type { MessageContent } from "@langchain/core/messages";

/** 从模型原文中抽出 JSON 字符串（优先 ```json 围栏）。 */
export function extractJsonBlock(content: string): string | null {
  const fenced =
    content.match(/```json\s*([\s\S]*?)\s*```/) ||
    content.match(/```\s*([\s\S]*?)\s*```/);
  if (fenced?.[1]?.trim()) return fenced[1].trim();

  const raw = content.match(/\{[\s\S]*\}/);
  return raw?.[0] ?? null;
}

export function toTextContent(content: MessageContent): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if ("text" in part && typeof part.text === "string") return part.text;
      return "";
    })
    .join("");
}

export type ParsedPlan = {
  success?: boolean;
  message?: unknown;
  city?: string;
  days?: number;
  totalBudget?: number;
  [key: string]: unknown;
};

export function parsePlanJson(jsonText: string): ParsedPlan {
  const parsed = JSON.parse(jsonText) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid JSON content");
  }
  return parsed as ParsedPlan;
}
