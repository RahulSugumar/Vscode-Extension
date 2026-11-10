import os

from fastapi import APIRouter
from graphrag_agent.schemas.requests import ChatRequest
from graphrag_agent.schemas.responses import ChatResponse
from graphrag_agent.api.retrieve_router import retrieve_context
from graphrag_agent.services.llm_service import generate_chat_response

router = APIRouter()

@router.post("/api/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    database = os.environ.get("CODEGRAPH_DATABASE") or os.environ.get("NEO4J_DATABASE") or "neo4j"

    # 1. Retrieve Graph Context
    retrieval_res = await retrieve_context(
        query=request.message, 
        top_k=request.top_k, 
        max_neighbors=request.max_neighbors, 
        database=database
    )
    
    # 2. Generate LLM Response
    answer = await generate_chat_response(request.message, retrieval_res["results"])
    
    return ChatResponse(
        answer=answer,
        context_used=retrieval_res["results"]
    )
