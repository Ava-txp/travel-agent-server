import { ChatOpenAI } from "@langchain/openai";
import type { MessageContent } from "@langchain/core/messages";
import { HumanMessage, SystemMessage } from "langchain";
import type { ChatSceneHint } from "../db/chatStore.js";
import {
  TravelAgent,
  type ChatHistoryItem,
  type ChatStreamCallback,
  type UserLocationInput,
} from "../agent/travelAgent.js";
import { isRateLimitError } from "../utils/llmErrors.js";
import { extractJsonBlock, parsePlanJson } from "../utils/planJson.js";
import { getTravelPrompt } from "./recommendPrompt.js";
import {
  runRecommendStream,
  type RecommendStreamParams,
} from "./recommendStream.js";

/** 流式对话：每收到一段文本就回调一次 */
export type { ChatStreamCallback, ChatHistoryItem, UserLocationInput };

export type ChatParams = {
  message: string;
  history?: ChatHistoryItem[];
  streamCallback: ChatStreamCallback;
  signal?: AbortSignal;
  /** 评测时可强制工具打桩 */
  dryTools?: boolean;
  /** 前端浏览器定位 */
  location?: UserLocationInput | null;
  imageDataUrls?: string[];
  sceneHint?: ChatSceneHint | null;
};

class TravelService {
  private llm: ChatOpenAI;
  private visionLlm: ChatOpenAI;
  private agent: TravelAgent;

  constructor() {
    this.llm = this.initLLM();
    this.visionLlm = this.initVisionLLM();
    this.agent = new TravelAgent(this.llm);
  }

  /**
   * 大模型初始化
   */
  initLLM() {
    console.log("initLLM......");

    const provider = process.env.MODEL_PROVIDER;

    if (!provider) {
      throw new Error("MODEL_PROVIDER is not set");
    }

    const apiKey = process.env[`${provider}_API_KEY`];
    const baseURL = process.env[`${provider}_BASE_URL`];
    const model = process.env[`${provider}_MODEL`];

    if (!apiKey || !baseURL || !model) {
      throw new Error(`Missing LLM config for provider: ${provider}`);
    }

    return new ChatOpenAI({
      apiKey, // API 密钥
      model, // 模型名称
      temperature: 0.7, // 采样温度，越高回答越发散
      streaming: true, // 开启流式输出
      modelKwargs: {
        enable_thinking: false,
      },
      configuration: {
        baseURL, // 兼容 OpenAI 协议的接口地址（如硅基流动）
      },
    });
  }

  /**
   * Vision 模型：优先 `${PROVIDER}_VISION_MODEL`，否则回退主模型。
   */
  initVisionLLM() {
    const provider = process.env.MODEL_PROVIDER;
    if (!provider) {
      throw new Error("MODEL_PROVIDER is not set");
    }

    const apiKey = process.env[`${provider}_API_KEY`];
    const baseURL = process.env[`${provider}_BASE_URL`];
    const visionModel =
      process.env[`${provider}_VISION_MODEL`] ||
      process.env.VISION_MODEL ||
      process.env[`${provider}_MODEL`];

    if (!apiKey || !baseURL || !visionModel) {
      throw new Error(`Missing Vision LLM config for provider: ${provider}`);
    }

    console.log("initVisionLLM......", visionModel);

    return new ChatOpenAI({
      apiKey,
      model: visionModel,
      temperature: 0.2,
      // 有图时最终回答也走 vision.stream
      streaming: true,
      // 注意：Qwen3-VL 等视觉模型不支持 enable_thinking，勿写入 modelKwargs
      configuration: {
        baseURL,
      },
    });
  }

