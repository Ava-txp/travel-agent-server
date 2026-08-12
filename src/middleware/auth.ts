import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

export type AuthUser = {
  id: string;
  account: string;
};

export type AuthedRequest = Request & {
  user?: AuthUser;
};

type JwtPayload = {
  sub: string;
  account: string;
};

const getJwtSecret = (): string => {
  const secret = process.env.JWT_SECRET?.trim();
  if (!secret) {
    throw new Error("JWT_SECRET is not set");
  }
  return secret;
};

/**
 * ============== JWT 签名过程 ==============
  header JSON ──► Base64URL ──┐
                              ├──► "hdr.pay" ──► HMAC-SHA256(密钥) ──► Base64URL ──► signature
  payload JSON ─► Base64URL ──┘
  
  最终(jwt.sign(...args)的返回结果) header.payload.signature ──► JWT Token
 */

/**
 * ============== satisfies 类型检查运算符 ==============
 * 既要符合 JwtPayload，又保留实际推断；字段写错会编译报错
 */
export const signAccessToken = (user: AuthUser): string => {
  const expiresIn = process.env.JWT_EXPIRES_IN?.trim() || "7d";
  return jwt.sign(
    // payload: 写进 token 的内容
    { sub: user.id, account: user.account } satisfies JwtPayload,
    // secretOrPrivateKey: 用来签名的密钥  =>  用 JWT_SECRET 做 HMAC 签名密钥
    getJwtSecret(),
    // options?: 签发选项 => 让 token 在 expiresIn 后过期（默认 7 天）
    { expiresIn } as jwt.SignOptions,
  );
};

export const verifyAccessToken = (token: string): AuthUser | null => {
  try {
    const payload = jwt.verify(token, getJwtSecret()) as JwtPayload;
    if (!payload?.sub || !payload?.account) return null;
    return { id: payload.sub, account: payload.account };
  } catch {
    return null;
  }
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
