#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ENV_FILE="${ENV_FILE:-/etc/mediqliq/backend.env}"
BACKUP_ROOT="${BACKUP_ROOT:-/mnt/mediqliq-backup}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
LOCK_FILE="${LOCK_FILE:-/var/lock/mediqliq-backup.lock}"

exec 9>"$LOCK_FILE"
flock -n 9 || { echo 'Another MediQliq backup is already running.' >&2; exit 1; }

[[ -r "$ENV_FILE" ]] || { echo "Cannot read $ENV_FILE" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
: "${MONGO_URI:?MONGO_URI is required in the backend environment file}"
: "${UPLOAD_DIR:=/srv/mediqliq/uploads}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$BACKUP_ROOT/$STAMP"
TMP="$DEST.incomplete"
mkdir -p "$TMP/database" "$TMP/uploads"

cleanup() { rm -rf "$TMP"; }
trap cleanup ERR INT TERM

mongodump --uri="$MONGO_URI" --archive="$TMP/database/hims.archive.gz" --gzip
rsync -a --delete-delay "$UPLOAD_DIR/" "$TMP/uploads/"
sha256sum "$TMP/database/hims.archive.gz" > "$TMP/SHA256SUMS"
printf 'created_utc=%s\nsource_upload_dir=%s\n' "$STAMP" "$UPLOAD_DIR" > "$TMP/manifest.txt"

mv "$TMP" "$DEST"
trap - ERR INT TERM
find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime "+$RETENTION_DAYS" -print -exec rm -rf {} +
printf 'Backup completed: %s\n' "$DEST"
