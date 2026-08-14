/**
 * 认证相关路由：注册、登录、获取当前用户、登出。
 *
 * 账号支持手机号或邮箱；登录成功后签发 JWT（见 utils/jwt）。
 * 若请求携带 clientId，会把匿名会话/行程合并到正式用户名下。
 *
 * 意外错误一律抛出，由 middleware/errorHandler 统一转成 500。
 */
import { Router, type Response } from "express";
import bcrypt from "bcryptjs";
import {
  optionalAuth,
  requireAuth,
  type AuthedRequest,
} from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { signAccessToken } from "../utils/jwt.js";
import * as userStore from "../db/userStore.js";
import * as chatStore from "../db/chatStore.js";
import * as planStore from "../db/planStore.js";

const router = Router();

/** bcrypt 哈希轮数：越高越安全，计算也越慢；10 为常见折中 */
const BCRYPT_ROUNDS = 10;

/** 简单邮箱格式校验（非严格 RFC，够用即可） */
const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

/** 中国大陆手机号：1 开头共 11 位数字 */
const isPhone = (value: string) => /^1\d{10}$/.test(value);

/**
 * 规范化账号输入。
 * - 邮箱：trim + 转小写
 * - 手机号：优先小写后再判断；若失败再对原 trim 值试一次（兼容纯数字）
 * - 非法或空字符串返回 null
 */
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

/**
 * 校验密码：必须是字符串且至少 6 位。
 * 不通过返回 null（调用方统一用业务文案提示）。
 */
const validatePassword = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  if (raw.length < 6) return null;
  return raw;
};

/**
 * 未传昵称时的默认昵称：
 * - 手机号 →「用户」+ 后四位
 * - 邮箱 → @ 前缀；为空则「旅行者」
 */
const defaultNickname = (account: string) => {
  if (isPhone(account)) return `用户${account.slice(-4)}`;
  const name = account.split("@")[0];
  return name || "旅行者";
};

/** 认证接口 body：字段一律当 unknown，交给下面的校验函数收窄 */
type AuthBody = {
  account?: unknown;
  password?: unknown;
  nickname?: unknown;
  clientId?: unknown;
};

const readAuthBody = (body: unknown): AuthBody => {
  return body && typeof body === "object" ? (body as AuthBody) : {};
};

/**
 * 统一签发登录/注册成功响应：
 * 1. 若有 clientId，合并匿名会话与行程到该用户
 * 2. 签发 access token
 * 3. 返回 token、用户信息、合并数量
 */
const issueAuthResponse = (
  res: Response,
  user: { id: string; account: string; nickname: string; createdAt: number },
  clientId?: string,
) => {
  let mergedConversations = 0;
  let mergedPlans = 0;
  // 匿名端 clientId → 正式用户：把本地聊天与行程挂到账号下
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

/**
 * POST /register
 * Body: { account, password, nickname?, clientId? }
 * - account：【必填】手机号或邮箱
 * - password：【必填】至少 6 位
 * - nickname：可选，最长 20；缺省用 defaultNickname
 * - clientId：可选，用于合并匿名数据
 */
router.post(
  "/register",
  asyncHandler((req, res) => {
    const {
      account: accountRaw,
      password: passwordRaw,
      nickname: nicknameRaw,
      clientId: clientIdRaw,
    } = readAuthBody(req.body);
    const account = normalizeAccount(accountRaw);
    const password = validatePassword(passwordRaw);

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

    // 账号唯一：已存在则 409
    if (userStore.findUserByAccount(account)) {
      return res.status(409).json({
        status: "error",
        message: "该账号已注册",
      });
    }

    // 昵称：有有效字符串则截断到 20，否则按账号生成默认昵称
    const nickname =
      typeof nicknameRaw === "string" && nicknameRaw.trim()
        ? nicknameRaw.trim().slice(0, 20)
        : defaultNickname(account);

    // 只存哈希，不存明文密码
    const passwordHash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
    const user = userStore.createUser(account, passwordHash, nickname);
    const clientId =
      typeof clientIdRaw === "string" ? clientIdRaw.trim() : undefined;

    return issueAuthResponse(res, user, clientId || undefined);
  }),
);

/**
 * POST /login
 * Body: { account, password, clientId? }
 * 校验通过后同样走 issueAuthResponse（含匿名数据合并）。
 */
router.post(
  "/login",
  asyncHandler((req, res) => {
    const {
      account: accountRaw,
      password: passwordRaw,
      clientId: clientIdRaw,
    } = readAuthBody(req.body);

    const account = normalizeAccount(accountRaw);
    const password = validatePassword(passwordRaw);

    if (!account || !password) {
      return res.status(400).json({
        status: "error",
        message: "账号或密码格式不正确",
      });
    }

    const row = userStore.findUserByAccount(account);
    /**
     * compareSync 的内部实现步骤：
     * 【1】、解析已存哈希
     * 从类似 $2b$10$salt......hash...... 的字符串里拆出：算法版本、成本（rounds）、盐、真正的哈希结果。
     *
     * 【2】、用同一套参数重算
     * 拿用户这次输入的明文密码，加上第 1 步里取出的同一个盐和同一个 rounds，再跑一遍 bcrypt 哈希。
     *
     * 【3】、比对结果，返回布尔值
     * 把新算出的哈希，和库里存的那一段哈希做比较
     */
    // 账号不存在与密码错误返回同一文案，避免枚举账号
    if (!row || !bcrypt.compareSync(password, row.password_hash)) {
      return res.status(401).json({
        status: "error",
        message: "账号或密码错误",
      });
    }

    // 对外只返回公开字段，不含 password_hash
    const user = {
      id: row.id,
      account: row.account,
      nickname: row.nickname,
      createdAt: row.created_at,
    };
    const clientId =
      typeof clientIdRaw === "string" ? clientIdRaw.trim() : undefined;

    return issueAuthResponse(res, user, clientId || undefined);
  }),
);

/**
 * GET /me
 * 中间件:负责“请求能不能进来、进来时带上什么”
 * requireAuth: 验签、失败返 401、成功把身份挂到 req.user
 * 根据 JWT 中的用户 id 返回公开资料；用户已删则 401。
 */
router.get(
  "/me",
  requireAuth,
  asyncHandler((req: AuthedRequest, res) => {
    const user = userStore.getPublicUserById(req.user!.id);
    if (!user) {
      return res.status(401).json({
        status: "error",
        message: "用户不存在",
      });
    }
    return res.status(200).json({ status: "ok", data: user });
  }),
);

/**
 * POST /logout
 * JWT 无服务端会话态，客户端丢弃 token 即可。
 * optionalAuth：有 token 也可解析，此处不强制登录，便于统一调用。
 */
router.post("/logout", optionalAuth, (_req, res) => {
  return res.status(200).json({ status: "ok" });
});

export default router;
