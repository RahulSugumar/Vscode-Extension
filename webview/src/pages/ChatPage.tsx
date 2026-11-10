import React, { useState, useRef, useEffect, useLayoutEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useChatStore } from "../state/chatStore";
import { Send, Loader2, AlertTriangle } from "lucide-react";
import "./ChatPage.css";

interface ChatPageProps {
  disabled?: boolean;
  hideEmptyState?: boolean;
}

let chatInputDraft = "";

export default function ChatPage({
  disabled = false,
  hideEmptyState = false,
}: ChatPageProps) {
  const { messages, status, error, sendMessage } = useChatStore();
  const [input, setInput] = useState(() => chatInputDraft);
  const historyRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const shouldStickToBottomRef = useRef(true);
  const autoScrollFrameRef = useRef<number | null>(null);
  const lastMessage = messages[messages.length - 1];
  const isWaitingForFirstToken =
    status === "sending" && lastMessage?.sender !== "agent";

  const cancelPendingAutoScroll = () => {
    if (autoScrollFrameRef.current === null) return;
    window.cancelAnimationFrame(autoScrollFrameRef.current);
    autoScrollFrameRef.current = null;
  };

  const scheduleScrollToBottom = () => {
    if (!shouldStickToBottomRef.current) return;
    cancelPendingAutoScroll();
    autoScrollFrameRef.current = window.requestAnimationFrame(() => {
      autoScrollFrameRef.current = null;
      const history = historyRef.current;
      if (!history || !shouldStickToBottomRef.current) return;
      history.scrollTop = history.scrollHeight;
    });
  };

  useLayoutEffect(() => {
    scheduleScrollToBottom();
  }, [messages, status]);

  useEffect(() => () => cancelPendingAutoScroll(), []);

  useEffect(() => {
    chatInputDraft = input;
  }, [input]);

  useEffect(() => {
    if (disabled || status === "sending") return;

    const frame = window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea || textarea.disabled) return;
      textarea.focus({ preventScroll: true });
      const cursorPosition = textarea.value.length;
      textarea.setSelectionRange(cursorPosition, cursorPosition);
    });

    return () => window.cancelAnimationFrame(frame);
  }, [disabled, status]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const maxHeight = 168;
    textarea.style.height = "auto";
    const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY =
      textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [input]);

  const handleHistoryScroll = () => {
    const el = historyRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const isNearBottom = distanceFromBottom < 80;
    shouldStickToBottomRef.current = isNearBottom;
    if (!isNearBottom) {
      cancelPendingAutoScroll();
    }
  };

  const handleHistoryWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (event.deltaY >= 0) return;
    shouldStickToBottomRef.current = false;
    cancelPendingAutoScroll();
  };

  const handleHistoryTouchMove = () => {
    shouldStickToBottomRef.current = false;
    cancelPendingAutoScroll();
  };

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || status === "sending" || disabled) return;
    shouldStickToBottomRef.current = true;
    void sendMessage(trimmed);
    chatInputDraft = "";
    setInput("");
  };

  return (
    <div className="chat-page">
      <div
        className="chat-history"
        ref={historyRef}
        onScroll={handleHistoryScroll}
        onWheel={handleHistoryWheel}
        onTouchMove={handleHistoryTouchMove}
      >
        {messages.map((msg) => (
          <div key={msg.id} className={`chat-message ${msg.sender}`}>
            <div className="message-bubble">
              <div className="message-content">
                {msg.sender === "agent" ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {msg.text}
                  </ReactMarkdown>
                ) : (
                  <p>{msg.text}</p>
                )}
              </div>
            </div>
          </div>
        ))}
        {isWaitingForFirstToken && (
          <div className="chat-message agent">
            <div className="message-bubble typing">
              <Loader2 className="spinner-inline" size={14} /> Agent is
              thinking...
            </div>
          </div>
        )}
        {status === "error" && error && (
          <div className="chat-error">
            <AlertTriangle size={14} /> {error}
          </div>
        )}
        {messages.length === 0 && status === "idle" && !hideEmptyState && (
          <div className="chat-empty">
            <p>Start a conversation with the Self-Evolving Agent.</p>
          </div>
        )}
        <div ref={endRef} />
      </div>
      <div className="chat-input-area">
        <textarea
          ref={textareaRef}
          className="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder={disabled ? "Preparing assistant..." : "Ask the graph"}
          aria-label="Chat message input"
          disabled={status === "sending" || disabled}
          rows={1}
        />
        <button
          className="icon-btn"
          onClick={handleSend}
          aria-label="Send message"
          disabled={status === "sending" || disabled}
        >
          <Send size={18} />
        </button>
      </div>
    </div>
  );
}
