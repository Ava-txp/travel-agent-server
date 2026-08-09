import { Router, type Request, type Response } from "express";
import travelService from "../service/travelService.js";
import { createStreamResponse } from "../utils/streamUtils.js";
import * as chatStore from "../db/chatStore.js";

const router = Router();

const requireClientId = (req: Request, res: Response): string | null => {
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
  const clientId = requireClientId(req, res);
  if (!clientId) return;

  const { message, conversationId } = (req.body ?? {}) as {
    message?: string;
    conversationId?: string;
  };

  console.log("message", message, "conversationId", conversationId);

  if (!message?.trim()) {
    return res.status(400).json({
      status: "error",
      message: "Missing required field: message",
    });
  }

  let conversation = conversationId
    ? chatStore.getConversation(conversationId, clientId)
    : null;

  if (conversationId && !conversation) {
    return res.status(404).json({
      status: "error",
      message: "Conversation not found",
    });
  }

  if (!conversation) {
    conversation = chatStore.createConversation(
      clientId,
      chatStore.truncateTitle(message),
    );
  }

  // 先落库用户消息；首条消息先用截断标题占位，再异步 LLM 总结更新
  const existingMessages = chatStore.listMessages(conversation.id);
  const isFirstUserMessage = existingMessages.length === 0;
  chatStore.addMessage(conversation.id, "user", message);

  if (isFirstUserMessage) {
    chatStore.touchConversation(
      conversation.id,
      clientId,
      chatStore.truncateTitle(message),
    );

    const conversationIdForTitle = conversation.id;
    const firstUserMessage = message;
    void (async () => {
      const summary = await travelService.summarizeTitle(firstUserMessage);
      if (!summary) return;
      chatStore.touchConversation(
        conversationIdForTitle,
        clientId,
        chatStore.truncateTitle(summary),
      );
    })();
  } else {
    chatStore.touchConversation(conversation.id, clientId);
  }

  // 读最近历史，并去掉刚写入的本轮 user（chat 会单独追加本轮 message）
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
      streamCallback: (chunk) => {
        if (abortController.signal.aborted || res.writableEnded) return;
        stream.writeChunk(chunk);
      },
      signal: abortController.signal,
    });

    // abort 后仍落库已生成的部分 assistant 文本；可不写 done
    if (result.response?.trim()) {
      chatStore.addMessage(conversationIdForDone, "assistant", result.response);
      chatStore.touchConversation(conversationIdForDone, clientId);
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

router.get("/conversations", (req: Request, res: Response) => {
  const clientId = requireClientId(req, res);
  if (!clientId) return;

  const data = chatStore.listConversations(clientId);
  return res.status(200).json({ status: "ok", data });
});

router.get("/conversations/:id", (req: Request, res: Response) => {
  const clientId = requireClientId(req, res);
  if (!clientId) return;

  const id = String(req.params.id);
  const detail = chatStore.getConversationDetail(id, clientId);
  if (!detail) {
    return res.status(404).json({
      status: "error",
      message: "Conversation not found",
    });
  }

  return res.status(200).json({ status: "ok", data: detail });
});

router.post("/conversations", (req: Request, res: Response) => {
  const clientId = requireClientId(req, res);
  if (!clientId) return;

  const conversation = chatStore.createConversation(clientId, "新对话");
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

router.delete("/conversations/:id", (req: Request, res: Response) => {
  const clientId = requireClientId(req, res);
  if (!clientId) return;

  const id = String(req.params.id);
  const deleted = chatStore.deleteConversation(id, clientId);
  if (!deleted) {
    return res.status(404).json({
      status: "error",
      message: "Conversation not found",
    });
  }

  return res.status(200).json({ status: "ok" });
});

router.patch("/conversations/:id", (req: Request, res: Response) => {
  const clientId = requireClientId(req, res);
  if (!clientId) return;

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

  if (!chatStore.getConversation(id, clientId)) {
    return res.status(404).json({
      status: "error",
      message: "Conversation not found",
    });
  }

  if (hasTitle) {
    const renamed = chatStore.renameConversation(id, clientId, title);
    if (!renamed) {
      return res.status(400).json({
        status: "error",
        message: "Title cannot be empty",
      });
    }
  }

  if (hasPinned) {
    chatStore.setConversationPinned(id, clientId, pinned);
  }

  const conversation = chatStore.getConversation(id, clientId);
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

export default router;
