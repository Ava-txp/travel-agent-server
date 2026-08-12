import type { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "langchain";
import type { MessageContent } from "@langchain/core/messages";
import type { ChatSceneHint } from "../db/chatStore.js";

export type ChatScene = ChatSceneHint | "unknown";

export type SpotSignExtract = {
  placeName?: string;
  placeType?: string;
  visibleText?: string;
  confidence: number;
};

export type TicketItineraryExtract = {
  kind: "ticket" | "itinerary" | "mixed" | "unknown";
  title?: string;
  spots: string[];
  startDate?: string;
  endDate?: string;
  visitTime?: string;
  ticketType?: string;
  price?: string;
  orderNo?: string;
  notes: string[];
  confidence: number;
};

export type FoodMenuItem = {
  name: string;
  price?: number;
  category?: string;
};

export type FoodMenuExtract = {
  items: FoodMenuItem[];
  avgPriceMin?: number;
  avgPriceMax?: number;
  confidence: number;
};

export type SceneExtract =
  | { scene: "spot_sign"; data: SpotSignExtract }
  | { scene: "ticket_itinerary"; data: TicketItineraryExtract }
  | { scene: "food_menu"; data: FoodMenuExtract }
  | { scene: "unknown"; data: null };

export type ScenePipelineResult = {
  scene: ChatScene;
  extract: SceneExtract;
  /** 注入 system / human 的结构化上下文 */
  contextBlock: string;
};

const SCENE_ANSWER_OUTLINE: Record<ChatSceneHint, string[]> = {
  spot_sign: [
    "这是哪里（名称 + 一句话）",
    "值不值得去（适合人群、耗时、费用量级、注意点）",
    "附近怎么玩（2–3 个邻近点 + 建议路线时长）",
    "置信度低时说明不确定，并请用户补充城市或景点名",
  ],
  ticket_itinerary: [
    "关键信息清单（日期、景点、时段、票种）",
    "注意事项摘要",
    "与用户计划冲突时提醒",
    "订单号等敏感字段脱敏（只留后 4 位）",
  ],
  food_menu: [
    "菜单解读（特色/必点/慎点）",
    "按预算的组合套餐（2–3 套，含估算总价）",
    "无预算时追问，并给高/中/低三档示例",
    "有定位时可补充相对价格判断（无数据则不做硬比价）",
  ],
};

/** 仅根据 sceneHint 生成回答大纲（不调用 Vision 抽取） */
export const buildSceneHintContext = (
  sceneHint?: ChatSceneHint | null,
): string | null => {
  if (!sceneHint) return null;
  const lines = SCENE_ANSWER_OUTLINE[sceneHint];
  if (!lines?.length) return null;
  return `## 场景提示（${sceneHint}）
请结合用户上传的图片回答，并尽量覆盖：
${lines.map((line, i) => `${i + 1}. ${line}`).join("\n")}`;
};

export const maskOrderNo = (orderNo: string): string => {
  const trimmed = orderNo.trim();
  if (trimmed.length <= 4) return "****";
  return `${"*".repeat(Math.min(trimmed.length - 4, 8))}${trimmed.slice(-4)}`;
};

export const parseBudgetFromText = (
  text: string,
): { total?: number; perPerson?: number } | null => {
  const content = text.trim();
  if (!content) return null;

  const perPerson = content.match(
    /人均\s*(?:大概|大约|约)?\s*(\d+(?:\.\d+)?)\s*(?:元|块)?/,
  );
  if (perPerson) return { perPerson: Number(perPerson[1]) };

  const twoPerson = content.match(
    /(?:两个人|两人|两位)\s*(?:一共|共|预算)?\s*(\d+(?:\.\d+)?)\s*(?:元|块)?/,
  );
  if (twoPerson) return { total: Number(twoPerson[1]) };

  const budget = content.match(
    /预算\s*(?:大概|大约|约)?\s*(\d+(?:\.\d+)?)\s*(?:元|块)?/,
  );
  if (budget) return { total: Number(budget[1]) };

  return null;
};

const toTextContent = (content: MessageContent): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if ("text" in part && typeof part.text === "string") return part.text;
      return "";
    })
    .join("");
};

const extractJsonObject = (text: string): unknown | null => {
  const fenced =
    text.match(/```json\s*([\s\S]*?)\s*```/i) ||
    text.match(/```\s*([\s\S]*?)\s*```/);
  const raw = (fenced?.[1] ?? text).trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
};

const clampConfidence = (value: unknown): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
};

