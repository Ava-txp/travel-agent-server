import { Router, type Response } from "express";
import multer from "multer";
import { imageSize } from "image-size";
import travelService from "../service/travelService.js";
import { createStreamResponse } from "../utils/streamUtils.js";
import { prepareChatContext } from "../utils/contextWindow.js";
import * as chatStore from "../db/chatStore.js";
import type { ChatSceneHint, ConversationOwner } from "../db/chatStore.js";
import * as planStore from "../db/planStore.js";
import * as uploadStore from "../db/uploadStore.js";
import { sceneHintTitle } from "../agent/scenes.js";
import { reverseGeocode } from "../agent/tools.js";
import { optionalAuth, type AuthedRequest } from "../middleware/auth.js";
import { handleRecommendStream } from "./recommend.js";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: uploadStore.MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (uploadStore.ALLOWED_IMAGE_MIMES.has(file.mimetype.toLowerCase())) {
      cb(null, true);
      return;
    }
    cb(new Error("仅支持 JPEG / PNG / WebP 图片"));
  },
});

const requireClientId = (req: AuthedRequest, res: Response): string | null => {
  const clientId = req.header("X-Client-Id")?.trim();
  if (!clientId) {
    res.status(400).json({
      status: "error",
      message: "Missing required header: X-Client-Id",
    });
    return null;
  }
  return clientId;
};

const resolveOwner = (
  req: AuthedRequest,
  res: Response,
): ConversationOwner | null => {
  const clientId = requireClientId(req, res);
  if (!clientId) return null;
  return {
    clientId,
    userId: req.user?.id ?? null,
  };
};

const parseSceneHint = (value: unknown): ChatSceneHint | null => {
  if (
    value === "spot_sign" ||
    value === "ticket_itinerary" ||
    value === "food_menu"
  ) {
    return value;
  }
  return null;
};

router.post("/recommend", optionalAuth, handleRecommendStream);

