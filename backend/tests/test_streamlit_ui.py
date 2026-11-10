from __future__ import annotations

from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from chatbot.ui import streamlit_app


def fake_streamlit(state=None):
    session_state = state if state is not None else {}
    value = SimpleNamespace(
        session_state=session_state,
        markdown=MagicMock(),
        set_page_config=MagicMock(),
        header=MagicMock(),
        caption=MagicMock(),
        button=MagicMock(return_value=False),
        divider=MagicMock(),
        text_input=MagicMock(),
        toggle=MagicMock(),
        info=MagicMock(),
        success=MagicMock(),
        error=MagicMock(),
        write=MagicMock(),
        rerun=MagicMock(),
        chat_input=MagicMock(return_value=None),
        empty=MagicMock(return_value=MagicMock()),
        sidebar=nullcontext(),
        expander=MagicMock(return_value=nullcontext()),
        chat_message=MagicMock(return_value=nullcontext()),
        status=MagicMock(return_value=nullcontext()),
        columns=MagicMock(side_effect=lambda count: [nullcontext() for _ in range(count)]),
    )
    return value


def test_streamlit_state_styles_labels_and_reset(monkeypatch) -> None:
    st = fake_streamlit()
    monkeypatch.setattr(streamlit_app, "st", st)
    streamlit_app.init_state()
    first_session = st.session_state["session_id"]
    streamlit_app.init_state()
    assert st.session_state["session_id"] == first_session
    assert st.session_state["messages"][0]["content"] == streamlit_app.WELCOME_MESSAGE
    streamlit_app.inject_styles()
    st.markdown.assert_called()
    assert streamlit_app.connection_label(None) == "Not checked"
    assert streamlit_app.connection_label({"ok": True}) == "Online"
    assert streamlit_app.connection_label({"ok": False}) == "Offline"
    st.session_state["messages"].append({"role": "user", "content": "x"})
    st.session_state["pending_prompt"] = "x"
    streamlit_app.reset_chat()
    assert len(st.session_state["messages"]) == 1
    assert st.session_state["pending_prompt"] is None


def test_connection_and_non_stream_chat_success_and_failure(monkeypatch) -> None:
    response = SimpleNamespace(
        status_code=200,
        headers={"content-type": "application/json"},
        json=lambda: {"status": "ok"},
        raise_for_status=lambda: None,
    )
    monkeypatch.setattr(streamlit_app.requests, "get", lambda *a, **k: response)
    status = streamlit_app.check_connection(" http://health ")
    assert status["ok"] is True
    assert status["payload"] == {"status": "ok"}
    monkeypatch.setattr(
        streamlit_app.requests,
        "get",
        MagicMock(side_effect=RuntimeError("offline")),
    )
    assert streamlit_app.check_connection("url")["error"] == "offline"

    state = {
        "user_id": "u",
        "session_id": "s",
        "chat_url": "http://chat",
        "stream_url": "http://stream",
    }
    monkeypatch.setattr(streamlit_app, "st", fake_streamlit(state))
    monkeypatch.setattr(
        streamlit_app.requests,
        "post",
        lambda *a, **k: SimpleNamespace(
            raise_for_status=lambda: None, json=lambda: {"answer": "Answer"}
        ),
    )
    assert streamlit_app.call_chat_backend("q") == "Answer"
    monkeypatch.setattr(
        streamlit_app.requests,
        "post",
        MagicMock(side_effect=RuntimeError("down")),
    )
    assert "could not reach" in streamlit_app.call_chat_backend("q")