const isScene = (value: unknown): value is ChatScene =>
  value === "spot_sign" ||
  value === "ticket_itinerary" ||
  value === "food_menu" ||
  value === "unknown";

const buildImageHumanMessage = (
  text: string,
  imageDataUrls: string[],
): HumanMessage => {
  if (imageDataUrls.length === 0) {
    return new HumanMessage(text);
  }

  return new HumanMessage({
    content: [
      { type: "text", text },
      ...imageDataUrls.map((url) => ({
        type: "image_url" as const,
        image_url: { url },
      })),
    ],
  });
};

/**
 * 场景分类：以视觉模型为主，sceneHint 仅加权。
 */
export async function classifyScene(params: {
  visionLlm: ChatOpenAI;
  imageDataUrls: string[];
  message?: string;
  sceneHint?: ChatSceneHint | null;
  signal?: AbortSignal;
}): Promise<{ scene: ChatScene; confidence: number }> {
  const { visionLlm, imageDataUrls, message = "", sceneHint, signal } = params;

  if (imageDataUrls.length === 0) {
    return { scene: sceneHint ?? "unknown", confidence: sceneHint ? 0.6 : 0 };
  }

  const hintNote = sceneHint
    ? `前端给出的软提示 sceneHint=${sceneHint}（仅供参考，可纠正）。`
    : "前端未提供 sceneHint。";

  try {
    const response = await visionLlm.invoke(
      [
        new SystemMessage(
          `你是旅游图片场景分类器。只输出 JSON：
{"scene":"spot_sign|ticket_itinerary|food_menu|unknown","confidence":0到1的小数}
规则：
- spot_sign：景点牌、路牌、导览牌、地标外观
- ticket_itinerary：门票、电子票、行程单、订单截图
- food_menu：菜单、价目表、菜品价签
- 无法判断用 unknown
${hintNote}`,
        ),
        buildImageHumanMessage(
          `用户文字：${message.trim() || "（无文字）"}\n请分类。`,
          imageDataUrls.slice(0, 1),
        ),
      ],
      { signal },
    );

    const parsed = extractJsonObject(toTextContent(response.content)) as {
      scene?: unknown;
      confidence?: unknown;
    } | null;

    if (parsed && isScene(parsed.scene)) {
      let scene = parsed.scene;
      let confidence = clampConfidence(parsed.confidence);

      // hint 与分类冲突时：分类置信度不高则采纳 hint
      if (
        sceneHint &&
        scene !== sceneHint &&
        scene !== "unknown" &&
        confidence < 0.55
      ) {
        scene = sceneHint;
        confidence = Math.max(confidence, 0.55);
      } else if (sceneHint && scene === "unknown") {
        scene = sceneHint;
        confidence = Math.max(confidence, 0.5);
      }

      return { scene, confidence };
    }
  } catch (error) {
    const detail =
      error && typeof error === "object" && "status" in error
        ? `status=${String((error as { status?: unknown }).status)}`
        : "";
    console.warn(
      "[scenes] classifyScene failed:",
      detail,
      error instanceof Error ? error.message : error,
      "— 请检查 SILICONFLOW_VISION_MODEL 是否为可用的 VL 对话模型",
    );
  }

  return {
    scene: sceneHint ?? "unknown",
    confidence: sceneHint ? 0.45 : 0.2,
  };
}

async function extractSpotSign(
  visionLlm: ChatOpenAI,
  imageDataUrls: string[],
  message: string,
  signal?: AbortSignal,
): Promise<SpotSignExtract> {
  try {
    const response = await visionLlm.invoke(
      [
        new SystemMessage(
          `从图片中识别景点/路牌信息，只输出 JSON：
{"placeName":"","placeType":"","visibleText":"","confidence":0到1}
看不清的字段用空字符串，勿编造。`,
        ),
        buildImageHumanMessage(
          `用户问题：${message || "这是哪里？"}\n请抽取。`,
          imageDataUrls,
        ),
      ],
      { signal },
    );
    const parsed = extractJsonObject(toTextContent(response.content)) as
      | Partial<SpotSignExtract>
      | null;
    return {
      placeName: parsed?.placeName?.trim() || undefined,
      placeType: parsed?.placeType?.trim() || undefined,
      visibleText: parsed?.visibleText?.trim() || undefined,
      confidence: clampConfidence(parsed?.confidence),
    };
  } catch (error) {
    console.warn("[scenes] extractSpotSign failed:", error);
    return { confidence: 0.2 };
  }
}

