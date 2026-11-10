#!/usr/bin/env python3
"""Local Streamlit UI for the Codebase Chatbot prototype."""

from __future__ import annotations

import json
import os
from datetime import datetime
from typing import Any, Dict, Optional
from uuid import uuid4

import requests
import streamlit as st


DEFAULT_HEALTH_URL = "http://127.0.0.1:8000/healthz"
DEFAULT_CHAT_URL = "http://127.0.0.1:8000/chat"
DEFAULT_STREAM_URL = "http://127.0.0.1:8000/chat/stream"
WELCOME_MESSAGE = (
    "Hi, I am ready to help you explore this codebase. "
    "Start the backend and ask a question to route chat through the API."
)
EXAMPLE_PROMPTS = [
    "Summarize this repository",
    "Where is the Streamlit UI defined?",
    "What should be built next?",
]


def _auth_headers() -> Dict[str, str]:
    """Authenticate requests when this UI shares the managed backend process."""

    token = os.environ.get("BACKEND_AUTH_TOKEN", "").strip()
    return {"Authorization": f"Bearer {token}"} if token else {}


def init_state() -> None:
    """Initialize Streamlit session keys once per browser session."""

    defaults = {
        "messages": [{"role": "assistant", "content": WELCOME_MESSAGE}],
        "health_url": DEFAULT_HEALTH_URL,
        "chat_url": DEFAULT_CHAT_URL,
        "stream_url": DEFAULT_STREAM_URL,
        "use_streaming": True,
        "user_id": "local-user",
        "session_id": f"streamlit-{uuid4()}",
        "conn_status": None,
        "pending_prompt": None,
    }
    for key, value in defaults.items():
        if key not in st.session_state:
            st.session_state[key] = value


def inject_styles() -> None:
    """Apply small local CSS overrides for a cleaner prototype UI."""

    st.markdown(
        """
        <style>
            .block-container {
                max-width: 980px;
                padding-top: 2rem;
                padding-bottom: 6rem;
            }
            [data-testid="stSidebar"] .block-container {
                padding-top: 1.5rem;
            }
            .app-title {
                font-size: 2.1rem;
                font-weight: 700;
                letter-spacing: 0;
                margin-bottom: .2rem;
            }
            .app-subtitle {
                color: #55606f;
                font-size: 1rem;
                margin-bottom: 1.25rem;
            }
            .status-strip {
                border: 1px solid #dde3ea;
                border-radius: 8px;
                padding: .8rem 1rem;
                background: #f7f9fb;
                margin-bottom: 1rem;
            }
            .small-label {
                color: #667085;
                font-size: .78rem;
                font-weight: 700;
                letter-spacing: .04em;
                text-transform: uppercase;
                margin-bottom: .15rem;
            }
            .status-value {
                color: #1f2937;
                font-size: .95rem;
                font-weight: 600;
            }
            .chat-wrap {
                margin-top: .5rem;
            }
            .stButton > button {
                border-radius: 8px;
                min-height: 2.4rem;
            }
            .stChatMessage {
                border-radius: 8px;
            }
            div[data-testid="stChatInput"] {
                max-width: 980px;
            }
        </style>
        """,
        unsafe_allow_html=True,
    )


def check_connection(url: str, timeout: float = 1.5) -> Dict[str, Any]:
    """Call `/healthz` and normalize success/failure for sidebar rendering."""

    checked_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    try:
        response = requests.get(url.strip(), headers=_auth_headers(), timeout=timeout)
        payload = (
            response.json()
            if response.headers.get("content-type", "").startswith("application/json")
            else {}
        )
        return {
            "ok": response.status_code == 200,
            "url": url,
            "status_code": response.status_code,
            "error": None,
            "checked_at": checked_at,
            "payload": payload if isinstance(payload, dict) else {},
        }
    except Exception as exc:
        return {
            "ok": False,
            "url": url,
            "status_code": None,
            "error": str(exc),
            "checked_at": checked_at,
            "payload": {},
        }


