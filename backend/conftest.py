"""Backend-wide deterministic and isolated test configuration."""

from __future__ import annotations

import os
import sys
import tempfile
import types
from pathlib import Path


_TEST_RUNTIME = Path(tempfile.gettempdir()) / "project-assistant-backend-tests"
_TEST_RUNTIME.mkdir(parents=True, exist_ok=True)

os.environ["BACKEND_QUIET"] = "1"
os.environ["BACKEND_AUTH_TOKEN"] = "test-backend-token"
os.environ["LLM_PROVIDER"] = "local"
os.environ["LLM_MODEL"] = "local-deterministic"
os.environ["JUDGE_OPENAI_MODEL"] = "local-deterministic"
os.environ["ABKB_BACKGROUND_JUDGE_ENABLED"] = "false"
os.environ["ABKB_PROJECT_ROOT"] = str(_TEST_RUNTIME)
os.environ["ABKB_HOME"] = str(_TEST_RUNTIME / ".abkb")
os.environ["ABKB_DB_PATH"] = str(_TEST_RUNTIME / ".abkb" / "abkb.db")
os.environ["ABKB_TELEMETRY_PATH"] = str(
    _TEST_RUNTIME / ".abkb" / "telemetry" / "agent_turns.jsonl"
)
os.environ["TOKENIZERS_PARALLELISM"] = "false"

if "sentence_transformers" not in sys.modules:
    transformer_module = types.ModuleType("sentence_transformers")

    class _UnconfiguredSentenceTransformer:
        def __init__(self, *_args, **_kwargs):
            raise RuntimeError("SentenceTransformer must be replaced by a test fake")

    transformer_module.SentenceTransformer = _UnconfiguredSentenceTransformer
    sys.modules["sentence_transformers"] = transformer_module
