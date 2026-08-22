#!/bin/sh
set -e

echo "Applying database migrations..."
npx drizzle-kit migrate

echo "Checking for existing data..."
npx tsx src/db/seedIfEmpty.ts

exec "$@"
