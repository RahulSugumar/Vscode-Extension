from __future__ import annotations

import os

from fastapi.testclient import TestClient

import main as unified_main
from chatbot.agent import service


def test_backend_requires_per_process_bearer_token() -> None:
    client = TestClient(unified_main.app)

    assert client.get("/health").status_code == 401
    assert client.get(
        "/health",
        headers={"Authorization": "Bearer test-backend-token"},
    ).status_code == 200


def test_private_runtime_update_rotates_clients(monkeypatch) -> None:
    calls: list[str] = []
    monkeypatch.setattr(unified_main, "close_driver", lambda: calls.append("neo4j"))
    monkeypatch.setattr(unified_main, "reset_openai_client", lambda: calls.append("openai"))
    monkeypatch.setattr(unified_main, "reload_runtime_settings", lambda: calls.append("chatbot") or {})
    monkeypatch.setenv("OPENAI_API_KEY", "old-key")
    monkeypatch.setenv("NEO4J_PASSWORD", "old-password")

    changed = unified_main._apply_runtime_config(
        {"OPENAI_API_KEY": "new-key", "NEO4J_PASSWORD": "new-password"}
    )

    assert changed == ["NEO4J_PASSWORD", "OPENAI_API_KEY"]
    assert os.environ["OPENAI_API_KEY"] == "new-key"
    assert os.environ["NEO4J_PASSWORD"] == "new-password"
    assert calls == ["neo4j", "openai", "chatbot"]


def test_runtime_update_rejects_unapproved_environment_keys() -> None:
    try:
        unified_main._apply_runtime_config({"PATH": "untrusted"})
    except ValueError as exc:
        assert "Unsupported runtime config keys" in str(exc)
    else:
        raise AssertionError("Unapproved runtime environment key was accepted")


def test_local_telemetry_is_redacted_and_external_judge_is_opt_in(monkeypatch) -> None:
    captured: dict[str, object] = {}
    judge_reasons: list[str] = []
    monkeypatch.setenv("ABKB_TELEMETRY_ENABLED", "true")
    monkeypatch.setenv("ABKB_BACKGROUND_JUDGE_ENABLED", "false")
    monkeypatch.setattr(service.abkb, "log_turn", lambda **kwargs: captured.update(kwargs))
    monkeypatch.setattr(service, "_enforce_local_telemetry_retention", lambda: None)
    monkeypatch.setattr(
        service,
        "schedule_judge_run",
        lambda reason: judge_reasons.append(reason),
    )

    service._log_turn_if_enabled(
        user_input="password=super-secret",
        final_output="token: another-secret",
    )
    service._schedule_judge_if_enabled("chat_turn")

    assert "super-secret" not in str(captured)
    assert "another-secret" not in str(captured)
    assert judge_reasons == []

    monkeypatch.setenv("ABKB_BACKGROUND_JUDGE_ENABLED", "true")
    service._schedule_judge_if_enabled("chat_turn")
    assert judge_reasons == ["chat_turn"]
