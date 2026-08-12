import type { ChatOpenAI } from "@langchain/openai";
import type { MessageContent } from "@langchain/core/messages";
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "langchain";
import type { ChatSceneHint } from "../db/chatStore.js";
import {
  formatChunksForPrompt,
  retrieveKnowledge,
} from "../rag/knowledgeBase.js";
import {
  buildTravelAgentSystemPrompt,
  type LocationContext,
} from "./prompts.js";
import {
  buildMultimodalHumanMessage,
  buildSceneHintContext,
  runScenePipeline,
} from "./scenes.js";
import {
  createTravelTools,
  reverseGeocode,
  type ToolRuntimeOptions,
} from "./tools.js";

export type ChatStreamCallback = (chunk: string) => void;

export type ChatHistoryItem = {
  role: "user" | "assistant";
  content: string;
};

export type UserLocationInput = {
  lat: number;
  lon: number;
  accuracy?: number;
  city?: string;
  displayName?: string;
};

export type TravelAgentChatParams = {
  message: string;
  history?: ChatHistoryItem[];
  streamCallback: ChatStreamCallback;
  signal?: AbortSignal;
  dryTools?: boolean;
  /** 前端浏览器定位 */
  location?: UserLocationInput | null;
  /** 本轮图片 data URL（Vision） */
  imageDataUrls?: string[];
  sceneHint?: ChatSceneHint | null;
  /** 有图时用于分类/抽取的 Vision 模型；缺省则复用主 LLM */
  visionLlm?: ChatOpenAI | null;
};

export type TravelAgentChatResult =
  | {
      success: true;
      aborted: boolean;
      response: string;
      toolTrace: string[];
    }
  | {
      success: false;
      aborted: false;
      response: string;
      toolTrace: string[];
      message: unknown;
    };

const MAX_TOOL_ROUNDS = 3;

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

const isAbortError = (error: unknown, signal?: AbortSignal): boolean => {
  if (signal?.aborted) return true;
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String(error.name) : "";
  const message = "message" in error ? String(error.message) : "";
  return name === "AbortError" || /abor(t|ted)/i.test(message);
};

const extractCityHint = (text: string): string | undefined => {
  const cities = ["北京", "上海", "成都", "杭州", "东京", "西安"];
  return cities.find((city) => text.includes(city));
};

export class TravelAgent {
  constructor(private readonly llm: ChatOpenAI) {}

