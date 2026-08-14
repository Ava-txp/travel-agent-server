/**
 * Token 估算（中英混合启发式）。
 * 不依赖 tiktoken：对 OpenAI 兼容国内模型足够用于上下文裁剪预算，
 * 误差通常在 ±20% 内；真正计费仍以服务商账单为准。
 *
 * 经验规则（偏保守，宁可多估）：
 * - 连续 CJK：约 1.5 token / 字
 * - 其它（拉丁 / 数字 / 符号）：约 0.25 token / 字（≈ 4 chars / token）
 */

const CJK_RANGE =
  /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u{20000}-\u{2A6DF}]/u;

export const estimateTokens = (text: string): number => {
  if (!text) return 0;

  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK_RANGE.test(ch)) cjk += 1;
    else other += 1;
  }

  return Math.ceil(cjk * 1.5 + other * 0.25);
};

export const estimateMessageTokens = (role: string, content: string): number => {
  // role / 消息分隔符开销（粗估）
  return estimateTokens(content) + estimateTokens(role) + 4;
};