def call_chat_backend(text: str, timeout: float = 90.0) -> str:
    """Send a non-streaming chat request to FastAPI."""

    payload = {
        "user_id": st.session_state["user_id"],
        "session_id": st.session_state["session_id"],
        "text": text,
    }
    try:
        response = requests.post(
            st.session_state["chat_url"].strip(),
            json=payload,
            headers=_auth_headers(),
            timeout=timeout,
        )
        response.raise_for_status()
        data = response.json()
        return data.get("answer", "The backend returned no answer.")
    except Exception as exc:
        return (
            "I could not reach the chat backend. Start FastAPI with "
            "`uvicorn chatbot.api.main:app --reload`, then try again.\n\n"
            f"Backend error: `{exc}`"
        )


def call_stream_backend(text: str, placeholder, timeout: float = 90.0) -> str:
    """Consume backend SSE events and update the assistant placeholder."""

    payload = {
        "user_id": st.session_state["user_id"],
        "session_id": st.session_state["session_id"],
        "text": text,
    }
    answer_parts: list[str] = []
    response = requests.post(
        st.session_state["stream_url"].strip(),
        json=payload,
        headers=_auth_headers(),
        stream=True,
        timeout=timeout,
    )
    response.raise_for_status()
    event_name: str | None = None
    for raw_line in response.iter_lines(decode_unicode=True):
        if not raw_line:
            event_name = None
            continue
        if raw_line.startswith("event: "):
            event_name = raw_line.removeprefix("event: ").strip()
            continue
        if not raw_line.startswith("data: "):
            continue
        data = _parse_sse_data(raw_line)
        if event_name == "start":
            placeholder.markdown("_Generating answer..._")
        elif event_name == "chunk":
            text_chunk = str(data.get("text", ""))
            if text_chunk:
                answer_parts.append(text_chunk)
                placeholder.markdown("".join(answer_parts) + " |")
        elif event_name == "error":
            raise RuntimeError(str(data.get("error", "streaming failed")))
        elif event_name == "done":
            break
    answer = "".join(answer_parts) or "The backend returned no streamed answer."
    placeholder.markdown(answer)
    return answer


def _parse_sse_data(raw_line: str) -> dict[str, Any]:
    """Parse one `data:` line from a Server-Sent Event frame."""

    try:
        payload = json.loads(raw_line.removeprefix("data: "))
    except json.JSONDecodeError:
        return {}
    return payload if isinstance(payload, dict) else {}
    return "".join(answer_parts) or "The backend returned no streamed answer."


def should_stream() -> bool:
    """Use streaming only when both UI and backend health allow it."""

    status = st.session_state.get("conn_status") or {}
    payload = status.get("payload") or {}
    backend_allows_streaming = payload.get("streaming_enabled", True)
    return bool(st.session_state.get("use_streaming") and backend_allows_streaming)


def connection_label(status: Optional[Dict[str, Any]]) -> str:
    if status is None:
        return "Not checked"
    return "Online" if status["ok"] else "Offline"


def reset_chat() -> None:
    """Clear only the UI transcript; backend history deletion is a route call."""

    st.session_state["messages"] = [{"role": "assistant", "content": WELCOME_MESSAGE}]
    st.session_state["pending_prompt"] = None


def submit_prompt(prompt: str) -> None:
    """Render the user prompt, call the backend, then append assistant output."""

    text = prompt.strip()
    if not text:
        return

    st.session_state["messages"].append({"role": "user", "content": text})
    with st.chat_message("user"):
        st.markdown(text)

    with st.chat_message("assistant"):
        placeholder = st.empty()
        with st.status("Thinking...", expanded=False):
            if should_stream():
                try:
                    answer = call_stream_backend(text, placeholder)
                except Exception:
                    answer = call_chat_backend(text)
            else:
                answer = call_chat_backend(text)
        placeholder.markdown(answer)

    st.session_state["messages"].append({"role": "assistant", "content": answer})


