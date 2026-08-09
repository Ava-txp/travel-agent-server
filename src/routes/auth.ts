import { Router, type Response } from "express";
import bcrypt from "bcryptjs";
import {
  optionalAuth,
  requireAuth,
  signAccessToken,
  type AuthedRequest,
} from "../middleware/auth.js";
import * as userStore from "../db/userStore.js";
import * as chatStore from "../db/chatStore.js";
import * as planStore from "../db/planStore.js";

const router = Router();
const BCRYPT_ROUNDS = 10;

const isEmail = (value: string) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const isPhone = (value: string) => /^1\d{10}$/.test(value);

const normalizeAccount = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  const account = raw.trim().toLowerCase();
  if (!account) return null;
  if (isEmail(account) || isPhone(account)) return account;
  // 手机号大小写不敏感已 lower；纯数字手机再试一次原 trim
  const trimmed = raw.trim();
  if (isPhone(trimmed)) return trimmed;
  return null;
};

const validatePassword = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  if (raw.length < 6) return null;
  return raw;
};

const defaultNickname = (account: string) => {
  if (isPhone(account)) return `用户${account.slice(-4)}`;
  const name = account.split("@")[0];
  return name || "旅行者";
};

const issueAuthResponse = (
  res: Response,
  user: { id: string; account: string; nickname: string; createdAt: number },
  clientId?: string,
) => {
  let mergedConversations = 0;
  let mergedPlans = 0;
  if (clientId) {
    mergedConversations = chatStore.mergeAnonymousConversations(
      user.id,
      clientId,
    );
    mergedPlans = planStore.mergeAnonymousPlans(user.id, clientId);
  }

  const token = signAccessToken({ id: user.id, account: user.account });
  return res.status(200).json({
    status: "ok",
    data: {
      token,
      user,
      mergedConversations,
      mergedPlans,
    },
  });
};

router.post("/register", (req, res) => {
  try {
    const account = normalizeAccount((req.body as { account?: unknown })?.account);
    const password = validatePassword(
      (req.body as { password?: unknown })?.password,
    );
    const nicknameRaw = (req.body as { nickname?: unknown })?.nickname;
    const clientIdRaw = (req.body as { clientId?: unknown })?.clientId;

    if (!account) {
      return res.status(400).json({
        status: "error",
        message: "请输入有效的手机号或邮箱",
      });
    }
    if (!password) {
      return res.status(400).json({
        status: "error",
        message: "密码至少 6 位",
      });
    }

    if (userStore.findUserByAccount(account)) {
      return res.status(409).json({
        status: "error",
        message: "该账号已注册",
      });
    }

    const nickname =
      typeof nicknameRaw === "string" && nicknameRaw.trim()
        ? nicknameRaw.trim().slice(0, 20)
        : defaultNickname(account);

    const passwordHash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
    const user = userStore.createUser(account, passwordHash, nickname);
    const clientId =
      typeof clientIdRaw === "string" ? clientIdRaw.trim() : undefined;

    return issueAuthResponse(res, user, clientId || undefined);
  } catch (error) {
    console.error("register failed:", error);
    return res.status(500).json({
      status: "error",
      message: "注册失败，请稍后重试",
    });
  }
});

router.post("/login", (req, res) => {
  try {
    const account = normalizeAccount((req.body as { account?: unknown })?.account);
    const password = validatePassword(
      (req.body as { password?: unknown })?.password,
    );
    const clientIdRaw = (req.body as { clientId?: unknown })?.clientId;

    if (!account || !password) {
      return res.status(400).json({
        status: "error",
        message: "账号或密码格式不正确",
      });
    }

    const row = userStore.findUserByAccount(account);
    if (!row || !bcrypt.compareSync(password, row.password_hash)) {
      return res.status(401).json({
        status: "error",
        message: "账号或密码错误",
      });
    }

    const user = {
      id: row.id,
      account: row.account,
      nickname: row.nickname,
      createdAt: row.created_at,
    };
    const clientId =
      typeof clientIdRaw === "string" ? clientIdRaw.trim() : undefined;

    return issueAuthResponse(res, user, clientId || undefined);
  } catch (error) {
    console.error("login failed:", error);
    return res.status(500).json({
      status: "error",
      message: "登录失败，请稍后重试",
    });
  }
});

router.get("/me", requireAuth, (req: AuthedRequest, res) => {
  const user = userStore.getPublicUserById(req.user!.id);
  if (!user) {
    return res.status(401).json({
      status: "error",
      message: "用户不存在",
    });
  }
  return res.status(200).json({ status: "ok", data: user });
});

router.post("/logout", optionalAuth, (_req, res) => {
  return res.status(200).json({ status: "ok" });
});

export default router;
