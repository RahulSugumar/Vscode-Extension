import os
import logging
import hmac
import json
import sys
import threading
from pathlib import Path
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parent
for env_file in (".env", ".en2"):
    load_dotenv(BACKEND_DIR / env_file)

PROJECT_ROOT = os.environ.get("ABKB_PROJECT_ROOT", os.getcwd())
BACKEND_QUIET = os.environ.get("BACKEND_QUIET", "").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
DEVELOPMENT_LOGGING = os.environ.get(
    "PROJECT_ASSISTANT_DEV_LOGGING", ""
).strip().lower() in {"1", "true", "yes", "on"}
UVICORN_LOG_LEVEL = os.environ.get(
    "UVICORN_LOG_LEVEL", "debug" if DEVELOPMENT_LOGGING else "info"
).strip().lower()
if BACKEND_QUIET:
    logging.disable(logging.CRITICAL)

# --- Imports for Backend 1 (Agent Improvement Plane) ---
from abkb_api import router as abkb_router

# --- Imports for Backend 2 (Codebase Chatbot) ---
from chatbot.api.routes import (
    reload_runtime_settings,
    router as chatbot_router,
    runtime_settings_snapshot,
)
from chatbot.api.main import configure_logging as configure_chatbot_logging

# --- Imports for Backend 3 (Self-Evolving Agent) ---
from graphrag_agent.api.seed_router import router as seed_router
from graphrag_agent.api.retrieve_router import router as retrieve_router
from graphrag_agent.api.chat_router import router as graphrag_chat_router
from graphrag_agent.api.patch_router import router as patch_router
from graphrag_agent.services.llm_service import reset_openai_client
from graphrag_agent.services.neo4j_service import close_driver

# ---------------------------------------------------------------------------
# Backend 1 Initialization
# ---------------------------------------------------------------------------
if not BACKEND_QUIET:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
    )
logger = logging.getLogger("unified_backend")

logger.info("ABKB project root: %s", PROJECT_ROOT)
if DEVELOPMENT_LOGGING:
    logger.info(
        "Development diagnostics enabled; prompts and secrets are excluded from logs."
    )

RUNTIME_CONFIG_ENV_KEYS = {
    "ABKB_PROJECT_ROOT",
    "ABKB_HOME",
    "ABKB_DB_TYPE",
    "ABKB_WORKFLOW_ID",
    "ABKB_TELEMETRY_FETCH_TYPE",
    "ABKB_DB_PATH",
    "ABKB_TELEMETRY_PATH",
    "ABKB_JUDGE_STATE_PATH",
    "ABKB_JUDGE_TRACE_PATH",
    "ABKB_JUDGE_WORKFLOW_CONTEXT_PATH",
    "ABKB_JUDGE_WEIGHT_TELEMETRY_EVIDENCE",
    "ABKB_JUDGE_WEIGHT_FAILURE_CLASS_FIT",
    "ABKB_JUDGE_WEIGHT_TECHNIQUE_FIT",
    "ABKB_JUDGE_WEIGHT_METRIC_IMPACT",
    "ABKB_JUDGE_WEIGHT_POLICY_QUALITY",
    "ABKB_JUDGE_WEIGHT_LLM_CONFIDENCE",
    "ABKB_JUDGE_POLL_SECONDS",
    "ABKB_TELEMETRY_ENABLED",
    "ABKB_BACKGROUND_JUDGE_ENABLED",
    "ABKB_INTEGRATOR_MODEL",
    "ABKB_INTEGRATOR_TIMEOUT_SECONDS",
    "ABKB_INTEGRATOR_MAX_RETRIES",
    "JUDGE_MODEL_ROUTING",
    "JUDGE_CONTEXT_MODE",
    "MAX_JUDGE_USER_CHARS",
    "MAX_JUDGE_OUTPUT_CHARS",
    "MAX_JUDGE_TECHNIQUE_CARDS",
    "NEO4J_URI",
    "NEO4J_USER",
    "NEO4J_PASSWORD",
    "NEO4J_DATABASE",
    "CODEGRAPH_DATABASE",
    "LLM_PROVIDER",
    "LLM_MODEL",
    "LLM_TIMEOUT_SECONDS",
    "EXECUTOR_STEP_TIMEOUT_SECONDS",
    "PROJECT_ASSISTANT_DEV_LOGGING",
    "OPENAI_API_KEY",
    "OPENAI_MODEL",
    "JUDGE_SMALL_OPENAI_MODEL",
    "JUDGE_BIG_OPENAI_MODEL",
    "JUDGE_OPENAI_MODEL",
}
NEO4J_ENV_KEYS = {"NEO4J_URI", "NEO4J_USER", "NEO4J_PASSWORD", "NEO4J_DATABASE"}
OPENAI_ENV_KEYS = {
    "OPENAI_API_KEY",
    "LLM_PROVIDER",
    "LLM_MODEL",
    "LLM_TIMEOUT_SECONDS",
    "OPENAI_MODEL",
    "JUDGE_SMALL_OPENAI_MODEL",
    "JUDGE_BIG_OPENAI_MODEL",
    "JUDGE_OPENAI_MODEL",
    "ABKB_INTEGRATOR_MODEL",
    "ABKB_INTEGRATOR_TIMEOUT_SECONDS",
    "ABKB_INTEGRATOR_MAX_RETRIES",
}


