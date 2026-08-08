import { Router, type Request, type Response } from "express";
import travelService from "../service/travelService.js";
import { createStreamResponse } from "../utils/streamUtils.js";

const router = Router();

router.post("/recommend", async (req: Request, res: Response) => {
  try {
    const { city, budget, days } = req.body || {};

    if (!city || !budget || !days) {
      return res.status(400).json({
        status: "error",
        message: "Missing required fields",
      });
    }

    const result = await travelService.recommend(city, budget, days);
    console.log("准备返回给客户端的数据", result);

    return res.status(200).json({
      status: "ok",
      data: result,
    });
  } catch {
    return res.status(500).json({
      status: "error",
      message: "Internal server error",
    });
  }
});

router.post("/chat", async (req: Request, res: Response) => {
  const { message } = (req.body ?? {}) as { message?: string };

  console.log("message", message);

  if (!message?.trim()) {
    return res.status(400).json({
      status: "error",
      message: "Missing required field: message",
    });
  }

  const stream = createStreamResponse(res);
  const abortController = new AbortController();

  /** 客户端断开（含前端 AbortController）时，取消上游大模型流 */
  const abortFromClient = () => {
    if (!abortController.signal.aborted) {
      console.log("client disconnected, aborting LLM stream");
      abortController.abort();
    }
  };

  /**
   * 不要用 req.on("close")：
   * express.json() 读完请求体后 req 就会 close，此时响应还在进行，
   * 会被误判成客户端断开，导致一进接口就 abort。
   *
   * 应监听 res.close，并用 !writableFinished 区分：
   * - 客户端中途断开：close 且尚未写完 → abort
   * - 正常 stream.end()/res.end()：先 writableFinished=true，再 close → 不 abort
   */
  res.on("close", () => {
    if (!res.writableFinished) {
      abortFromClient();
    }
  });

  try {
    const result = await travelService.chat(
      message,
      (chunk) => {
        if (abortController.signal.aborted || res.writableEnded) return;
        console.log("chunk", chunk);
        stream.writeChunk(chunk);
      },
      abortController.signal,
    );

    // 用户已停止：保留已推送内容即可，不再写 done/error
    if (result.aborted || abortController.signal.aborted || res.writableEnded) {
      console.log("chat stopped early, partial response kept on client");
      if (!res.writableEnded) {
        res.end();
      }
      return;
    }

    if (!result.success) {
      stream.error(
        typeof result.message === "string"
          ? result.message
          : "Internal server error",
      );
      return;
    }

    console.log("result", result);
    stream.end(result.response);
  } catch (error) {
    if (abortController.signal.aborted || res.writableEnded) {
      if (!res.writableEnded) {
        res.end();
      }
      return;
    }

    const errMessage =
      error instanceof Error ? error.message : "Internal server error";
    stream.error(errMessage);
  }
});

export default router;