def render_sidebar() -> None:
    """Render local session controls and backend connection settings."""

    with st.sidebar:
        st.header("Session")
        st.caption("Local prototype")

        if st.button("Clear chat", use_container_width=True):
            reset_chat()
            st.rerun()

        st.divider()
        st.header("Backend")
        st.text_input(
            "Health URL",
            key="health_url",
            help="Backend endpoint that returns HTTP 200 when healthy.",
        )
        st.text_input(
            "Chat URL",
            key="chat_url",
            help="Backend endpoint that accepts POST /chat requests.",
        )
        st.text_input(
            "Stream URL",
            key="stream_url",
            help="Backend endpoint that accepts POST /chat/stream requests.",
        )
        st.toggle(
            "Use streaming",
            key="use_streaming",
            help="Falls back to JSON /chat if streaming is unavailable.",
        )

        if st.button("Check status", type="primary", use_container_width=True):
            st.session_state["conn_status"] = check_connection(
                st.session_state["health_url"]
            )
            st.rerun()

        status = st.session_state.get("conn_status")
        label = connection_label(status)
        if status is None:
            st.info(label)
        elif status["ok"]:
            st.success(label)
        else:
            st.error(label)

        if status is not None:
            with st.expander("Connection details"):
                st.write(f"URL: {status['url']}")
                st.write(f"Checked: {status['checked_at']}")
                if status["status_code"] is not None:
                    st.write(f"HTTP status: {status['status_code']}")
                if status["error"]:
                    st.write(f"Error: {status['error']}")
                payload = status.get("payload") or {}
                if payload:
                    st.write(
                        "CodeGraph: "
                        f"{payload.get('codegraph_status', 'unknown')}"
                    )
                    st.write(
                        "Streaming: "
                        f"{'enabled' if payload.get('streaming_enabled') else 'disabled'}"
                    )


def render_header() -> None:
    """Render the compact status header above the transcript."""

    status = st.session_state.get("conn_status")
    message_count = max(len(st.session_state["messages"]) - 1, 0)

    st.markdown('<div class="app-title">Codebase Chatbot</div>', unsafe_allow_html=True)
    st.markdown(
        '<div class="app-subtitle">Ask questions about the project and keep the conversation in one focused workspace.</div>',
        unsafe_allow_html=True,
    )

    payload = (status or {}).get("payload") or {}
    c1, c2, c3, c4 = st.columns(4)
    with c1:
        st.markdown(
            f"""
            <div class="status-strip">
                <div class="small-label">Mode</div>
                <div class="status-value">Local prototype</div>
            </div>
            """,
            unsafe_allow_html=True,
        )
    with c2:
        st.markdown(
            f"""
            <div class="status-strip">
                <div class="small-label">Backend</div>
                <div class="status-value">{connection_label(status)}</div>
            </div>
            """,
            unsafe_allow_html=True,
        )
    with c3:
        st.markdown(
            f"""
            <div class="status-strip">
                <div class="small-label">Messages</div>
                <div class="status-value">{message_count}</div>
            </div>
            """,
            unsafe_allow_html=True,
        )
    with c4:
        st.markdown(
            f"""
            <div class="status-strip">
                <div class="small-label">CodeGraph</div>
                <div class="status-value">{payload.get('codegraph_status', 'Unknown')}</div>
            </div>
            """,
            unsafe_allow_html=True,
        )


def render_examples() -> None:
    """Show starter prompts only before the user has begun chatting."""

    if len(st.session_state["messages"]) > 1:
        return

    st.caption("Try a starter prompt")
    cols = st.columns(len(EXAMPLE_PROMPTS))
    for col, prompt in zip(cols, EXAMPLE_PROMPTS):
        with col:
            if st.button(prompt, use_container_width=True):
                st.session_state["pending_prompt"] = prompt
                st.rerun()


def render_transcript() -> None:
    """Replay the session-local transcript into Streamlit chat messages."""

    st.markdown('<div class="chat-wrap">', unsafe_allow_html=True)
    for message in st.session_state["messages"]:
        with st.chat_message(message["role"]):
            st.markdown(message["content"])
    st.markdown("</div>", unsafe_allow_html=True)


def render_chat_input() -> None:
    """Handle starter-prompt reruns and free-form chat input."""

    pending_prompt = st.session_state.get("pending_prompt")
    if pending_prompt:
        st.session_state["pending_prompt"] = None
        submit_prompt(pending_prompt)
        st.rerun()

    prompt = st.chat_input("Ask about this codebase")
    if prompt is not None:
        submit_prompt(prompt)
        st.rerun()


def main() -> None:
    st.set_page_config(
        page_title="Codebase Chatbot",
        layout="centered",
        initial_sidebar_state="expanded",
    )

    init_state()
    inject_styles()
    render_sidebar()
    render_header()
    render_examples()
    render_transcript()
    render_chat_input()


if __name__ == "__main__":
    main()