def _health_payload() -> dict:
    return {
        "status": "ok",
        "pid": os.getpid(),
        "project_root": PROJECT_ROOT,
    }

@abkb_router.get("/health")
def admin_health() -> dict:
    return _health_payload()


# ---------------------------------------------------------------------------
# Backend 2 Initialization
# ---------------------------------------------------------------------------
# We call configure_chatbot_logging from chatbot, but be careful it doesn't overwrite 
# the root logger drastically in a way that breaks others.
try:
    configure_chatbot_logging()
except Exception as e:
    logger.error("Failed to configure chatbot logging: %s", e)


# ---------------------------------------------------------------------------
# FastAPI App Construction
# ---------------------------------------------------------------------------
app = FastAPI(title="Unified Integrated Backend", version="1.0.0")

@app.middleware("http")
async def require_backend_auth(request: Request, call_next):
    expected = os.environ.get("BACKEND_AUTH_TOKEN", "")
    if not expected:
        return JSONResponse(status_code=503, content={"detail": "Backend authentication is not configured."})
    supplied = request.headers.get("authorization", "")
    scheme, _, token = supplied.partition(" ")
    if scheme.lower() != "bearer" or not hmac.compare_digest(token, expected):
        return JSONResponse(status_code=401, content={"detail": "Unauthorized"})
    return await call_next(request)

# Root endpoint
@app.get("/")
def root():
    return {"status": "ok", "message": "Unified Backend is running"}

@app.get("/health")
def health() -> dict:
    return _health_payload()

def _apply_runtime_config(env: dict[str, str | None]) -> list[str]:
    rejected = sorted(set(env) - RUNTIME_CONFIG_ENV_KEYS)
    if rejected:
        raise ValueError(f"Unsupported runtime config keys: {', '.join(rejected)}")

    changed_keys: list[str] = []
    for key, value in env.items():
        old_value = os.environ.get(key)
        new_value = str(value).strip() if value is not None else ""
        if new_value:
            os.environ[key] = new_value
        else:
            os.environ.pop(key, None)
        current_value = os.environ.get(key)
        if current_value != old_value:
            changed_keys.append(key)

    if changed_keys:
        if any(key in NEO4J_ENV_KEYS for key in changed_keys):
            close_driver()
        if any(key in OPENAI_ENV_KEYS for key in changed_keys):
            reset_openai_client()
        reload_runtime_settings()
    else:
        runtime_settings_snapshot()

    logger.info("Runtime config hot-updated: %s", ", ".join(changed_keys) or "no changes")
    return sorted(changed_keys)


def _runtime_config_ipc_reader() -> None:
    prefix = "__PROJECT_ASSISTANT_IPC__"
    for raw_line in sys.stdin:
        request_id = ""
        try:
            message = json.loads(raw_line)
            request_id = str(message.get("requestId") or "")
            if message.get("type") != "runtimeConfig.update":
                raise ValueError("Unsupported IPC message type.")
            env = message.get("env")
            if not isinstance(env, dict):
                raise ValueError("Runtime configuration must be an object.")
            changed = _apply_runtime_config(env)
            payload = {"requestId": request_id, "ok": True, "updatedKeys": changed}
        except Exception as exc:
            payload = {
                "requestId": request_id,
                "ok": False,
                "error": f"{exc.__class__.__name__}: {exc}"[:220],
            }
        print(prefix + json.dumps(payload, ensure_ascii=True), flush=True)

# 1. Mount Agent Improvement Plane
app.include_router(abkb_router, prefix="/admin", tags=["Agent Improvement Plane"])

# 2. Mount Codebase Chatbot
app.include_router(chatbot_router, prefix="/chatbot", tags=["Codebase Chatbot"])

# 3. Mount Self-Evolving Agent (GraphRAG)
app.include_router(seed_router, prefix="/graphrag", tags=["Self-Evolving Agent (GraphRAG)"])
app.include_router(retrieve_router, prefix="/graphrag", tags=["Self-Evolving Agent (GraphRAG)"])
app.include_router(graphrag_chat_router, prefix="/graphrag", tags=["Self-Evolving Agent (GraphRAG)"])
app.include_router(patch_router)

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("BACKEND_PORT", "8000"))
    logger.info("Starting Unified Backend on port %d", port)
    threading.Thread(
        target=_runtime_config_ipc_reader,
        name="project-assistant-runtime-config",
        daemon=True,
    ).start()
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=port,
        access_log=not BACKEND_QUIET,
        log_level="critical" if BACKEND_QUIET else UVICORN_LOG_LEVEL,
    )
