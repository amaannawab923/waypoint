#!/usr/bin/env bash
# One-command dev setup: brings up the backend (Postgres + API) via Docker,
# waits for it to be healthy, then launches the desktop app natively.
#
# The desktop app is intentionally NOT containerized — it's a real Electron
# GUI app and needs a native display, which a plain container doesn't have.
# Docker owns the backend; this script is the thin layer that ties both
# halves together into one command.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/waypoint-backend"
FRONTEND_DIR="$ROOT_DIR/waypoint-frontend"

# `command -v docker` only proves the CLI exists — it passes just as
# happily when Docker Desktop is installed but not running, or when only
# the legacy `docker-compose` v1 binary is present (no `compose`
# subcommand). `docker compose ls` catches both: it fails on a missing
# `compose` subcommand the same way `docker compose version` would, but
# unlike `version` — which only prints the local plugin's version without
# ever contacting the daemon — `ls` actually talks to the daemon, so it
# also fails when Docker Desktop is installed but not running, instead of
# a raw "Cannot connect to the Docker daemon" a few lines into the build.
if ! docker compose ls >/dev/null 2>&1; then
  echo "Docker (with Compose v2) is required and must be running. Start Docker Desktop and try again." >&2
  exit 1
fi

# The frontend's Tailwind build depends on a platform-specific native binary
# (@tailwindcss/oxide-*) that requires Node >= 20 — see waypoint-frontend/
# package.json's engines/devEngines and .nvmrc, which pin 22, the version
# this was actually verified against (@electron/notarize, a transitive
# dependency, separately requires >= 22.12.0). On an older Node, npm
# silently skips that optional dependency instead of erroring — the app
# still installs and even starts, but the renderer fails with an opaque
# "Cannot GET /index.html" once the CSS build breaks. Catch it here with an
# actionable message instead of that confusing downstream failure.
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
case "$NODE_MAJOR" in '' | *[!0-9]*) NODE_MAJOR=0 ;; esac
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Node 22+ is required (found $(node -v 2>/dev/null || echo 'none')). If you use nvm: cd waypoint-frontend && nvm install && nvm use, then re-run this script." >&2
  exit 1
fi

if [ ! -f "$BACKEND_DIR/.env" ]; then
  echo "==> No waypoint-backend/.env found — copying .env.example."
  cp "$BACKEND_DIR/.env.example" "$BACKEND_DIR/.env"
fi

echo "==> Starting backend (Postgres + API)..."
(cd "$BACKEND_DIR" && docker compose up -d --build)

echo "==> Waiting for the API to become healthy..."
for i in $(seq 1 60); do
  if curl -sf http://localhost:4000/health >/dev/null 2>&1; then
    echo "Backend is up (http://localhost:4000)."
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "Backend did not become healthy within 2 minutes." >&2
    echo "Check the logs: (cd $BACKEND_DIR && docker compose logs)" >&2
    exit 1
  fi
  sleep 2
done

if [ ! -d "$FRONTEND_DIR/node_modules" ]; then
  echo "==> Installing frontend dependencies (first run only)..."
  # npm ci, not npm install: deterministic against the committed lockfile
  # (the one this repo's Node 22 pin exists to keep correct — see the
  # comment on the version check above) and it refuses to proceed on a
  # lockfile/package.json mismatch instead of silently rewriting the
  # lockfile this script's caller didn't ask to change.
  (cd "$FRONTEND_DIR" && npm ci)
fi

echo "==> Launching the desktop app..."
(cd "$FRONTEND_DIR" && npm start)