async function extractTicket(
  visionLlm: ChatOpenAI,
  imageDataUrls: string[],
  message: string,
  signal?: AbortSignal,
): Promise<TicketItineraryExtract> {
  try {
    const response = await visionLlm.invoke(
      [
        new SystemMessage(
          `从门票/行程截图抽取结构化信息，只输出 JSON：
{"kind":"ticket|itinerary|mixed|unknown","title":"","spots":[],"startDate":"YYYY-MM-DD或空","endDate":"","visitTime":"","ticketType":"","price":"","orderNo":"","notes":[],"confidence":0到1}
看不清填空/空数组，勿编造。`,
        ),
        buildImageHumanMessage(
          `用户问题：${message || "请识别关键信息"}\n请抽取。`,
          imageDataUrls,
        ),
      ],
      { signal },
    );
    const parsed = extractJsonObject(toTextContent(response.content)) as
      | Partial<TicketItineraryExtract>
      | null;

    const kind =
      parsed?.kind === "ticket" ||
      parsed?.kind === "itinerary" ||
      parsed?.kind === "mixed" ||
      parsed?.kind === "unknown"
        ? parsed.kind
        : "unknown";

    return {
      kind,
      title: parsed?.title?.trim() || undefined,
      spots: Array.isArray(parsed?.spots)
        ? parsed!.spots.filter((s): s is string => typeof s === "string")
        : [],
      startDate: parsed?.startDate?.trim() || undefined,
      endDate: parsed?.endDate?.trim() || undefined,
      visitTime: parsed?.visitTime?.trim() || undefined,
      ticketType: parsed?.ticketType?.trim() || undefined,
      price: parsed?.price?.trim() || undefined,
      orderNo: parsed?.orderNo?.trim() || undefined,
      notes: Array.isArray(parsed?.notes)
        ? parsed!.notes.filter((s): s is string => typeof s === "string")
        : [],
      confidence: clampConfidence(parsed?.confidence),
    };
  } catch (error) {
    console.warn("[scenes] extractTicket failed:", error);
    return { kind: "unknown", spots: [], notes: [], confidence: 0.2 };
  }
}

async function extractFoodMenu(
  visionLlm: ChatOpenAI,
  imageDataUrls: string[],
  message: string,
  signal?: AbortSignal,
): Promise<FoodMenuExtract> {
  try {
    const response = await visionLlm.invoke(
      [
        new SystemMessage(
          `从菜单/价目表抽取菜品，只输出 JSON：
{"items":[{"name":"","price":数字或省略,"category":""}],"avgPriceMin":数字,"avgPriceMax":数字,"confidence":0到1}
看不清勿编造；items 最多 30 条。`,
        ),
        buildImageHumanMessage(
          `用户问题：${message || "按菜单推荐"}\n请抽取。`,
          imageDataUrls,
        ),
      ],
      { signal },
    );
    const parsed = extractJsonObject(toTextContent(response.content)) as
      | Partial<FoodMenuExtract>
      | null;

    const items = Array.isArray(parsed?.items)
      ? parsed!.items
          .filter(
            (item): item is FoodMenuItem =>
              !!item &&
              typeof item === "object" &&
              typeof (item as FoodMenuItem).name === "string",
          )
          .map((item) => ({
            name: String(item.name).trim(),
            ...(typeof item.price === "number" ? { price: item.price } : {}),
            ...(typeof item.category === "string" && item.category.trim()
              ? { category: item.category.trim() }
              : {}),
          }))
          .filter((item) => item.name)
          .slice(0, 30)
      : [];

    return {
      items,
      avgPriceMin:
        typeof parsed?.avgPriceMin === "number"
          ? parsed.avgPriceMin
          : undefined,
      avgPriceMax:
        typeof parsed?.avgPriceMax === "number"
          ? parsed.avgPriceMax
          : undefined,
      confidence: clampConfidence(parsed?.confidence),
    };
  } catch (error) {
    console.warn("[scenes] extractFoodMenu failed:", error);
    return { items: [], confidence: 0.2 };
  }
}

const formatSpotContext = (data: SpotSignExtract): string => {
  return `## 图片理解（景点/路牌）
- 名称：${data.placeName || "未识别"}
- 类型：${data.placeType || "未识别"}
- 可见文字：${data.visibleText || "未识别"}
- 置信度：${data.confidence}
回答结构请覆盖：
${SCENE_ANSWER_OUTLINE.spot_sign.map((line, i) => `${i + 1}. ${line}`).join("\n")}
若置信度 < 0.45，明确说不确定并追问城市/景点名，勿胡编。`;
};

