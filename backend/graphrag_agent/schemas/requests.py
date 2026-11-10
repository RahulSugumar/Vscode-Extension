from pydantic import BaseModel
from typing import Optional, List

class SeedRequest(BaseModel):
    database: Optional[str] = None
    wipe: bool = False
    embedding_model: str = "all-MiniLM-L6-v2"

class ChatRequest(BaseModel):
    message: str
    session_id: Optional[str] = None
    top_k: int = 5
    max_neighbors: int = 8
