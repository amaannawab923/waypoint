#!/usr/bin/env bash
# Stops the backend containers started by dev.sh. Data in the Postgres
# volume is left intact — pass --wipe to also delete it.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/waypoint-backend"

if [ "${1:-}" = "--wipe" ]; then
  echo "==> Stopping backend and deleting its data volume..."
  (cd "$BACKEND_DIR" && docker compose down -v)
else
  echo "==> Stopping backend (data volume kept — use --wipe to also delete it)..."
  (cd "$BACKEND_DIR" && docker compose down)
fi
