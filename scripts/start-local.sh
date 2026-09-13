#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")/.."
if [ ! -f .env ]; then cp .env.example .env; fi
uv sync --frozen
npm ci
npm run build
exec uv run uvicorn backend.main:app --host 127.0.0.1 --port "${PORT:-8000}" --workers 1
