"""Environment-backed settings for the chatbot."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    """Runtime configuration loaded from environment variables.

    Defaults keep the project runnable on a fresh laptop: local deterministic
    model behavior, in-memory history, and optional external services.
    """

    history_backend: str = "memory"
    sqlite_history_path: str = ".data/chat_history.sqlite3"
    redis_url: str | None = None
    database_url: str | None = None
    s3_emulation_path: str | None = None
    history_recent_turns: int = 20
    history_degraded_policy: str = "cold"
    llm_provider: str = "local"
    llm_model: str = "local-deterministic"
    judge_model: str = "local-deterministic"
    llm_temperature: float = 0.0
    llm_timeout_seconds: float | None = None
    openai_api_key: str | None = None
    planner_max_steps: int = 5
    executor_max_steps: int = 6
    executor_step_timeout_seconds: float | None = None
    critic_confidence_threshold: float = 0.8
    summarizer_enabled: bool = True
    summarizer_every_turns: int = 5
    codegraph_enabled: bool = True
    codegraph_base_url: str = "http://127.0.0.1:9000"
    codegraph_top_k: int = 5
    codegraph_max_neighbors: int = 8
    codegraph_database: str = "neo4j"
    codegraph_timeout_seconds: float = 20.0
    codegraph_max_result_chars: int = 12000
    chat_max_request_chars: int = 12000
    chat_streaming_enabled: bool = True
    chat_stream_chunk_size: int = 512


def load_settings() -> Settings:
    """Load `.env` once, then build a typed settings object for app wiring."""

    _load_dotenv()
    return Settings(
        history_backend=os.getenv("HISTORY_BACKEND", "memory").strip().lower(),
        sqlite_history_path=os.getenv(
            "SQLITE_HISTORY_PATH", ".data/chat_history.sqlite3"
        ),
        redis_url=_optional_env("REDIS_URL"),
        database_url=_optional_env("DATABASE_URL"),
        s3_emulation_path=_optional_env("S3_EMULATION_PATH"),
        history_recent_turns=_int_env("HISTORY_RECENT_TURNS", 20),
        history_degraded_policy=os.getenv("HISTORY_DEGRADED_POLICY", "cold"),
        llm_provider=os.getenv("LLM_PROVIDER", "local").strip().lower(),
        llm_model=os.getenv("LLM_MODEL", "local-deterministic").strip()
        or "local-deterministic",
        judge_model=os.getenv(
            "JUDGE_BIG_OPENAI_MODEL",
            os.getenv(
                "JUDGE_OPENAI_MODEL",
                os.getenv("ABKB_INTEGRATOR_MODEL", "local-deterministic"),
            ),
        ).strip()
        or "local-deterministic",
        llm_temperature=_float_env("LLM_TEMPERATURE", 0.0),
        llm_timeout_seconds=_optional_positive_float_env("LLM_TIMEOUT_SECONDS"),
        openai_api_key=_optional_env("OPENAI_API_KEY"),
        planner_max_steps=_int_env("PLANNER_MAX_STEPS", 5),
        executor_max_steps=_int_env("EXECUTOR_MAX_STEPS", 6),
        executor_step_timeout_seconds=_optional_positive_float_env(
            "EXECUTOR_STEP_TIMEOUT_SECONDS"
        ),
        critic_confidence_threshold=_float_env(
            "CRITIC_CONFIDENCE_THRESHOLD", 0.8
        ),
        summarizer_enabled=_bool_env("SUMMARIZER_ENABLED", True),
        summarizer_every_turns=_int_env("SUMMARIZER_EVERY_TURNS", 5),
        codegraph_enabled=_bool_env("CODEGRAPH_ENABLED", True),
        codegraph_base_url=os.getenv(
            "CODEGRAPH_BASE_URL", "http://127.0.0.1:9000"
        ).strip()
        or "http://127.0.0.1:9000",
        codegraph_top_k=_int_env("CODEGRAPH_TOP_K", 5),
        codegraph_max_neighbors=_int_env("CODEGRAPH_MAX_NEIGHBORS", 8),
        codegraph_database=os.getenv("CODEGRAPH_DATABASE", "neo4j").strip()
        or "neo4j",
        codegraph_timeout_seconds=_float_env("CODEGRAPH_TIMEOUT_SECONDS", 20.0),
        codegraph_max_result_chars=_int_env("CODEGRAPH_MAX_RESULT_CHARS", 12000),
        chat_max_request_chars=_int_env("CHAT_MAX_REQUEST_CHARS", 12000),
        chat_streaming_enabled=_bool_env("CHAT_STREAMING_ENABLED", True),
        chat_stream_chunk_size=_int_env("CHAT_STREAM_CHUNK_SIZE", 512),
    )


def _int_env(name: str, default: int) -> int:
    """Read an integer env var while falling back safely on bad input."""

    raw_value = os.getenv(name)
    if raw_value is None:
        return default
    try:
        return int(raw_value)
    except ValueError:
        return default


def _optional_positive_float_env(name: str) -> float | None:
    """Read an optional positive float; missing, zero, or negative means no timeout."""

    raw_value = os.getenv(name)
    if raw_value is None or not raw_value.strip():
        return None
    try:
        value = float(raw_value)
    except ValueError:
        return None
    return value if value > 0 else None

def _float_env(name: str, default: float) -> float:
    """Read a float env var while falling back safely on bad input."""

    raw_value = os.getenv(name)
    if raw_value is None:
        return default
    try:
        return float(raw_value)
    except ValueError:
        return default


def _bool_env(name: str, default: bool) -> bool:
    """Accept common truthy strings and treat everything else as false."""

    raw_value = os.getenv(name)
    if raw_value is None:
        return default
    return raw_value.strip().lower() in {"1", "true", "yes", "on"}


def _optional_env(name: str) -> str | None:
    """Return None for missing or blank env vars so callers can branch cleanly."""

    value = os.getenv(name)
    if value is None:
        return None
    value = value.strip()
    return value or None


def _load_dotenv(path: str = ".env") -> None:
    """Minimal dotenv loader used to avoid requiring an extra dependency.

    The API is often launched from either `ChatBot/` or the parent workspace.
    Check the process working directory first, then the ChatBot project root so
    local LLM settings are picked up in both cases.
    """

    env_path = next(
        (candidate for candidate in _dotenv_candidates(path) if candidate.exists()),
        None,
    )
    if env_path is None:
        return

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def _dotenv_candidates(path: str) -> list[Path]:
    requested = Path(path)
    if requested.is_absolute():
        return [requested]

    package_root = Path(__file__).resolve().parents[2]
    candidates = [Path.cwd() / requested, package_root / requested]

    unique_candidates: list[Path] = []
    seen: set[Path] = set()
    for candidate in candidates:
        resolved = candidate.resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        unique_candidates.append(candidate)
    return unique_candidates
