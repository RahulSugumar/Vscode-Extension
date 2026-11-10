import { create } from "zustand";
import { Message } from "../types";
import { sendChatPrompt, subscribeToChatTokens } from "../services/chatService";

type Status = "idle" | "sending" | "error";

interface ChatState {
  messages: Message[];
  status: Status;
  error: string | null;
  sessionId: string;
  addMessage: (message: Message) => void;
  sendMessage: (text: string) => Promise<void>;
  clear: () => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  status: "idle",
  error: null,
  sessionId: `session_${Date.now()}`,

  addMessage: (message) =>
    set((state) => ({ messages: [...state.messages, message] })),

  sendMessage: async (text: string) => {
    const sessionId = get().sessionId;
    const createdAt = Date.now();
    const agentMsgId = `${createdAt}_a`;
    const userMsg: Message = {
      id: `${createdAt}_u`,
      sender: "user",
      text,
      timestamp: createdAt,
    };

    get().addMessage(userMsg);
    set({ status: "sending", error: null });

    let pendingText = "";
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const appendTokenToMessage = (token: string) => {
      if (!token) return;
      set((state) => {
        const existing = state.messages.find(
          (message) => message.id === agentMsgId,
        );
        if (!existing) {
          return {
            messages: [
              ...state.messages,
              {
                id: agentMsgId,
                sender: "agent",
                text: token,
                timestamp: Date.now(),
              },
            ],
          };
        }

        return {
          messages: state.messages.map((message) =>
            message.id === agentMsgId
              ? { ...message, text: message.text + token }
              : message,
          ),
        };
      });
    };

    const cancelFlushTimer = () => {
      if (!flushTimer) return;
      clearTimeout(flushTimer);
      flushTimer = null;
    };

    const nextFlushSize = () => {
      if (pendingText.length > 160) return 14;
      if (pendingText.length > 80) return 9;
      return 4;
    };

    const flushBufferedText = () => {
      flushTimer = null;
      if (!pendingText) return;
      const size = nextFlushSize();
      const next = pendingText.slice(0, size);
      pendingText = pendingText.slice(size);
      appendTokenToMessage(next);
      if (pendingText) scheduleFlush();
    };

    const scheduleFlush = () => {
      if (flushTimer) return;
      flushTimer = setTimeout(flushBufferedText, 18);
    };

    const appendToken = (token: string) => {
      if (!token) return;
      pendingText += token;
      scheduleFlush();
    };

    const drainBufferedText = async () => {
      cancelFlushTimer();
      while (pendingText) {
        const size = nextFlushSize();
        const next = pendingText.slice(0, size);
        pendingText = pendingText.slice(size);
        appendTokenToMessage(next);
        await new Promise((resolve) => setTimeout(resolve, 12));
      }
    };

    const unsubscribe = subscribeToChatTokens(sessionId, appendToken);

    try {
      const reply = await sendChatPrompt(sessionId, text);
      await drainBufferedText();
      set((state) => {
        const existing = state.messages.find(
          (message) => message.id === agentMsgId,
        );
        const finalText = reply.trim()
          ? reply
          : (existing?.text ?? "No response generated.");

        if (!existing) {
          return {
            messages: [
              ...state.messages,
              {
                id: agentMsgId,
                sender: "agent",
                text: finalText,
                timestamp: Date.now(),
              },
            ],
            status: "idle",
            error: null,
          };
        }

        return {
          messages: state.messages.map((message) =>
            message.id === agentMsgId
              ? { ...message, text: finalText }
              : message,
          ),
          status: "idle",
          error: null,
        };
      });
    } catch (e) {
      set({
        status: "error",
        error: e instanceof Error ? e.message : "Failed to send message",
      });
    } finally {
      cancelFlushTimer();
      unsubscribe();
    }
  },

  clear: () =>
    set({
      messages: [],
      sessionId: `session_${Date.now()}`,
      status: "idle",
      error: null,
    }),
}));
