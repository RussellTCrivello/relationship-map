#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/backups"
STAMP="$(date +%Y%m%d-%H%M%S)"
: "${DATABASE_URL:?Set DATABASE_URL in environment or .env}"
OUT="$ROOT/backups/relationship-map-$STAMP.dump"
pg_dump --format=custom --no-owner --file="$OUT" "$DATABASE_URL"
test -s "$OUT"
echo "Backup created: $OUT"
