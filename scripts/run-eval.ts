/**
 * Travel Agent 简单评测：
 *   EVAL_DRY_TOOLS=1 npm run eval
 *
 * 默认开启 dryTools，避免依赖外网天气/地理 API。
 * 需要真实 LLM 配置（.env 中 MODEL_PROVIDER 等）。
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import travelService from "../src/service/travelService.js";
import { retrieveKnowledge } from "../src/rag/knowledgeBase.js";

type EvalCase = {
  id: string;
  query: string;
  expectTools?: string[];
  expectToolsAny?: string[];
  /** 允许仅靠 system RAG 注入作答，不强制工具调用 */
  acceptRagWithoutTools?: boolean;
  forbidTools?: string[];
  expectKeywordsAny?: string[];
  requireRag?: boolean;
};

type CaseResult = {
  id: string;
  pass: boolean;
  reasons: string[];
  toolTrace: string[];
  responsePreview: string;
};

const evalPath = path.resolve(process.cwd(), "evals/travel-agent.eval.json");
const cases = JSON.parse(fs.readFileSync(evalPath, "utf8")) as EvalCase[];

const dryTools = process.env.EVAL_DRY_TOOLS !== "0";
process.env.EVAL_DRY_TOOLS = dryTools ? "1" : "0";

const includesAny = (text: string, keywords: string[] = []): boolean => {
  if (keywords.length === 0) return true;
  return keywords.some((kw) => text.includes(kw));
};

const runCase = async (item: EvalCase): Promise<CaseResult> => {
  const reasons: string[] = [];
  let response = "";
  let toolTrace: string[] = [];

  const ragHits = retrieveKnowledge({ query: item.query, topK: 3 });
  const ragOk = ragHits.length > 0;
  if (item.requireRag && !ragOk) {
    reasons.push("RAG 检索无命中");
  }

  try {
    const result = await travelService.chat({
      message: item.query,
      history: [],
      dryTools,
      streamCallback: (chunk) => {
        response += chunk;
      },
    });

    toolTrace = result.toolTrace ?? [];
    if (!result.success) {
      reasons.push(
        `agent 失败: ${typeof result.message === "string" ? result.message : "unknown"}`,
      );
    }
    if (!response.trim() && result.response) {
      response = result.response;
    }
  } catch (error) {
    reasons.push(
      `异常: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (item.expectTools && item.expectTools.length > 0) {
    for (const toolName of item.expectTools) {
      if (!toolTrace.includes(toolName)) {
        reasons.push(`缺少工具调用: ${toolName}`);
      }
    }
  }

  if (item.expectToolsAny && item.expectToolsAny.length > 0) {
    const hitTool = item.expectToolsAny.some((name) =>
      toolTrace.includes(name),
    );
    if (!hitTool) {
      if (!(item.acceptRagWithoutTools && ragOk)) {
        reasons.push(`未调用期望工具之一: ${item.expectToolsAny.join("/")}`);
      }
    }
  }

  if (item.forbidTools && item.forbidTools.length > 0) {
    for (const toolName of item.forbidTools) {
      if (toolTrace.includes(toolName)) {
        reasons.push(`不应调用工具: ${toolName}`);
      }
    }
  }

  if (item.expectTools && item.expectTools.length === 0) {
    // 明确期望不调用工具时，仅检查 forbid；若 expectTools=[] 且无 forbid，则允许 0 次调用
    if (toolTrace.length > 0 && (!item.forbidTools || item.forbidTools.length === 0)) {
      // soft: 闲聊最好无工具；若模型多调本地检索不强行失败，除非 forbid
    }
  }

  if (!includesAny(response, item.expectKeywordsAny)) {
    reasons.push(
      `回答未命中关键词: ${(item.expectKeywordsAny ?? []).join("/")}`,
    );
  }

  if (!response.trim()) {
    reasons.push("回答为空");
  }

  return {
    id: item.id,
    pass: reasons.length === 0,
    reasons,
    toolTrace,
    responsePreview: response.replace(/\s+/g, " ").slice(0, 160),
  };
};

const main = async () => {
  console.log(`Running ${cases.length} eval cases (dryTools=${dryTools})...\n`);

  const results: CaseResult[] = [];
  for (const item of cases) {
    process.stdout.write(`- ${item.id} ... `);
    const result = await runCase(item);
    results.push(result);
    console.log(result.pass ? "PASS" : "FAIL");
    if (!result.pass) {
      for (const reason of result.reasons) {
        console.log(`    · ${reason}`);
      }
    }
    console.log(`    tools: [${result.toolTrace.join(", ")}]`);
    console.log(`    preview: ${result.responsePreview || "(empty)"}`);
  }

  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  const rate = total === 0 ? 0 : Math.round((passed / total) * 100);

  console.log("\n========== Summary ==========");
  console.log(`Passed: ${passed}/${total} (${rate}%)`);

  if (passed < total) {
    process.exitCode = 1;
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
