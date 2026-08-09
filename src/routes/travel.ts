import { Router, type Response } from "express";
import travelService from "../service/travelService.js";
import { createStreamResponse } from "../utils/streamUtils.js";
import * as chatStore from "../db/chatStore.js";
import type { ConversationOwner } from "../db/chatStore.js";
import * as planStore from "../db/planStore.js";
import { reverseGeocode } from "../agent/tools.js";
import { optionalAuth, type AuthedRequest } from "../middleware/auth.js";

const router = Router();

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

router.post("/recommend", optionalAuth, async (req: AuthedRequest, res) => {
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

    // 规划成功后落库，便于「规划记录」查询
    let data: unknown = result;
    const isSuccess =
      result &&
      typeof result === "object" &&
      (result as { success?: unknown }).success !== false;

    if (isSuccess) {
      const clientId = req.header("X-Client-Id")?.trim();
      if (clientId) {
        try {
          const planResult = result as {
            city?: string;
            days?: number;
            totalBudget?: number;
          };
          const saved = planStore.createPlan(
            { clientId, userId: req.user?.id ?? null },
            {
              city: planResult.city || String(city),
              days: Number(planResult.days) || Number(days),
              totalBudget:
                Number(planResult.totalBudget) || Number(budget),
              content: result,
            },
          );
          data = { ...(result as object), id: saved.id };
        } catch (saveError) {
          console.error("保存规划记录失败", saveError);
        }
      }
    }

    return res.status(200).json({
      status: "ok",
      data,
    });
  } catch {
    return res.status(500).json({
      status: "error",
      message: "Internal server error",
    });
  }
});

router.post("/chat", optionalAuth, async (req: AuthedRequest, res) => {
  const owner = resolveOwner(req, res);
  if (!owner) return;

  const { message, conversationId, location } = (req.body ?? {}) as {
    message?: string;
    conversationId?: string;
    location?: {
      lat?: unknown;
      lon?: unknown;
      accuracy?: unknown;
      city?: unknown;
      displayName?: unknown;
    };
  };

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
    message,
    "conversationId",
    conversationId,
    "userId",
    owner.userId,
    "location",
    parsedLocation,
  );

  if (!message?.trim()) {
    return res.status(400).json({
      status: "error",
      message: "Missing required field: message",
    });
  }

  let conversation = conversationId
    ? chatStore.getConversation(conversationId, owner)
    : null;

  if (conversationId && !conversation) {
    return res.status(404).json({
      status: "error",
      message: "Conversation not found",
    });
  }

  if (!conversation) {
    conversation = chatStore.createConversation(
      owner,
      chatStore.truncateTitle(message),
    );
  }

  const existingMessages = chatStore.listMessages(conversation.id);
  const isFirstUserMessage = existingMessages.length === 0;
  chatStore.addMessage(conversation.id, "user", message);

  if (isFirstUserMessage) {
    chatStore.touchConversation(
      conversation.id,
      owner,
      chatStore.truncateTitle(message),
    );

    const conversationIdForTitle = conversation.id;
    const firstUserMessage = message;
    void (async () => {
      const summary = await travelService.summarizeTitle(firstUserMessage);
      if (!summary) return;
      chatStore.touchConversation(
        conversationIdForTitle,
        owner,
        chatStore.truncateTitle(summary),
      );
    })();
  } else {
    chatStore.touchConversation(conversation.id, owner);
  }

  const recent = chatStore.listRecentMessages(
    conversation.id,
    chatStore.MAX_CHAT_HISTORY,
  );
  const historyForLlm =
    recent.length > 0 && recent[recent.length - 1]?.role === "user"
      ? recent.slice(0, -1)
      : recent;

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
      message,
      history: historyForLlm.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      location: parsedLocation,
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
