#!/usr/bin/env bash
set -euo pipefail
if [[ $# -ne 2 ]]; then echo "Usage: $0 BACKUP.dump TARGET_DATABASE_URL" >&2; exit 2; fi
BACKUP="$1"; TARGET="$2"
[[ -s "$BACKUP" ]] || { echo "Backup file missing or empty" >&2; exit 1; }
echo "WARNING: this will replace objects in the TARGET database: $TARGET"
read -r -p "Type RESTORE to continue: " CONFIRM
[[ "$CONFIRM" == "RESTORE" ]] || { echo "Cancelled"; exit 1; }
pg_restore --clean --if-exists --no-owner --dbname="$TARGET" "$BACKUP"
psql "$TARGET" -v ON_ERROR_STOP=1 -c "SELECT (SELECT count(*) FROM entities) AS entities, (SELECT count(*) FROM relationships) AS relationships;"
