from sentence_transformers import SentenceTransformer
from typing import List

class SentenceTransformerEmbedder:
    """Singleton adapter for neo4j-graphrag retrievers and general embeddings."""
    _instance = None
    _model = None
    _model_name = None

    def __new__(cls, model_name: str = "all-MiniLM-L6-v2", device: str = None):
        if cls._instance is None:
            cls._instance = super(SentenceTransformerEmbedder, cls).__new__(cls)
            cls._model_name = model_name
            if device:
                cls._model = SentenceTransformer(model_name, device=device)
            else:
                cls._model = SentenceTransformer(model_name)
        return cls._instance

    def embed_query(self, text: str) -> List[float]:
        vector = self._model.encode(
            text,
            normalize_embeddings=True,
            convert_to_numpy=True,
        )
        return vector.astype("float32").tolist()

    def embed_documents(self, texts: List[str]) -> List[List[float]]:
        vectors = self._model.encode(
            texts,
            normalize_embeddings=True,
            convert_to_numpy=True,
        )
        return [vector.astype("float32").tolist() for vector in vectors]

    @property
    def dimension(self) -> int:
        if hasattr(self._model, "get_embedding_dimension"):
            return int(self._model.get_embedding_dimension())
        return int(self._model.get_sentence_embedding_dimension())

    def get_model_name(self) -> str:
        return self._model_name

# Global instance for reuse across requests
def get_embedder() -> SentenceTransformerEmbedder:
    return SentenceTransformerEmbedder()
