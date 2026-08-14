/**
 * 认证中间件：只做「请求能不能进来、进来时带上什么」。
 *
 * 本文件只导出 (req, res, next) 形态的中间件；
 * token 的签发与校验属于纯函数，放在 utils/jwt。
 */
import type { NextFunction, Request, Response } from "express";
import { verifyAccessToken, type AuthUser } from "../utils/jwt.js";

export type AuthedRequest = Request & {
  user?: AuthUser;
};

const readBearer = (req: Request): string | null => {
  const header = req.header("Authorization")?.trim();
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
};

/** 有合法 JWT 则挂 req.user，否则继续匿名 */
export const optionalAuth = (
  req: AuthedRequest,
  _res: Response,
  next: NextFunction,
) => {
  const token = readBearer(req);
  if (token) {
    const user = verifyAccessToken(token);
    if (user) req.user = user;
  }
  next();
};

/** 强制登录 */
export const requireAuth = (
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
) => {
  const token = readBearer(req);
  if (!token) {
    res.status(401).json({ status: "error", message: "Unauthorized" });
    return;
  }
  const user = verifyAccessToken(token);
  if (!user) {
    res
      .status(401)
      .json({ status: "error", message: "Invalid or expired token" });
    return;
  }
  req.user = user;
  next();
};
