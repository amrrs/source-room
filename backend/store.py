"""A browser-scoped SQLite document/vector store. No pickle or shared vector namespace."""

import json
import secrets
import sqlite3
import time
from contextlib import contextmanager

from . import config


@contextmanager
def db():
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(config.DATA_DIR / "workspace.sqlite3", timeout=20)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    try:
        yield con
        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()


def init():
    with db() as c:
        c.executescript("""
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, authorized INTEGER DEFAULT 0, created REAL);
        CREATE TABLE IF NOT EXISTS sources(
            id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
            name TEXT, kind TEXT, url TEXT, model TEXT, chunks INTEGER, pages INTEGER, created REAL);
        CREATE TABLE IF NOT EXISTS chunks(
            source_id TEXT REFERENCES sources(id) ON DELETE CASCADE,
            content TEXT, page INTEGER, vector TEXT);
        CREATE TABLE IF NOT EXISTS messages(
            id INTEGER PRIMARY KEY, session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE, payload TEXT);
        CREATE INDEX IF NOT EXISTS sources_session ON sources(session_id);
        CREATE INDEX IF NOT EXISTS chunks_source ON chunks(source_id);
        CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id);
        """)


def session(token=None):
    with db() as c:
        # Bound retention for abandoned browser workspaces.
        c.execute("DELETE FROM sessions WHERE created < ?", (time.time() - 30 * 86400,))
        row = c.execute("SELECT * FROM sessions WHERE id=?", (token,)).fetchone() if token else None
        if row:
            return dict(row), False
        token = secrets.token_urlsafe(32)
        c.execute("INSERT INTO sessions VALUES (?,0,?)", (token, time.time()))
        return {"id": token, "authorized": 0}, True


def sources(sid):
    with db() as c:
        return [
            dict(r)
            for r in c.execute(
                "SELECT id,name,kind,url,model,chunks,pages,created FROM sources WHERE session_id=? ORDER BY created",
                (sid,),
            )
        ]


def save_source(sid, name, kind, url, model, docs, vectors, pages):
    source_id = secrets.token_hex(12)
    with db() as c:
        existing = c.execute("SELECT model FROM sources WHERE session_id=?", (sid,)).fetchall()
        if len(existing) >= 30:
            raise ValueError("This workspace has reached its 30-source limit.")
        if any(row["model"] != model for row in existing):
            raise ValueError("Use the workspace embedding model, or remove all sources before changing it.")
        c.execute(
            "INSERT INTO sources VALUES (?,?,?,?,?,?,?,?,?)",
            (source_id, sid, name, kind, url, model, len(docs), pages, time.time()),
        )
        c.executemany(
            "INSERT INTO chunks VALUES (?,?,?,?)",
            [
                (source_id, d.page_content, d.metadata.get("page"), json.dumps(v))
                for d, v in zip(docs, vectors, strict=True)
            ],
        )
    return next(s for s in sources(sid) if s["id"] == source_id)


def chunks(sid, ids):
    if not ids:
        return []
    with db() as c:
        rows = c.execute(
            f"SELECT c.*,s.name,s.kind,s.url,s.model FROM chunks c JOIN sources s ON c.source_id=s.id WHERE s.session_id=? AND s.id IN ({','.join('?' for _ in ids)})",
            [sid, *ids],
        )
        return [{**dict(r), "vector": json.loads(r["vector"])} for r in rows]


def delete_source(sid, source_id):
    with db() as c:
        c.execute("DELETE FROM sources WHERE id=? AND session_id=?", (source_id, sid))


def messages(sid):
    with db() as c:
        return [
            json.loads(r[0])
            for r in c.execute(
                "SELECT payload FROM (SELECT id,payload FROM messages WHERE session_id=? ORDER BY id DESC LIMIT 100) ORDER BY id",
                (sid,),
            )
        ]


def append_messages(sid, *items):
    with db() as c:
        c.executemany(
            "INSERT INTO messages(session_id,payload) VALUES (?,?)",
            [(sid, json.dumps(item)) for item in items],
        )
        c.execute(
            "DELETE FROM messages WHERE session_id=? AND id NOT IN (SELECT id FROM messages WHERE session_id=? ORDER BY id DESC LIMIT 100)",
            (sid, sid),
        )


def clear_chat(sid):
    with db() as c:
        c.execute("DELETE FROM messages WHERE session_id=?", (sid,))
