/** 识别上游 LLM / HTTP 的限流、超时与取消，供路由映射给前端。 */

export const isAbortError = (error: unknown, signal?: AbortSignal): boolean => {
  if (signal?.aborted) return true;
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String(error.name) : "";
  const message = "message" in error ? String(error.message) : "";
  return name === "AbortError" || /abor(t|ted)/i.test(message);
};

const readNestedStatus = (value: unknown): number | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const rec = value as Record<string, unknown>;
  if (typeof rec.status === "number") return rec.status;
  if (typeof rec.statusCode === "number") return rec.statusCode;
  return undefined;
};

export const readHttpStatus = (error: unknown): number | undefined => {
  const direct = readNestedStatus(error);
  if (direct) return direct;
  if (!error || typeof error !== "object") return undefined;
  return readNestedStatus((error as { error?: unknown }).error);
};

export const isRateLimitError = (error: unknown): boolean => {
  if (readHttpStatus(error) === 429) return true;
  const msg = error instanceof Error ? error.message : String(error ?? "");
  return /429|rate limit|too many requests/i.test(msg);
};

export const isTimeoutError = (error: unknown): boolean => {
  if (readHttpStatus(error) === 408 || readHttpStatus(error) === 504) {
    return true;
  }
  const msg = error instanceof Error ? error.message : String(error ?? "");
  return /timeout|ETIMEDOUT|ECONNABORTED/i.test(msg);
};

export const readRetryAfterSec = (error: unknown): number | undefined => {
  if (!error || typeof error !== "object") return undefined;
  const rec = error as Record<string, unknown>;
  const headers = rec.headers as Record<string, unknown> | undefined;
  const raw =
    headers?.["retry-after"] ?? headers?.["Retry-After"] ?? rec.retryAfter;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : undefined;
};