  async chat(params: TravelAgentChatParams): Promise<TravelAgentChatResult> {
    const {
      message,
      history = [],
      streamCallback,
      signal,
      dryTools = process.env.EVAL_DRY_TOOLS === "1",
      location = null,
      imageDataUrls = [],
      sceneHint = null,
      visionLlm = null,
    } = params;

    let fullText = "";
    const toolTrace: string[] = [];

    try {
      const toolOptions: ToolRuntimeOptions = { dryTools };

      let locationContext: LocationContext | null = null;
      if (
        location &&
        Number.isFinite(location.lat) &&
        Number.isFinite(location.lon)
      ) {
        locationContext = {
          lat: location.lat,
          lon: location.lon,
          city: location.city,
          displayName: location.displayName,
        };
        // 前端未带城市时，服务端再逆地理一次
        if (!locationContext.city) {
          try {
            const rev = await reverseGeocode(
              location.lat,
              location.lon,
              toolOptions,
            );
            locationContext.city = rev.city;
            locationContext.displayName = rev.displayName;
          } catch (error) {
            console.warn("[TravelAgent] reverseGeocode failed:", error);
          }
        }
      }

      let sceneContext: string | null = null;
      const vision = visionLlm ?? this.llm;

      if (imageDataUrls.length > 0) {
        // 默认跳过「分类+抽取」两次额外 Vision 调用，直接把原图交给 VL 回答。
        // 需要结构化管线时设置 ENABLE_SCENE_PIPELINE=1。
        if (process.env.ENABLE_SCENE_PIPELINE === "1") {
          const pipeline = await runScenePipeline({
            visionLlm: vision,
            imageDataUrls,
            message,
            sceneHint,
            signal,
          });
          sceneContext = pipeline.contextBlock;
          toolTrace.push(`scene:${pipeline.scene}`);
          console.log(
            `[TravelAgent] scene pipeline => ${pipeline.scene}`,
            pipeline.extract,
          );
        } else {
          sceneContext = buildSceneHintContext(sceneHint);
          toolTrace.push(`sceneHint:${sceneHint || "none"}`);
        }
      }

      const ragQuery =
        message.trim() ||
        sceneContext?.slice(0, 200) ||
        "旅游图片咨询";
      const cityHint =
        extractCityHint(
          `${message} ${history.map((h) => h.content).join(" ")} ${sceneContext || ""}`,
        ) || locationContext?.city;
      const ragChunks = retrieveKnowledge({
        query: ragQuery,
        city: cityHint,
        topK: 3,
      });
      const ragContext = formatChunksForPrompt(ragChunks);

      const historyMessages = history.map((item) =>
        item.role === "assistant"
          ? new AIMessage(item.content)
          : new HumanMessage(item.content),
      );

      const userText =
        message.trim() ||
        (imageDataUrls.length > 0
          ? "请结合我上传的图片给出旅游相关建议。"
          : "");

      /**
       * 有图时的回答策略：
       * - 默认把原图交给 Vision 模型流式回答（主模型 Kimi 等纯文本看不到图）
       * - 仅当 FORCE_TEXT_CHAT_WITH_IMAGES=1 时，退回主模型 + 文本上下文
       */
      const preferVisionAnswer =
        imageDataUrls.length > 0 &&
        process.env.FORCE_TEXT_CHAT_WITH_IMAGES !== "1";

      if (preferVisionAnswer) {
        console.log("[TravelAgent] answering with vision model + images");
        const visionMessages: BaseMessage[] = [
          new SystemMessage(
            buildTravelAgentSystemPrompt(
              ragContext,
              locationContext,
              sceneContext,
            ) +
              `\n\n你可以直接查看用户上传的图片。请基于图片内容回答，不要说「无法查看图片」。`,
          ),
          ...historyMessages,
          buildMultimodalHumanMessage(userText, imageDataUrls),
        ];

        const stream = await vision.stream(visionMessages, { signal });
        for await (const chunk of stream) {
          if (signal?.aborted) break;
          const text = toTextContent(chunk.content);
          if (text) {
            fullText += text;
            streamCallback(text);
          }
        }

        return {
          success: true,
          aborted: Boolean(signal?.aborted),
          response: fullText,
          toolTrace,
        };
      }

      const messages: BaseMessage[] = [
        new SystemMessage(
          buildTravelAgentSystemPrompt(
            ragContext,
            locationContext,
            sceneContext,
          ),
        ),
        ...historyMessages,
        new HumanMessage(userText),
      ];

      const tools = createTravelTools(toolOptions);
      // 放宽类型，避免不同 StructuredTool 泛型导致 Map/invoke 联合签名冲突
      const toolsByName = new Map<
        string,
        { invoke: (input: unknown, config?: { signal?: AbortSignal }) => Promise<unknown> }
      >(tools.map((t) => [t.name, t as { invoke: (input: unknown, config?: { signal?: AbortSignal }) => Promise<unknown> }]));
      const llmWithTools = this.llm.bindTools(tools);

      for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
        if (signal?.aborted) break;

        // 用 stream 代替 invoke：最终回答边生成边推 SSE；工具调用轮通常无正文
        let gathered: AIMessageChunk | undefined;
        let sawToolCallChunks = false;
        let roundText = "";

        const stream = await llmWithTools.stream(messages, { signal });
        for await (const chunk of stream) {
          if (signal?.aborted) break;

          gathered = gathered ? gathered.concat(chunk) : chunk;

          if (
            (chunk.tool_call_chunks?.length ?? 0) > 0 ||
            (chunk.tool_calls?.length ?? 0) > 0
          ) {
            sawToolCallChunks = true;
          }

          const text = toTextContent(chunk.content);
          // 工具调用轮不向客户端推正文，避免半段废话后跳到工具结果
          if (text && !sawToolCallChunks) {
            roundText += text;
            fullText += text;
            streamCallback(text);
          }
        }

        if (!gathered) break;

        const toolCalls = gathered.tool_calls?.filter((c) => c.name) ?? [];
        const aiMessage = new AIMessage({
          content: gathered.content,
          tool_calls: toolCalls,
          id: gathered.id,
        });
        messages.push(aiMessage);

        if (toolCalls.length === 0) {
          // 最终回答已在上方按 token 推送
          if (!fullText && roundText) {
            fullText = roundText;
          }
          return {
            success: true,
            aborted: Boolean(signal?.aborted),
            response: fullText,
            toolTrace,
          };
        }

        // 进入工具轮：丢掉本轮误推的正文，等工具后再流式生成最终回答
        fullText = "";

        for (const call of toolCalls) {
          if (signal?.aborted) break;
          const name = call.name;
          const args = call.args ?? {};
          toolTrace.push(name);
          console.log(`[TravelAgent] tool_call: ${name}`, args);

          const selected = toolsByName.get(name);
          let resultText: string;
          if (!selected) {
            resultText = JSON.stringify({
              ok: false,
              tool: name,
              error: `Unknown tool: ${name}`,
            });
          } else {
            try {
              const raw = await selected.invoke(args, { signal });
              resultText =
                typeof raw === "string" ? raw : JSON.stringify(raw);
            } catch (error) {
              resultText = JSON.stringify({
                ok: false,
                tool: name,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }

          messages.push(
            new ToolMessage({
              content: resultText,
              tool_call_id: call.id ?? `${name}-${round}`,
            }),
          );
        }
      }

      if (signal?.aborted) {
        return {
          success: true,
          aborted: true,
          response: fullText,
          toolTrace,
        };
      }

      // 工具轮次耗尽仍未给出最终文本时，不绑工具再流式生成一次
      const stream = await this.llm.stream(messages, { signal });
      for await (const chunk of stream) {
        if (signal?.aborted) break;
        const text = toTextContent(chunk.content);
        if (text) {
          fullText += text;
          streamCallback(text);
        }
      }

      return {
        success: true,
        aborted: Boolean(signal?.aborted),
        response: fullText,
        toolTrace,
      };
    } catch (error) {
      if (isAbortError(error, signal)) {
        console.log(
          "travelAgent chat aborted, partial length:",
          fullText.length,
        );
        return {
          success: true,
          aborted: true,
          response: fullText,
          toolTrace,
        };
      }

      return {
        success: false,
        aborted: false,
        response: fullText,
        toolTrace,
        message: error instanceof Error ? error.message : error,
      };
    }
  }
}
