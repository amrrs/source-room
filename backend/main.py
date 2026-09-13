import asyncio
import hmac
import json
import logging
import os
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from pathlib import Path
from time import monotonic
from urllib.parse import urlsplit

import httpx
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError

from . import config, rag, store
from .schemas import ChatRequest, Settings, WebsiteRequest

logger = logging.getLogger(__name__)
locks: dict[str, asyncio.Lock] = {}
login_attempts = defaultdict(deque)


@asynccontextmanager
async def lifespan(app):
    store.init()
    yield


app = FastAPI(title="Source Room", lifespan=lifespan)


@app.middleware("http")
async def workspace(request: Request, call_next):
    if not request.url.path.startswith("/api/") or request.url.path == "/api/health":
        return await call_next(request)
    # Same-origin browser writes; no permissive CORS. Reverse proxies preserve Host.
    origin = request.headers.get("origin")
    if (
        request.method not in {"GET", "HEAD", "OPTIONS"}
        and origin
        and urlsplit(origin).netloc != request.headers.get("host")
    ):
        return JSONResponse({"detail": "Cross-origin requests are not allowed."}, status_code=403)
    if int(request.headers.get("content-length", "0")) > 22 * 1024 * 1024:
        return JSONResponse({"detail": "Request too large. Maximum PDF size is 20 MB."}, status_code=413)
    row, created = store.session(request.cookies.get("source_room"))
    request.state.sid = row["id"]
    if (
        os.getenv("APP_ACCESS_TOKEN")
        and not row["authorized"]
        and request.url.path not in {"/api/config", "/api/login"}
    ):
        response = JSONResponse({"detail": "Enter the workspace password to continue."}, status_code=401)
    else:
        response = await call_next(request)
    if created:
        response.set_cookie(
            "source_room",
            row["id"],
            httponly=True,
            samesite="lax",
            secure=os.getenv("COOKIE_SECURE", "false").lower() == "true",
            max_age=30 * 86400,
        )
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.get("/api/config")
async def configuration(request: Request):
    with store.db() as c:
        authorized = c.execute("SELECT authorized FROM sessions WHERE id=?", (request.state.sid,)).fetchone()[
            0
        ]
    return {
        "nebius_configured": bool(os.getenv("NEBIUS_API_KEY")),
        "tavily_configured": bool(os.getenv("TAVILY_API_KEY")),
        "auth_required": bool(os.getenv("APP_ACCESS_TOKEN")) and not bool(authorized),
        "defaults": Settings().model_dump(),
        "chat_models": config.CHAT_MODELS,
        "embedding_models": config.EMBEDDING_MODELS,
    }


class Login(BaseModel):
    password: str = Field(max_length=500)


@app.post("/api/login")
async def login(body: Login, request: Request):
    # Per-client, bounded time window. Configure a proxy-level limiter for larger deployments.
    client = request.client.host if request.client else "unknown"
    now = monotonic()
    for key in list(login_attempts):
        while login_attempts[key] and now - login_attempts[key][0] > 60:
            login_attempts[key].popleft()
        if not login_attempts[key]:
            del login_attempts[key]
    attempts = login_attempts[client]
    if len(attempts) >= 10:
        raise HTTPException(429, "Too many attempts. Wait a minute and try again.")
    attempts.append(now)
    if not hmac.compare_digest(body.password, os.getenv("APP_ACCESS_TOKEN", "")):
        raise HTTPException(401, "That password is not correct.")
    with store.db() as c:
        c.execute("UPDATE sessions SET authorized=1 WHERE id=?", (request.state.sid,))
    return {"ok": True}


@app.get("/api/workspace")
async def get_workspace(request: Request):
    return {"sources": store.sources(request.state.sid), "messages": store.messages(request.state.sid)}


