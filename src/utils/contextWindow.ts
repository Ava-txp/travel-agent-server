import {
  estimateMessageTokens,
  estimateTokens,
} from "./tokenCounter.js";

export type HistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

export type ContextWindowConfig = {
  /** 模型上下文总窗口（默认 32k，可用 env 覆盖） */
  maxContextTokens: number;
  /** 预留给模型输出 */
  reserveForResponse: number;
  /** 预留给 system prompt / RAG / 工具 schema */
  reserveForSystemAndTools: number;
  /** 是否对滑出窗口的旧消息做摘要压缩 */
  enableSummary: boolean;
};

export type ContextUsageStats = {
  maxInputTokens: number;
  systemReserveTokens: number;
  currentMessageTokens: number;
  historyBeforeTokens: number;
  historyAfterTokens: number;
  keptMessages: number;
  droppedMessages: number;
  summarized: boolean;
  estimatedTotalInputTokens: number;
};

export type PrepareContextResult = {
  history: HistoryMessage[];
  stats: ContextUsageStats;
};

const DEFAULT_CONFIG: ContextWindowConfig = {
  maxContextTokens: 32_000,
  reserveForResponse: 2_048,
  reserveForSystemAndTools: 3_000,
  enableSummary: true,
};

export const loadContextWindowConfig = (): ContextWindowConfig => {
  const num = (key: string, fallback: number) => {
    const raw = process.env[key];
    if (!raw?.trim()) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };

  return {
    maxContextTokens: num("CONTEXT_MAX_TOKENS", DEFAULT_CONFIG.maxContextTokens),
    reserveForResponse: num(
      "CONTEXT_RESERVE_RESPONSE",
      DEFAULT_CONFIG.reserveForResponse,
    ),
    reserveForSystemAndTools: num(
      "CONTEXT_RESERVE_SYSTEM",
      DEFAULT_CONFIG.reserveForSystemAndTools,
    ),
    enableSummary:
      process.env.CONTEXT_ENABLE_SUMMARY === "0"
        ? false
        : DEFAULT_CONFIG.enableSummary,
  };
};

export type SummarizeHistoryFn = (
  dropped: HistoryMessage[],
) => Promise<string | null>;

/**
 * 滑动窗口 + 可选摘要压缩：
 * 1. 从最新消息向前累加，直到逼近输入预算；
 * 2. 若有被丢弃的旧消息且开启摘要，则调用 summarizeFn 压缩成一条前置上下文；
 * 3. 摘要本身也计入预算，放不下则再丢掉更旧的保留消息。
 */
export async function prepareChatContext(options: {
  history: HistoryMessage[];
  currentMessage: string;
  summarizeFn?: SummarizeHistoryFn;
  config?: Partial<ContextWindowConfig>;
}): Promise<PrepareContextResult> {
  const config = { ...loadContextWindowConfig(), ...options.config };
  const maxInputTokens = Math.max(
    512,
    config.maxContextTokens -
      config.reserveForResponse -
      config.reserveForSystemAndTools,
  );

  const currentMessageTokens = estimateMessageTokens(
    "user",
    options.currentMessage,
  );
  const historyBudget = Math.max(0, maxInputTokens - currentMessageTokens);

  const historyBeforeTokens = options.history.reduce(
    (sum, m) => sum + estimateMessageTokens(m.role, m.content),
    0,
  );

  // 从尾部（最新）向前取
  const keptReversed: HistoryMessage[] = [];
  let used = 0;
  for (let i = options.history.length - 1; i >= 0; i -= 1) {
    const msg = options.history[i]!;
    const cost = estimateMessageTokens(msg.role, msg.content);
    if (used + cost > historyBudget) break;
    keptReversed.push(msg);
    used += cost;
  }
  let kept = keptReversed.reverse();
  const dropped = options.history.slice(0, options.history.length - kept.length);

  let summarized = false;

  if (
    dropped.length > 0 &&
    config.enableSummary &&
    options.summarizeFn
  ) {
    try {
      const summary = await options.summarizeFn(dropped);
      if (summary?.trim()) {
        const summaryMsg: HistoryMessage = {
          role: "assistant",
          content: `【早期对话摘要】\n${summary.trim()}`,
        };
        const summaryCost = estimateMessageTokens(
          summaryMsg.role,
          summaryMsg.content,
        );

        // 摘要 + kept 可能超预算：从最旧 kept 起丢弃，直至可容纳摘要
        while (
          kept.length > 0 &&
          summaryCost +
            kept.reduce(
              (s, m) => s + estimateMessageTokens(m.role, m.content),
              0,
            ) >
            historyBudget
        ) {
          kept = kept.slice(1);
        }

        if (
          summaryCost +
            kept.reduce(
              (s, m) => s + estimateMessageTokens(m.role, m.content),
              0,
            ) <=
          historyBudget
        ) {
          kept = [summaryMsg, ...kept];
          summarized = true;
        }
      }
    } catch (error) {
      console.warn("[contextWindow] summarize failed, fallback to sliding window only:", error);
    }
  }

  const historyAfterTokens = kept.reduce(
    (sum, m) => sum + estimateMessageTokens(m.role, m.content),
    0,
  );

  const stats: ContextUsageStats = {
    maxInputTokens,
    systemReserveTokens: config.reserveForSystemAndTools,
    currentMessageTokens,
    historyBeforeTokens,
    historyAfterTokens,
    keptMessages: kept.length,
    droppedMessages: dropped.length,
    summarized,
    estimatedTotalInputTokens:
      config.reserveForSystemAndTools +
      currentMessageTokens +
      historyAfterTokens,
  };

  console.log(
    "[contextWindow]",
    `in≈${stats.estimatedTotalInputTokens}/${config.maxContextTokens}`,
    `hist ${historyBeforeTokens}→${historyAfterTokens}`,
    `kept=${stats.keptMessages} dropped=${stats.droppedMessages}`,
    `summarized=${summarized}`,
  );

  return { history: kept, stats };
}

/** 仅估算一段文本占用（供日志 / 调试） */
export const peekTokenEstimate = (text: string) => estimateTokens(text);
