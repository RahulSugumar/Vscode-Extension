import os
import logging
from neo4j import GraphDatabase, Driver
from dotenv import load_dotenv

load_dotenv()
log = logging.getLogger("neo4j_service")

# Global driver instance
_driver: Driver = None

def get_driver() -> Driver:
    global _driver
    if _driver is None:
        uri = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
        user = os.environ.get("NEO4J_USER", "neo4j")
        password = os.environ.get("NEO4J_PASSWORD")
        if not password:
            raise ValueError("NEO4J_PASSWORD is not set in environment.")
        _driver = GraphDatabase.driver(uri, auth=(user, password))
        _driver.verify_connectivity()
        log.info(f"Connected to Neo4j at {uri}")
    return _driver

def close_driver():
    global _driver
    if _driver:
        _driver.close()
        _driver = None

def ensure_database(db_name: str) -> None:
    driver = get_driver()
    with driver.session(database="system") as session:
        try:
            session.run(f"CREATE DATABASE `{db_name}` IF NOT EXISTS")
            log.info(f"Ensured database '{db_name}' exists.")
        except Exception as exc:
            log.warning(f"Could not auto-create database '{db_name}'. Detail: {exc}")

def wipe_database(db_name: str) -> None:
    driver = get_driver()
    with driver.session(database=db_name) as session:
        session.run("MATCH (n) DETACH DELETE n")
    log.info(f"Database '{db_name}' wiped.")

def create_constraints(db_name: str) -> None:
    driver = get_driver()
    with driver.session(database=db_name) as session:
        session.run(
            "CREATE CONSTRAINT codegraph_CodeNode_id IF NOT EXISTS "
            "FOR (n:CodeNode) REQUIRE n.id IS UNIQUE"
        )
    log.info("Ensured uniqueness on :CodeNode(id)")

def ensure_indexes(db_name: str, vector_index_name: str, fulltext_index_name: str, embedding_dim: int) -> None:
    driver = get_driver()
    vector_query = f"""
    CREATE VECTOR INDEX {vector_index_name} IF NOT EXISTS
    FOR (n:CodeNode) ON (n.ragEmbedding)
    OPTIONS {{
      indexConfig: {{
        `vector.dimensions`: {embedding_dim},
        `vector.similarity_function`: 'cosine'
      }}
    }}
    """
    fulltext_query = f"""
    CREATE FULLTEXT INDEX {fulltext_index_name} IF NOT EXISTS
    FOR (n:CodeNode) ON EACH [n.ragText, n.name, n.filePath]
    """
    with driver.session(database=db_name) as session:
        session.run(vector_query).consume()
        session.run(fulltext_query).consume()
    log.info(f"Ensured vector index '{vector_index_name}' and fulltext index '{fulltext_index_name}'.")
