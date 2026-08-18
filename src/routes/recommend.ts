import type { Response } from "express";
import travelService from "../service/travelService.js";
import { RecommendStreamError } from "../service/recommendStream.js";
import type { AuthedRequest } from "../middleware/auth.js";
import { isRateLimitError, readRetryAfterSec } from "../utils/llmErrors.js";
import { createStreamResponse } from "../utils/streamUtils.js";

const HEARTBEAT_MS = 3000;

export async function handleRecommendStream(req: AuthedRequest, res: Response) {
  const { city, budget, days } = req.body || {};

  if (!city || !budget || !days) {
    return res.status(400).json({
      status: "error",
      message: "Missing required fields",
    });
  }

  const stream = createStreamResponse(res);
  stream.writeEvent({ type: "stage", content: "generating" });

  const abortController = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished && !abortController.signal.aborted) {
      abortController.abort();
    }
  });

  const heartbeat = setInterval(() => {
    stream.writeEvent({ type: "stage", content: "generating" });
  }, HEARTBEAT_MS);

  const clientId = req.header("X-Client-Id")?.trim();
  const owner = clientId ? { clientId, userId: req.user?.id ?? null } : null;

  try {
    await travelService.recommendStream({
      city: String(city),
      budget: Number(budget),
      days: Number(days),
      owner,
      signal: abortController.signal,
      onEvent: (event) => {
        if (abortController.signal.aborted || res.writableEnded) return;
        if (event.type === "done") {
          stream.end(event.content);
          return;
        }
        stream.writeEvent(event);
      },
    });
  } catch (error) {
    if (abortController.signal.aborted || res.writableEnded) {
      if (!res.writableEnded) res.end();
      return;
    }

    if (error instanceof RecommendStreamError) {
      stream.error(error.message, {
        code: error.code,
        retryAfter: error.retryAfter,
      });
      return;
    }

    if (isRateLimitError(error)) {
      stream.error("当前规划请求较多，请稍后再试", {
        code: "RATE_LIMITED",
        retryAfter: readRetryAfterSec(error) ?? 12,
      });
      return;
    }

    const message =
      error instanceof Error ? error.message : "生成失败，请稍后重试";
    stream.error(message);
  } finally {
    clearInterval(heartbeat);
  }
}
