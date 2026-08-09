import type { Response } from "express";

export type StreamEventType = "chunk" | "done" | "error";

export interface StreamEvent<T = unknown> {
  type: StreamEventType;
  content?: T;
  message?: string;
}

export interface StreamWriter {
  /** 发送一段增量内容 */
  writeChunk: (content: string) => void;
  /** 发送任意自定义事件 */
  writeEvent: <T = unknown>(event: StreamEvent<T>) => void;
  /** 发送完成事件并关闭连接 */
  end: <T = unknown>(data?: T) => void;
  /** 发送错误事件并关闭连接 */
  error: (message: string) => void;
}

/**
 * 初始化 SSE 流式响应，返回写入工具。
 */
export const createStreamResponse = (res: Response): StreamWriter => {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  // 禁用 nginx 等反向代理缓冲，保证实时推送
  res.setHeader("X-Accel-Buffering", "no");

  // Express 4 没有 flushHeaders，有则调用
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  const send = <T = unknown>(event: StreamEvent<T>) => {
    // 客户端已断开时不再写入，避免无意义 I/O 与异常
    if (res.writableEnded || res.destroyed || !res.writable) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    // compression 等中间件提供 flush 时立刻刷出，避免 SSE 被缓冲成整包
    const flushable = res as Response & { flush?: () => void };
    if (typeof flushable.flush === "function") {
      flushable.flush();
    }
  };

  return {
    writeChunk: (content: string) => {
      send({ type: "chunk", content: content });
    },
    writeEvent: (event) => {
      send(event);
    },
    end: (data) => {
      send({ type: "done", content: data });
      if (!res.writableEnded) {
        res.end();
      }
    },
    error: (message: string) => {
      send({ type: "error", message });
      if (!res.writableEnded) {
        res.end();
      }
    },
  };
};
