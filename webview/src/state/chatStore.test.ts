import { beforeEach, describe, expect, it, vi } from "vitest";

const chatServiceMocks = vi.hoisted(() => ({
  sendChatPrompt: vi.fn(),
  subscribeToChatTokens: vi.fn(),
}));

vi.mock("../services/chatService", () => chatServiceMocks);

import { useChatStore } from "./chatStore";

const initialState = useChatStore.getState();

beforeEach(() => {
  vi.useRealTimers();
  chatServiceMocks.sendChatPrompt.mockReset();
  chatServiceMocks.subscribeToChatTokens.mockReset();
  chatServiceMocks.subscribeToChatTokens.mockReturnValue(vi.fn());
  useChatStore.setState({
    ...initialState,
    messages: [],
    status: "idle",
    error: null,
    sessionId: "session-test",
  });
});

describe("chatStore", () => {
  it("adds and clears messages while rotating the session id", () => {
    useChatStore.getState().addMessage({
      id: "m1",
      sender: "user",
      text: "Hello",
      timestamp: 1,
    });
    expect(useChatStore.getState().messages).toHaveLength(1);

    vi.spyOn(Date, "now").mockReturnValue(99);
    useChatStore.setState({ status: "error", error: "old" });
    useChatStore.getState().clear();
    expect(useChatStore.getState()).toMatchObject({
      messages: [],
      status: "idle",
      error: null,
      sessionId: "session_99",
    });
  });

  it("adds the user and final agent messages and always unsubscribes", async () => {
    const unsubscribe = vi.fn();
    chatServiceMocks.subscribeToChatTokens.mockReturnValue(unsubscribe);
    chatServiceMocks.sendChatPrompt.mockResolvedValue("Final answer");
    vi.spyOn(Date, "now").mockReturnValue(100);

    await useChatStore.getState().sendMessage("Question");

    expect(chatServiceMocks.subscribeToChatTokens).toHaveBeenCalledWith(
      "session-test",
      expect.any(Function),
    );
    expect(chatServiceMocks.sendChatPrompt).toHaveBeenCalledWith(
      "session-test",
      "Question",
    );
    expect(useChatStore.getState()).toMatchObject({ status: "idle", error: null });
    expect(useChatStore.getState().messages).toEqual([
      { id: "100_u", sender: "user", text: "Question", timestamp: 100 },
      { id: "100_a", sender: "agent", text: "Final answer", timestamp: 100 },
    ]);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("buffers streamed tokens, ignores empty tokens, and keeps them for an empty final reply", async () => {
    vi.useFakeTimers();
    let onToken: ((text: string) => void) | undefined;
    const unsubscribe = vi.fn();
    chatServiceMocks.subscribeToChatTokens.mockImplementation((_session, listener) => {
      onToken = listener;
      return unsubscribe;
    });
    let resolveReply: ((reply: string) => void) | undefined;
    chatServiceMocks.sendChatPrompt.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveReply = resolve;
      }),
    );
    vi.spyOn(Date, "now").mockReturnValue(200);

    const sending = useChatStore.getState().sendMessage("Stream");
    onToken?.("");
    onToken?.("streamed text");
    await vi.advanceTimersByTimeAsync(18);
    expect(useChatStore.getState().messages[1]?.text).toBe("stre");

    resolveReply?.("   ");
    await vi.runAllTimersAsync();
    await sending;

    expect(useChatStore.getState().messages[1]?.text).toBe("streamed text");
    expect(useChatStore.getState().status).toBe("idle");
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("uses a fallback when neither streaming nor the final response has text", async () => {
    chatServiceMocks.sendChatPrompt.mockResolvedValue(" ");
    await useChatStore.getState().sendMessage("Question");
    expect(useChatStore.getState().messages[1]?.text).toBe("No response generated.");
  });

  it.each([
    [new Error("Network down"), "Network down"],
    ["bad", "Failed to send message"],
  ])("records send failures and unsubscribes", async (failure, expected) => {
    const unsubscribe = vi.fn();
    chatServiceMocks.subscribeToChatTokens.mockReturnValue(unsubscribe);
    chatServiceMocks.sendChatPrompt.mockRejectedValue(failure);

    await useChatStore.getState().sendMessage("Question");
    expect(useChatStore.getState()).toMatchObject({
      status: "error",
      error: expected,
    });
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
