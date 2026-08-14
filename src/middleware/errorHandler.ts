/**
 * 统一错误处理：把散落在各 handler 里的 try/catch + 500 收敛到管道末端。
 *
 * 分工约定：
 * - 可预期的业务错误：handler 里直接 res.status(4xx)，或 throw HttpError
 * - 意外错误（数据库挂了、第三方超时…）：直接抛出，由 errorHandler 兜底成 500
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";

/** 可预期错误：message 会原样返回给客户端，因此不要放敏感信息 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * Express 4 只会自动捕获同步 throw，async handler 的 reject 会变成
 * unhandledRejection 并让请求一直挂着，所以要手动转交给 next。
 * 所有 handler 统一包一层，避免以后改成 async 时漏掉。
 */
export const asyncHandler =
  <Req extends Request = Request>(
    handler: (req: Req, res: Response, next: NextFunction) => unknown,
  ): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(handler(req as Req, res, next)).catch(next);
  };

/**
 * 识别「可以直接告诉客户端」的错误。
 * 除了自己抛的 HttpError，express.json() 等中间件抛的错误遵循 http-errors 约定：
 * 带 status/statusCode，且 expose 为 true 表示 message 不含敏感信息。
 */
const readClientError = (
  err: unknown,
): { status: number; message: string } | null => {
  if (err instanceof HttpError) {
    return { status: err.status, message: err.message };
  }
  if (typeof err !== "object" || err === null) return null;

  const { status, statusCode, expose, message } = err as Record<
    string,
    unknown
  >;
  const code = typeof status === "number" ? status : statusCode;
  if (
    typeof code === "number" &&
    code >= 400 &&
    code < 500 &&
    expose === true &&
    typeof message === "string"
  ) {
    return { status: code, message };
  }
  return null;
};

/** 四个参数是 Express 识别错误中间件的唯一依据，_next 不可省略 */
export const errorHandler = (
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) => {
  const clientError = readClientError(err);
  if (clientError) {
    res
      .status(clientError.status)
      .json({ status: "error", message: clientError.message });
    return;
  }

  console.error(`[${req.method} ${req.originalUrl}] unhandled error:`, err);

  // SSE 等已开始写响应的场景无法再改状态码，只能断开连接
  if (res.headersSent) {
    res.end();
    return;
  }

  res.status(500).json({
    status: "error",
    message: "服务异常，请稍后重试",
  });
};