@app.get("/api/models")
async def models():
    key = config.require_key("NEBIUS_API_KEY")
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.get(
                config.NEBIUS_BASE_URL + "/models", headers={"Authorization": "Bearer " + key}
            )
            response.raise_for_status()
        result = response.json()
        models = result.get("data", [])
        return {
            "models": [
                {"id": m["id"], "type": m.get("type", m.get("model_type", "unknown"))}
                for m in models
                if isinstance(m, dict) and m.get("id")
            ]
        }
    except Exception as exc:
        raise HTTPException(502, rag.provider_error(exc)) from exc


@asynccontextmanager
async def exclusive(sid):
    lock = locks.setdefault(sid, asyncio.Lock())
    if lock.locked():
        raise HTTPException(409, "Another operation is in progress in this workspace. Wait for it to finish.")
    async with lock:
        try:
            yield
        finally:
            locks.pop(sid, None)


@app.post("/api/sources/pdf")
async def add_pdf(request: Request, file: UploadFile = File(...), settings: str = Form("{}")):
    config.require_key("NEBIUS_API_KEY")
    try:
        options = Settings.model_validate_json(settings)
    except ValidationError as exc:
        raise HTTPException(422, "Invalid indexing settings: " + str(exc.errors()[0]["msg"])) from exc
    async with exclusive(request.state.sid):
        rag.validate_workspace(request.state.sid, options.embedding_model)
        data = await file.read(20 * 1024 * 1024 + 1)
        await file.close()
        if len(data) > 20 * 1024 * 1024:
            raise HTTPException(413, "PDFs must be 20 MB or smaller.")
        if not data.startswith(b"%PDF-"):
            raise HTTPException(422, "Upload a valid PDF file.")
        try:
            docs, pages = await asyncio.to_thread(rag.pdf_documents, data)
            return await rag.index_documents(
                request.state.sid,
                Path(file.filename or "Document.pdf").name[:200],
                "pdf",
                "",
                options,
                docs,
                pages,
            )
        except HTTPException:
            raise
        except Exception as exc:
            logger.warning("PDF indexing failed: %s", type(exc).__name__)
            raise HTTPException(502, rag.provider_error(exc)) from exc


@app.post("/api/sources/website")
async def add_website(body: WebsiteRequest, request: Request):
    async with exclusive(request.state.sid):
        try:
            return await rag.index_website(request.state.sid, body.url, body.settings)
        except HTTPException:
            raise
        except Exception as exc:
            logger.warning("Website indexing failed: %s", type(exc).__name__)
            raise HTTPException(502, rag.provider_error(exc)) from exc


@app.delete("/api/sources/{source_id}")
async def remove_source(source_id: str, request: Request):
    async with exclusive(request.state.sid):
        store.delete_source(request.state.sid, source_id)
    return {"ok": True}


@app.delete("/api/messages")
async def clear_chat(request: Request):
    async with exclusive(request.state.sid):
        store.clear_chat(request.state.sid)
    return {"ok": True}


@app.post("/api/chat")
async def chat(body: ChatRequest, request: Request):
    config.require_key("NEBIUS_API_KEY")
    if body.settings.web_search:
        config.require_key("TAVILY_API_KEY")
    if not body.source_ids and not body.settings.web_search:
        raise HTTPException(422, "Select a source or turn on web search first.")
    sid = request.state.sid
    # Acquire before returning headers so busy clients receive a proper 409.
    guard = exclusive(sid)
    await guard.__aenter__()

    async def generate():
        try:
            async with asyncio.timeout(240):
                async for event in rag.answer_stream(sid, body):
                    yield json.dumps(event, ensure_ascii=False) + "\n"
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("Chat failed: %s", type(exc).__name__)
            yield json.dumps({"type": "error", "message": rag.provider_error(exc)}) + "\n"
        finally:
            await guard.__aexit__(None, None, None)

    return StreamingResponse(
        generate(),
        media_type="application/x-ndjson",
        headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"},
    )


# Built frontend is served by the same process and origin in Docker/production.
static_dir = Path(__file__).resolve().parent.parent / "dist"
if static_dir.exists():
    app.mount("/", StaticFiles(directory=static_dir, html=True), name="frontend")