const formatTicketContext = (data: TicketItineraryExtract): string => {
  const maskedOrder = data.orderNo ? maskOrderNo(data.orderNo) : "未识别";
  return `## 图片理解（门票/行程）
- 类型：${data.kind}
- 标题：${data.title || "未识别"}
- 景点：${data.spots.length ? data.spots.join("、") : "未识别"}
- 开始日期：${data.startDate || "未识别"}
- 结束日期：${data.endDate || "未识别"}
- 时段：${data.visitTime || "未识别"}
- 票种：${data.ticketType || "未识别"}
- 价格：${data.price || "未识别"}
- 订单号（已脱敏）：${maskedOrder}
- 注意事项：${data.notes.length ? data.notes.join("；") : "未识别"}
- 置信度：${data.confidence}
回答结构请覆盖：
${SCENE_ANSWER_OUTLINE.ticket_itinerary.map((line, i) => `${i + 1}. ${line}`).join("\n")}
对外展示订单号必须使用脱敏形式，禁止输出完整订单号。看不清字段写「未识别」。`;
};

const formatFoodContext = (
  data: FoodMenuExtract,
  message: string,
): string => {
  const budget = parseBudgetFromText(message);
  const budgetLine = budget
    ? `- 用户本轮预算：${
        budget.perPerson != null
          ? `人均约 ${budget.perPerson} 元`
          : `总计约 ${budget.total} 元`
      }`
    : "- 用户本轮未给出明确预算：请追问，并先给高/中/低三档示例推荐";

  const itemLines = data.items.length
    ? data.items
        .slice(0, 20)
        .map(
          (item) =>
            `- ${item.name}${
              typeof item.price === "number" ? ` ¥${item.price}` : ""
            }${item.category ? `（${item.category}）` : ""}`,
        )
        .join("\n")
    : "- （未识别到菜品）";

  return `## 图片理解（美食/价目）
${budgetLine}
- 估算人均：${
    data.avgPriceMin != null || data.avgPriceMax != null
      ? `${data.avgPriceMin ?? "?"} ~ ${data.avgPriceMax ?? "?"}`
      : "未识别"
  }
- 置信度：${data.confidence}
### 菜品列表
${itemLines}
回答结构请覆盖：
${SCENE_ANSWER_OUTLINE.food_menu.map((line, i) => `${i + 1}. ${line}`).join("\n")}`;
};

/**
 * 完整场景管线：分类 → 抽取 → 生成上下文块。
 */
export async function runScenePipeline(params: {
  visionLlm: ChatOpenAI;
  imageDataUrls: string[];
  message?: string;
  sceneHint?: ChatSceneHint | null;
  signal?: AbortSignal;
}): Promise<ScenePipelineResult> {
  const {
    visionLlm,
    imageDataUrls,
    message = "",
    sceneHint,
    signal,
  } = params;

  const { scene } = await classifyScene({
    visionLlm,
    imageDataUrls,
    message,
    sceneHint,
    signal,
  });

  if (scene === "spot_sign") {
    const data = await extractSpotSign(
      visionLlm,
      imageDataUrls,
      message,
      signal,
    );
    return {
      scene,
      extract: { scene, data },
      contextBlock: formatSpotContext(data),
    };
  }

  if (scene === "ticket_itinerary") {
    const data = await extractTicket(
      visionLlm,
      imageDataUrls,
      message,
      signal,
    );
    return {
      scene,
      extract: { scene, data },
      contextBlock: formatTicketContext(data),
    };
  }

  if (scene === "food_menu") {
    const data = await extractFoodMenu(
      visionLlm,
      imageDataUrls,
      message,
      signal,
    );
    return {
      scene,
      extract: { scene, data },
      contextBlock: formatFoodContext(data, message),
    };
  }

  return {
    scene: "unknown",
    extract: { scene: "unknown", data: null },
    contextBlock: `## 图片理解（通用）
未能可靠归类为景点牌/门票行程/菜单。请结合图片内容直接回答用户问题；看不清时说明不确定并追问。`,
  };
}

/** 构建带图的用户消息（最终回答轮） */
export const buildMultimodalHumanMessage = (
  text: string,
  imageDataUrls: string[],
): HumanMessage => buildImageHumanMessage(text, imageDataUrls);

export const sceneHintTitle = (scene?: ChatSceneHint | null): string => {
  if (scene === "spot_sign") return "景点路牌识别";
  if (scene === "ticket_itinerary") return "门票行程识别";
  if (scene === "food_menu") return "菜单推荐";
  return "图片咨询";
};
