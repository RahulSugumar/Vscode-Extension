import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const storeMock = vi.hoisted(() => ({
  useChatStore: vi.fn(),
}));

vi.mock("../state/chatStore", () => storeMock);

import ChatPage from "./ChatPage";

const sendMessage = vi.fn();
let state: any;

beforeEach(() => {
  sendMessage.mockReset();
  sendMessage.mockResolvedValue(undefined);
  state = {
    messages: [],
    status: "idle",
    error: null,
    sendMessage,
  };
  storeMock.useChatStore.mockImplementation(() => state);
});

describe("ChatPage", () => {
  it("shows the empty state and can hide it", () => {
    const { rerender } = render(<ChatPage />);
    expect(screen.getByText("Start a conversation with the Self-Evolving Agent.")).toBeInTheDocument();
    rerender(<ChatPage hideEmptyState />);
    expect(screen.queryByText("Start a conversation with the Self-Evolving Agent.")).not.toBeInTheDocument();
  });

  it("submits trimmed input with Enter and clears the draft", async () => {
    const user = userEvent.setup();
    render(<ChatPage />);
    const input = screen.getByRole("textbox", { name: "Chat message input" });
    await user.type(input, "  explain this  {Enter}");
    expect(sendMessage).toHaveBeenCalledWith("explain this");
    expect(input).toHaveValue("");
  });

  it("does not submit empty input and keeps Shift+Enter as a newline", async () => {
    const user = userEvent.setup();
    render(<ChatPage />);
    const input = screen.getByRole("textbox", { name: "Chat message input" });
    await user.type(input, "   ");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(sendMessage).not.toHaveBeenCalled();
    await user.clear(input);
    await user.type(input, "line one{Shift>}{Enter}{/Shift}line two");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(input).toHaveValue("line one\nline two");
    await user.clear(input);
  });

  it("preserves an unsent draft across remounts", async () => {
    const user = userEvent.setup();
    const first = render(<ChatPage />);
    await user.type(screen.getByRole("textbox"), "draft");
    first.unmount();
    render(<ChatPage />);
    expect(screen.getByRole("textbox")).toHaveValue("draft");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(sendMessage).toHaveBeenCalledWith("draft");
  });

  it("disables composition while waiting or externally disabled", () => {
    state.status = "sending";
    state.messages = [{ id: "u", sender: "user", text: "Question", timestamp: 1 }];
    const { rerender } = render(<ChatPage />);
    expect(screen.getByText(/Agent is thinking/)).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBeDisabled();

    state.status = "idle";
    rerender(<ChatPage disabled />);
    expect(screen.getByPlaceholderText("Preparing assistant...")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("renders user text, agent markdown, and errors", () => {
    state.messages = [
      { id: "u", sender: "user", text: "Plain <b>text</b>", timestamp: 1 },
      { id: "a", sender: "agent", text: "**Bold** [link](https://example.com)", timestamp: 2 },
    ];
    state.status = "error";
    state.error = "Chat failed";
    render(<ChatPage />);
    expect(screen.getByText("Plain <b>text</b>")).toBeInTheDocument();
    expect(screen.getByText("Bold").tagName).toBe("STRONG");
    expect(screen.getByRole("link", { name: "link" })).toHaveAttribute("href", "https://example.com");
    expect(screen.getByText("Chat failed")).toBeInTheDocument();
  });

  it("resizes the input and stops automatic scrolling on upward interaction", async () => {
    const user = userEvent.setup();
    render(<ChatPage />);
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    Object.defineProperty(input, "scrollHeight", { configurable: true, value: 200 });
    await user.type(input, "x");
    await waitFor(() => expect(input.style.height).toBe("168px"));
    expect(input.style.overflowY).toBe("auto");

    const history = input.closest(".chat-page")!.querySelector(".chat-history")!;
    fireEvent.wheel(history, { deltaY: -10 });
    fireEvent.touchMove(history);
    fireEvent.scroll(history);
  });
});
