from pydantic import BaseModel, Field
from typing import Any, Dict, List, Optional

class SeedResponse(BaseModel):
    message: str
    nodes_upserted: int
    edges_upserted: int
    database: str

class RetrievalResponse(BaseModel):
    query: str
    top_k: Optional[int] = None
    database: str
    results: List[Dict[str, Any]]
    metadata: Dict[str, Any] = Field(default_factory=dict)

class ChatResponse(BaseModel):
    answer: str
    context_used: List[Dict[str, Any]]
