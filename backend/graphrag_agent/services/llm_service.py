import os
from openai import AsyncOpenAI
import logging

log = logging.getLogger("llm_service")

_client = None

def reset_openai_client() -> None:
    global _client
    _client = None

def get_openai_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        provider = os.environ.get("LLM_PROVIDER", "openai").strip().lower()
        if provider != "openai":
            raise ValueError(f"LLM provider '{provider}' does not use OpenAI.")
        api_key = os.environ.get("OPENAI_API_KEY")
        if not api_key:
            raise ValueError("OPENAI_API_KEY environment variable is missing")
        _client = AsyncOpenAI()
    return _client

async def generate_chat_response(prompt: str, context: list) -> str:
    if os.environ.get("LLM_PROVIDER", "openai").strip().lower() == "local":
        return (
            "Local fallback mode is active. Retrieved graph context is available, "
            "but no external LLM call was made."
        )

    client = get_openai_client()
    
    # Format the graph context into a readable string
    context_str = ""
    for idx, item in enumerate(context, 1):
        seed = item.get("seedNode", {})
        neighbors = item.get("graphContext", {}).get("neighbors", [])
        
        context_str += f"\\n--- Match {idx} ---\\n"
        context_str += f"Node: {seed.get('name')} (File: {seed.get('filePath')}:{seed.get('lineNumber')})\\n"
        context_str += f"Details: {seed.get('ragText')}\\n"
        if neighbors:
            context_str += "Connected Architecture:\\n"
            for nbr in neighbors:
                context_str += f"  - [{nbr.get('direction')}] {nbr.get('relationshipType')} -> {nbr.get('node', {}).get('name')} ({nbr.get('node', {}).get('filePath')})\\n"
    
    system_message = (
        "You are an expert software architect AI assistant. "
        "You have been provided with structural and semantic 'GraphRAG' context retrieved from the user's codebase. "
        "Use this context to accurately answer the user's question about their code.\\n\\n"
        f"==== CODEBASE CONTEXT ====\\n{context_str}\\n========================="
    )
    
    try:
        response = await client.chat.completions.create(
            model=os.environ.get("LLM_MODEL", "gpt-4o"),
            messages=[
                {"role": "system", "content": system_message},
                {"role": "user", "content": prompt}
            ],
            temperature=0.2,
        )
        return response.choices[0].message.content
    except Exception as e:
        log.error(f"Error calling OpenAI API: {e}")
        raise e
