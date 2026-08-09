import { ChatOpenAI } from "@langchain/openai";
import type { MessageContent } from "@langchain/core/messages";
import { HumanMessage, SystemMessage } from "langchain";
import {
  TravelAgent,
  type ChatHistoryItem,
  type ChatStreamCallback,
  type UserLocationInput,
} from "../agent/travelAgent.js";

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
};

class TravelService {
  private llm: ChatOpenAI;
  private agent: TravelAgent;

  constructor() {
    this.llm = this.initLLM();
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
      // 1、获取提示词数据
      const messages = this.getTravelPrompt(city, budget, days);

      console.log("获取提示词数据完成");
      // 2、调用 LLM 模型
      const response = await this.llm.invoke(messages);
      console.log("response", response);
      // 3、处理大模型返回结果
      try {
        // 3-1、大模型的原始数据
        const originContent = response.content as string;

        // 3-2、（systemPrompt已经要求了 JSON 格式）正则匹配筛选出 JSON 格式的数据
        const jsonContent = this.getJsonContent(originContent);

        // 3-3、如果筛选不出 JSON 格式的数据，则抛出错误
        if (!jsonContent) {
          throw new Error("Invalid JSON content");
        }
        const parsedContent = JSON.parse(jsonContent?.[1]);

        return parsedContent;
      } catch (parseError) {
        return {
          success: false,
          message:
            parseError instanceof Error ? parseError.message : parseError,
        };
      }
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : error,
      };
    }
  }

  getTravelPrompt(city: string, budget: number, days: number) {
    const systemPrompt = `
你是一个专业的旅游规划师，擅长根据用户的需求生成详细的旅行行程。
要求：
1. 每天的行程安排（上午、下午、晚上）
2. 每个景点的详细介绍
3. 交通建议
4. 预算分配明细
5. 注意事项

请以JSON格式输出，结构如下：
{
  "success": true,
  "city": "城市名",
  "days": 天数,
  "totalBudget": 总预算,
  "dailyItinerary": [
    {
      "day": 1,
      "date": "第1天",
      "morning": {
        "spot": "景点名称",
        "duration": "游览时长",
        "ticket": "门票价格",
        "transportation": "交通方式",
        "description": "景点介绍"
      },
      "afternoon": {
        "spot": "景点名称",
        "duration": "游览时长",
        "ticket": "门票价格",
        "transportation": "交通方式",
        "description": "景点介绍"
      },
      "evening": {
        "spot": "活动名称",
        "duration": "活动时长",
        "ticket": "费用",
        "transportation": "交通方式",
        "description": "活动介绍"
      }
    }
  ],
  "budgetBreakdown": {
    "accommodation": 住宿费用,
    "food": 餐饮费用,
    "transportation": 交通费用,
    "tickets": 门票费用,
    "other": 其他费用
  },
  "tips": ["提示1", "提示2", "提示3"],
  "warnings": ["注意事项1", "注意事项2"]
}

请确保JSON格式正确，可以被解析。`;

    const humanPrompt = `请根据以下信息为用户生成一份详细的旅游规划：
- 目的地城市：${city}
- 预算：${budget}元
- 旅行天数：${days}天`;

    /**
     * HumanMessage 会把这段文本标记为 role: "user"
     * SystemMessage 会把这段文本标记为 role: "system"
     */
    return [new SystemMessage(systemPrompt), new HumanMessage(humanPrompt)];
  }

  getJsonContent(content: string) {
    return (
      content.match(/```json\n([\s\S]*?)\n```/) ||
      content.match(/```\n([\s\S]*?)\n```/) ||
      content.match(/\{[\s\S]*\}/)
    );
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
   * 流式对话：委托 Travel Agent（Tool Calling + RAG）。
   * 传入 signal 后，客户端断开可取消上游大模型请求。
   */
  async chat(params: ChatParams) {
    return this.agent.chat(params);
  }
}

export default new TravelService();
