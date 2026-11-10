"""Shared deterministic test configuration for the backend suite."""

from __future__ import annotations

import os
import sys
import tempfile
import types
from pathlib import Path


_TEST_RUNTIME = Path(tempfile.gettempdir()) / "project-assistant-backend-tests"
_TEST_RUNTIME.mkdir(parents=True, exist_ok=True)

os.environ.setdefault("BACKEND_QUIET", "1")
os.environ.setdefault("BACKEND_AUTH_TOKEN", "test-backend-token")
os.environ.setdefault("LLM_PROVIDER", "local")
os.environ.setdefault("LLM_MODEL", "local-deterministic")
os.environ.setdefault("JUDGE_OPENAI_MODEL", "local-deterministic")
os.environ.setdefault("ABKB_BACKGROUND_JUDGE_ENABLED", "false")
os.environ.setdefault("ABKB_PROJECT_ROOT", str(_TEST_RUNTIME))
os.environ.setdefault("ABKB_HOME", str(_TEST_RUNTIME / ".abkb"))
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

# The production transformer package takes tens of seconds to import and may
# initialize native ML runtimes. Tests replace the model at the service
# boundary, so expose only the import contract during collection.
if "sentence_transformers" not in sys.modules:
    transformer_module = types.ModuleType("sentence_transformers")

    class _UnconfiguredSentenceTransformer:
        def __init__(self, *_args, **_kwargs):
            raise RuntimeError("SentenceTransformer must be replaced by a test fake")

    transformer_module.SentenceTransformer = _UnconfiguredSentenceTransformer
    sys.modules["sentence_transformers"] = transformer_module