def test_streaming_parser_and_stream_preference(monkeypatch) -> None:
    lines = [
        "event: start",
        'data: {"status":"accepted"}',
        "",
        "event: chunk",
        'data: {"text":"Hel"}',
        "",
        "event: chunk",
        'data: {"text":"lo"}',
        "",
        "event: done",
        "data: {}",
    ]
    response = SimpleNamespace(
        raise_for_status=lambda: None,
        iter_lines=lambda decode_unicode=True: iter(lines),
    )
    state = {
        "user_id": "u",
        "session_id": "s",
        "stream_url": "http://stream",
        "use_streaming": True,
        "conn_status": {"payload": {"streaming_enabled": True}},
    }
    st = fake_streamlit(state)
    monkeypatch.setattr(streamlit_app, "st", st)
    monkeypatch.setattr(streamlit_app.requests, "post", lambda *a, **k: response)
    placeholder = MagicMock()
    assert streamlit_app.call_stream_backend("q", placeholder) == "Hello"
    assert placeholder.markdown.call_args.args[0] == "Hello"
    assert streamlit_app.should_stream() is True
    state["conn_status"]["payload"]["streaming_enabled"] = False
    assert streamlit_app.should_stream() is False
    assert streamlit_app._parse_sse_data('data: {"x":1}') == {"x": 1}
    assert streamlit_app._parse_sse_data("data: []") == {}
    assert streamlit_app._parse_sse_data("bad") == {}

    error_response = SimpleNamespace(
        raise_for_status=lambda: None,
        iter_lines=lambda decode_unicode=True: iter(
            ["event: error", 'data: {"error":"failed"}']
        ),
    )
    monkeypatch.setattr(streamlit_app.requests, "post", lambda *a, **k: error_response)
    with pytest.raises(RuntimeError, match="failed"):
        streamlit_app.call_stream_backend("q", placeholder)


def test_submit_prompt_stream_fallback_and_main_rendering(monkeypatch) -> None:
    state = {
        "messages": [],
        "user_id": "u",
        "session_id": "s",
        "chat_url": "chat",
        "stream_url": "stream",
        "use_streaming": True,
        "conn_status": None,
        "pending_prompt": None,
    }
    st = fake_streamlit(state)
    monkeypatch.setattr(streamlit_app, "st", st)
    monkeypatch.setattr(streamlit_app, "call_stream_backend", MagicMock(side_effect=RuntimeError("stream")))
    monkeypatch.setattr(streamlit_app, "call_chat_backend", lambda text: "Fallback")
    streamlit_app.submit_prompt("  Question  ")
    assert state["messages"] == [
        {"role": "user", "content": "Question"},
        {"role": "assistant", "content": "Fallback"},
    ]
    streamlit_app.submit_prompt("   ")
    assert len(state["messages"]) == 2

    for name in (
        "init_state",
        "inject_styles",
        "render_sidebar",
        "render_header",
        "render_examples",
        "render_transcript",
        "render_chat_input",
    ):
        monkeypatch.setattr(streamlit_app, name, MagicMock())
    streamlit_app.main()
    st.set_page_config.assert_called_once()
    streamlit_app.render_chat_input.assert_called_once()


def test_sidebar_header_examples_transcript_and_input(monkeypatch) -> None:
    state = {
        "messages": [
            {"role": "assistant", "content": "Welcome"},
            {"role": "user", "content": "Question"},
        ],
        "health_url": "health",
        "chat_url": "chat",
        "stream_url": "stream",
        "use_streaming": True,
        "conn_status": {
            "ok": True,
            "url": "health",
            "checked_at": "now",
            "status_code": 200,
            "error": None,
            "payload": {"codegraph_status": "ok", "streaming_enabled": True},
        },
        "pending_prompt": None,
    }
    st = fake_streamlit(state)
    monkeypatch.setattr(streamlit_app, "st", st)
    streamlit_app.render_sidebar()
    st.success.assert_called_with("Online")
    streamlit_app.render_header()
    assert st.columns.called
    streamlit_app.render_transcript()
    assert st.chat_message.call_count == 2

    state["messages"] = [{"role": "assistant", "content": "Welcome"}]
    st.button.return_value = True
    streamlit_app.render_examples()
    assert state["pending_prompt"] == streamlit_app.EXAMPLE_PROMPTS[-1]
    st.rerun.assert_called()

    submit = MagicMock()
    monkeypatch.setattr(streamlit_app, "submit_prompt", submit)
    streamlit_app.render_chat_input()
    submit.assert_called_with(streamlit_app.EXAMPLE_PROMPTS[-1])
    state["pending_prompt"] = None
    st.chat_input.return_value = "Typed"
    streamlit_app.render_chat_input()
    submit.assert_called_with("Typed")
