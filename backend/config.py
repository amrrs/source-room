import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()
DATA_DIR = Path(os.getenv("DATA_DIR", "./data"))
NEBIUS_BASE_URL = os.getenv("NEBIUS_BASE_URL", "https://api.tokenfactory.nebius.com/v1").rstrip("/")
CHAT_MODEL = os.getenv("DEFAULT_CHAT_MODEL", "Qwen/Qwen3.5-397B-A17B")
EMBEDDING_MODEL = os.getenv("DEFAULT_EMBEDDING_MODEL", "Qwen/Qwen3-Embedding-8B")
# Suggestions, not guarantees. The authenticated /models endpoint is authoritative.
CHAT_MODELS = list(
    dict.fromkeys(
        [
            CHAT_MODEL,
            "deepseek-ai/DeepSeek-V4-Pro",
            "moonshotai/Kimi-K3",
            "zai-org/GLM-5.2",
            "nvidia/nemotron-3-super-120b-a12b",
            "MiniMaxAI/MiniMax-M3",
        ]
    )
)
EMBEDDING_MODELS = list(dict.fromkeys([EMBEDDING_MODEL, "Qwen/Qwen3-Embedding-8B"]))


def require_key(name: str) -> str:
    from fastapi import HTTPException

    key = os.getenv(name, "").strip()
    if not key:
        raise HTTPException(503, f"Add {name} to your server environment, then restart the app.")
    return key
