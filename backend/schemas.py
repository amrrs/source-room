import ipaddress
import re
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, Field, field_validator, model_validator

from .config import CHAT_MODEL, EMBEDDING_MODEL


def domain_name(value: str) -> str:
    value = value.strip().lower().rstrip(".")
    if not value or "://" in value or "/" in value or "@" in value or ":" in value:
        raise ValueError("Enter domains such as docs.nebius.com, without protocols, paths or ports.")
    value = value.encode("idna").decode()
    if len(value) > 253 or not re.fullmatch(
        r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", value
    ):
        raise ValueError("Enter a valid public domain.")
    if value.endswith((".localhost", ".local", ".internal")):
        raise ValueError("Only public domains are supported.")
    try:
        ipaddress.ip_address(value)
    except ValueError:
        return value
    raise ValueError("Use a public domain, not an IP address.")


def allowed_url(url: str, include: list[str], exclude: list[str]) -> bool:
    try:
        parts = urlsplit(url)
        host = domain_name(parts.hostname or "")
        if (
            parts.scheme not in {"http", "https"}
            or parts.username
            or parts.password
            or parts.port not in {None, 80, 443}
        ):
            return False
    except ValueError:
        return False

    def match(d):
        return host == d or host.endswith("." + d)

    return (not include or any(map(match, include))) and not any(map(match, exclude))


class Settings(BaseModel):
    chat_model: str = Field(CHAT_MODEL, min_length=1, max_length=200)
    embedding_model: str = Field(EMBEDDING_MODEL, min_length=1, max_length=200)
    web_search: bool = True
    search_depth: Literal["basic", "advanced"] = "advanced"
    extract_depth: Literal["basic", "advanced"] = "advanced"
    include_domains: list[str] = Field(default_factory=list, max_length=50)
    exclude_domains: list[str] = Field(default_factory=list, max_length=50)
    max_results: int = Field(5, ge=1, le=10)
    topic: Literal["general", "news", "finance"] = "general"
    time_range: Literal["", "day", "week", "month", "year"] = ""
    top_k: int = Field(6, ge=1, le=20)
    score_threshold: float = Field(0, ge=-1, le=1)
    chunk_size: int = Field(1200, ge=400, le=2400)
    chunk_overlap: int = Field(200, ge=0, le=600)
    temperature: float = Field(0.2, ge=0, le=1)
    top_p: float = Field(0.95, gt=0, le=1)
    max_tokens: int = Field(2048, ge=256, le=8192)
    context_chars: int = Field(24000, ge=4000, le=60000)
    history_turns: int = Field(4, ge=0, le=10)
    answer_style: Literal["concise", "balanced", "detailed"] = "balanced"

    @field_validator("include_domains", "exclude_domains")
    @classmethod
    def domains(cls, values):
        return list(dict.fromkeys(domain_name(value) for value in values))

    @model_validator(mode="after")
    def overlap_valid(self):
        if self.chunk_overlap >= self.chunk_size:
            raise ValueError("Chunk overlap must be smaller than chunk size.")
        return self


class WebsiteRequest(BaseModel):
    url: str = Field(min_length=8, max_length=2048)
    settings: Settings = Field(default_factory=Settings)


class ChatRequest(BaseModel):
    question: str = Field(min_length=1, max_length=8000)
    source_ids: list[str] = Field(default_factory=list, max_length=30)
    settings: Settings = Field(default_factory=Settings)

    @field_validator("question")
    @classmethod
    def not_blank(cls, value):
        if not value.strip():
            raise ValueError("Ask a question first.")
        return value.strip()