/** 上传聊天图片：multipart field = file */
router.post(
  "/uploads/image",
  optionalAuth,
  (req: AuthedRequest, res, next) => {
    upload.single("file")(req, res, (err: unknown) => {
      if (!err) {
        next();
        return;
      }
      const message =
        err instanceof Error ? err.message : "上传失败";
      const isSize =
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code?: string }).code === "LIMIT_FILE_SIZE";
      res.status(400).json({
        status: "error",
        message: isSize ? "图片过大，最大 5MB" : message,
      });
    });
  },
  (req: AuthedRequest, res) => {
    const owner = resolveOwner(req, res);
    if (!owner) return;

    const file = req.file;
    if (!file?.buffer?.length) {
      return res.status(400).json({
        status: "error",
        message: "Missing file field: file",
      });
    }

    try {
      let width: number | undefined;
      let height: number | undefined;
      try {
        const dim = imageSize(file.buffer);
        if (dim.width) width = dim.width;
        if (dim.height) height = dim.height;
      } catch {
        // 尺寸解析失败不阻断上传
      }

      const saved = uploadStore.saveUpload({
        owner,
        buffer: file.buffer,
        mime: file.mimetype,
        width,
        height,
      });

      return res.status(200).json({
        status: "ok",
        data: {
          id: saved.id,
          url: saved.url,
          mime: saved.mime,
          width: saved.width,
          height: saved.height,
        },
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "图片上传失败";
      return res.status(400).json({
        status: "error",
        message,
      });
    }
  },
);

/** 读取已上传图片（供 H5 展示；UUID 不透明） */
router.get("/uploads/files/:id", (req, res) => {
  const id = String(req.params.id || "");
  const row = uploadStore.getUploadById(id);
  if (!row) {
    return res.status(404).json({
      status: "error",
      message: "File not found",
    });
  }

  const filePath = uploadStore.absoluteUploadPath(row.filename);
  res.setHeader("Content-Type", row.mime);
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  return res.sendFile(filePath);
});

router.post("/chat", optionalAuth, async (req: AuthedRequest, res) => {
  const owner = resolveOwner(req, res);
  if (!owner) return;

  const { message, conversationId, location, attachments, sceneHint } =
    (req.body ?? {}) as {
      message?: string;
      conversationId?: string;
      location?: {
        lat?: unknown;
        lon?: unknown;
        accuracy?: unknown;
        city?: unknown;
        displayName?: unknown;
      };
      attachments?: Array<{ id?: unknown; type?: unknown }>;
      sceneHint?: unknown;
    };

  const text = typeof message === "string" ? message.trim() : "";
  const parsedSceneHint = parseSceneHint(sceneHint);

  const attachmentIds = Array.isArray(attachments)
    ? attachments
        .filter(
          (item) =>
            item &&
            typeof item.id === "string" &&
            item.id.trim() &&
            (item.type === undefined || item.type === "image"),
        )
        .map((item) => String(item.id).trim())
        .slice(0, 3)
    : [];

  if (!text && attachmentIds.length === 0) {
    return res.status(400).json({
      status: "error",
      message: "Missing required field: message or attachments",
    });
  }

  const resolvedAttachments: uploadStore.ChatAttachment[] = [];
  const imageDataUrls: string[] = [];
  for (const id of attachmentIds) {
    const row = uploadStore.getOwnedUpload(id, owner);
    if (!row) {
      return res.status(400).json({
        status: "error",
        message: `Invalid attachment: ${id}`,
      });
    }
    resolvedAttachments.push(uploadStore.toChatAttachment(row));
    try {
      imageDataUrls.push(uploadStore.readUploadAsDataUrl(row));
    } catch (error) {
      console.error("read upload failed", id, error);
      return res.status(500).json({
        status: "error",
        message: "Failed to read attachment",
      });
    }
  }

  const parsedLocation =
    location &&
    typeof location.lat === "number" &&
    typeof location.lon === "number" &&
    Number.isFinite(location.lat) &&
    Number.isFinite(location.lon)
      ? {
          lat: location.lat,
          lon: location.lon,
          ...(typeof location.accuracy === "number"
            ? { accuracy: location.accuracy }
            : {}),
          ...(typeof location.city === "string" && location.city.trim()
            ? { city: location.city.trim() }
            : {}),
          ...(typeof location.displayName === "string" &&
          location.displayName.trim()
            ? { displayName: location.displayName.trim() }
            : {}),
        }
      : null;

  console.log(
    "message",
    text,
    "conversationId",
    conversationId,
    "userId",
    owner.userId,
    "location",
    parsedLocation,
    "attachments",
    resolvedAttachments.map((a) => a.id),
    "sceneHint",
    parsedSceneHint,
  );

  let conversation = conversationId
    ? chatStore.getConversation(conversationId, owner)
    : null;

  if (conversationId && !conversation) {
    return res.status(404).json({
      status: "error",
      message: "Conversation not found",
    });
  }

  const fallbackTitle = text
    ? chatStore.truncateTitle(text)
    : sceneHintTitle(parsedSceneHint);

  if (!conversation) {
    conversation = chatStore.createConversation(owner, fallbackTitle);
  }

  const existingMessages = chatStore.listMessages(conversation.id);
  const isFirstUserMessage = existingMessages.length === 0;
  chatStore.addMessage(conversation.id, "user", text, {
    attachments: resolvedAttachments.length
      ? resolvedAttachments
      : undefined,
    sceneHint: parsedSceneHint ?? undefined,
  });

  if (isFirstUserMessage) {
    chatStore.touchConversation(conversation.id, owner, fallbackTitle);

    if (text) {
      const conversationIdForTitle = conversation.id;
      const firstUserMessage = text;
      void (async () => {
        const summary = await travelService.summarizeTitle(firstUserMessage);
        if (!summary) return;
        chatStore.touchConversation(
          conversationIdForTitle,
          owner,
          chatStore.truncateTitle(summary),
        );
      })();
    }
  } else {
    chatStore.touchConversation(conversation.id, owner);
  }

  // 先取较宽的候选历史（条数上限），再按 token 预算做滑动窗口 / 摘要压缩
  const recent = chatStore.listRecentMessages(
    conversation.id,
    Math.max(chatStore.MAX_CHAT_HISTORY, 40),
  );
  const historyRaw =
    recent.length > 0 && recent[recent.length - 1]?.role === "user"
      ? recent.slice(0, -1)
      : recent;
  const historyMapped = historyRaw.map((m) => ({
    role: m.role,
    content:
      m.content || (m.attachments?.length ? "[用户上传了图片]" : ""),
  }));

  const { history: historyForLlm, stats: contextStats } =
    await prepareChatContext({
      history: historyMapped,
      currentMessage: text,
      summarizeFn: (dropped) => travelService.summarizeHistory(dropped),
    });

  const stream = createStreamResponse(res);
  const abortController = new AbortController();

  const abortFromClient = () => {
    if (!abortController.signal.aborted) {
      console.log("client disconnected, aborting LLM stream");
      abortController.abort();
    }
  };

  res.on("close", () => {
    if (!res.writableFinished) {
      abortFromClient();
    }
  });

  const conversationIdForDone = conversation.id;

  try {
    const result = await travelService.chat({
      message: text,
      history: historyForLlm,
      location: parsedLocation,
      imageDataUrls,
      sceneHint: parsedSceneHint,
      streamCallback: (chunk) => {
        if (abortController.signal.aborted || res.writableEnded) return;
        stream.writeChunk(chunk);
      },
      signal: abortController.signal,
    });

    if (result.response?.trim()) {
      chatStore.addMessage(conversationIdForDone, "assistant", result.response);
      chatStore.touchConversation(conversationIdForDone, owner);
    }

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

    stream.end({
      conversationId: conversationIdForDone,
      content: result.response,
      usage: {
        estimatedInputTokens: contextStats.estimatedTotalInputTokens,
        historyBeforeTokens: contextStats.historyBeforeTokens,
        historyAfterTokens: contextStats.historyAfterTokens,
        keptMessages: contextStats.keptMessages,
        droppedMessages: contextStats.droppedMessages,
        summarized: contextStats.summarized,
      },
    });
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

router.get("/location/reverse", optionalAuth, async (req: AuthedRequest, res) => {
  const clientId = requireClientId(req, res);
  if (!clientId) return;

  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({
      status: "error",
      message: "Missing or invalid query: lat, lon",
    });
  }

  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return res.status(400).json({
      status: "error",
      message: "lat/lon out of range",
    });
  }

  try {
    const result = await reverseGeocode(lat, lon);
    return res.status(200).json({
      status: "ok",
      data: {
        lat,
        lon,
        city: result.city,
        displayName: result.displayName,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Reverse geocode failed";
    return res.status(502).json({
      status: "error",
      message,
    });
  }
});

router.get("/conversations", optionalAuth, (req: AuthedRequest, res) => {
  const owner = resolveOwner(req, res);
  if (!owner) return;

  const data = chatStore.listConversations(owner);
  return res.status(200).json({ status: "ok", data });
});

router.get("/conversations/:id", optionalAuth, (req: AuthedRequest, res) => {
  const owner = resolveOwner(req, res);
  if (!owner) return;

  const id = String(req.params.id);
  const detail = chatStore.getConversationDetail(id, owner);
  if (!detail) {
    return res.status(404).json({
      status: "error",
      message: "Conversation not found",
    });
  }

  return res.status(200).json({ status: "ok", data: detail });
});

router.post("/conversations", optionalAuth, (req: AuthedRequest, res) => {
  const owner = resolveOwner(req, res);
  if (!owner) return;

  const conversation = chatStore.createConversation(owner, "新对话");
  return res.status(200).json({
    status: "ok",
    data: {
      id: conversation.id,
      title: conversation.title,
      createdAt: conversation.created_at,
      updatedAt: conversation.updated_at,
    },
  });
});

router.delete("/conversations/:id", optionalAuth, (req: AuthedRequest, res) => {
  const owner = resolveOwner(req, res);
  if (!owner) return;

  const id = String(req.params.id);
  const deleted = chatStore.deleteConversation(id, owner);
  if (!deleted) {
    return res.status(404).json({
      status: "error",
      message: "Conversation not found",
    });
  }

  return res.status(200).json({ status: "ok" });
});

router.patch("/conversations/:id", optionalAuth, (req: AuthedRequest, res) => {
  const owner = resolveOwner(req, res);
  if (!owner) return;

  const id = String(req.params.id);
  const { title, pinned } = (req.body || {}) as {
    title?: unknown;
    pinned?: unknown;
  };

  const hasTitle = typeof title === "string";
  const hasPinned = typeof pinned === "boolean";
  if (!hasTitle && !hasPinned) {
    return res.status(400).json({
      status: "error",
      message: "Nothing to update",
    });
  }

  if (!chatStore.getConversation(id, owner)) {
    return res.status(404).json({
      status: "error",
      message: "Conversation not found",
    });
  }

  if (hasTitle) {
    const renamed = chatStore.renameConversation(id, owner, title);
    if (!renamed) {
      return res.status(400).json({
        status: "error",
        message: "Title cannot be empty",
      });
    }
  }

  if (hasPinned) {
    chatStore.setConversationPinned(id, owner, pinned);
  }

  const conversation = chatStore.getConversation(id, owner);
  if (!conversation) {
    return res.status(404).json({
      status: "error",
      message: "Conversation not found",
    });
  }

  return res.status(200).json({
    status: "ok",
    data: {
      id: conversation.id,
      title: conversation.title,
      pinned: conversation.pinned === 1,
      updatedAt: conversation.updated_at,
    },
  });
});

router.get("/plans", optionalAuth, (req: AuthedRequest, res) => {
  const owner = resolveOwner(req, res);
  if (!owner) return;

  const data = planStore.listPlans(owner);
  return res.status(200).json({ status: "ok", data });
});

router.get("/plans/:id", optionalAuth, (req: AuthedRequest, res) => {
  const owner = resolveOwner(req, res);
  if (!owner) return;

  const id = String(req.params.id);
  const detail = planStore.getPlanDetail(id, owner);
  if (!detail) {
    return res.status(404).json({
      status: "error",
      message: "Plan not found",
    });
  }

  return res.status(200).json({ status: "ok", data: detail });
});

router.delete("/plans/:id", optionalAuth, (req: AuthedRequest, res) => {
  const owner = resolveOwner(req, res);
  if (!owner) return;

  const id = String(req.params.id);
  const deleted = planStore.deletePlan(id, owner);
  if (!deleted) {
    return res.status(404).json({
      status: "error",
      message: "Plan not found",
    });
  }

  return res.status(200).json({ status: "ok" });
});

export default router;