  /**
   * 旅游规划
   */
  async recommend(city: string, budget: number, days: number) {
    try {
      /**
       * ========== 【part 1】验证参数 ===========
       */
      if (days < 1 || days > 30) {
        throw new Error("Days must be between 1 and 30");
      }
      if (budget < 100) {
        throw new Error("Budget must be greater than 100");
      }

      console.log("参数验证通过");

      console.log("开始调用大模型");

      /**
       * ========== 【part 2】大模型调用 ===========
       */
      const messages = getTravelPrompt(city, budget, days);

      console.log("获取提示词数据完成");
      const response = await this.llm.invoke(messages);
      console.log("response", response);
      try {
        const originContent = response.content as string;
        const jsonContent = extractJsonBlock(originContent);
        if (!jsonContent) {
          throw new Error("Invalid JSON content");
        }
        return parsePlanJson(jsonContent);
      } catch (parseError) {
        return {
          success: false,
          message:
            parseError instanceof Error ? parseError.message : parseError,
        };
      }
    } catch (error) {
      if (isRateLimitError(error)) throw error;
      return {
        success: false,
        message: error instanceof Error ? error.message : error,
      };
    }
  }

  recommendStream(params: Omit<RecommendStreamParams, "llm">) {
    return runRecommendStream({ ...params, llm: this.llm });
  }

  /**
   * 把 MessageContent（string | 多模态块数组）转成纯文本
   */
  private toTextContent(content: MessageContent): string {
    if (typeof content === "string") {
      return content;
    }

    if (!Array.isArray(content)) {
      return "";
    }

    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if ("text" in part && typeof part.text === "string") return part.text;
        return "";
      })
      .join("");
  }

  /**
   * 根据用户首条消息生成短标题（非流式）。
   * 失败时返回 null，由调用方保留截断标题兜底。
   */
  async summarizeTitle(userMessage: string): Promise<string | null> {
    const content = userMessage.trim();
    if (!content) return null;

    try {
      const messages = [
        new SystemMessage(
          `你是会话标题生成器。请根据用户的第一条消息，生成简洁的中文会话标题。
要求：
1. 只输出标题本身，不要引号、解释或其它多余文字
2. 不超过 20 个字
3. 尽量体现目的地、天数或核心诉求`,
        ),
        new HumanMessage(content),
      ];

      // invoke 拿完整结果，不走流式对话路径
      const response = await this.llm.invoke(messages);

      const text = this.toTextContent(response.content)
        .trim()
        .replace(/^["'「『]+|["'」』]+$/g, "")
        .replace(/\s+/g, " ");

      return text || null;
    } catch (error) {
      console.error("summarizeTitle failed:", error);
      return null;
    }
  }

  /**
   * 将滑出上下文窗口的旧消息压缩成短摘要，供后续轮次作为前置记忆。
   */
  async summarizeHistory(
    messages: Array<{ role: "user" | "assistant"; content: string }>,
  ): Promise<string | null> {
    const transcript = messages
      .map((m) => `${m.role === "user" ? "用户" : "助手"}: ${m.content.trim()}`)
      .filter((line) => line.length > 4)
      .join("\n")
      .slice(0, 6_000);

    if (!transcript.trim()) return null;

    try {
      const response = await this.llm.invoke([
        new SystemMessage(
          `你是对话记忆压缩器。请把以下早期对话压缩成简洁中文摘要，供后续轮次继续使用。
要求：
1. 保留目的地、天数、预算、已确认偏好、未完成待办与关键事实
2. 不要编造原文没有的信息
3. 控制在 200 字以内，只输出摘要正文`,
        ),
        new HumanMessage(transcript),
      ]);

      const text = this.toTextContent(response.content).trim();
      return text || null;
    } catch (error) {
      console.error("summarizeHistory failed:", error);
      return null;
    }
  }

  /**
   * 流式对话：委托 Travel Agent（Tool Calling + RAG）。
   * 传入 signal 后，客户端断开可取消上游大模型请求。
   */
  async chat(params: ChatParams) {
    return this.agent.chat({
      ...params,
      visionLlm: this.visionLlm,
    });
  }
}

export default new TravelService();
