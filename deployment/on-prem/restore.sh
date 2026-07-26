#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if [[ $# -ne 2 || "$1" != "--from" ]]; then
  echo "Usage: sudo $0 --from /path/to/backup-directory" >&2
  exit 2
fi

SOURCE="$(readlink -f "$2")"
ENV_FILE="${ENV_FILE:-/etc/mediqliq/backend.env}"
[[ -f "$SOURCE/database/hims.archive.gz" ]] || { echo 'MongoDB archive not found.' >&2; exit 1; }
[[ -d "$SOURCE/uploads" ]] || { echo 'Uploads backup not found.' >&2; exit 1; }
[[ -r "$ENV_FILE" ]] || { echo "Cannot read $ENV_FILE" >&2; exit 1; }

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
: "${MONGO_URI:?MONGO_URI is required}"
: "${UPLOAD_DIR:=/srv/mediqliq/uploads}"

read -r -p "This will replace database and uploaded-file data. Type RESTORE to continue: " CONFIRM
[[ "$CONFIRM" == "RESTORE" ]] || { echo 'Restore cancelled.'; exit 1; }

sha256sum -c "$SOURCE/SHA256SUMS"

WAS_ACTIVE=false
if systemctl is-active --quiet mediqliq-backend; then
  WAS_ACTIVE=true
  systemctl stop mediqliq-backend
fi
restart_backend() {
  if [[ "$WAS_ACTIVE" == true ]]; then
    systemctl start mediqliq-backend || true
  fi
}
trap restart_backend EXIT

mongorestore --uri="$MONGO_URI" --archive="$SOURCE/database/hims.archive.gz" --gzip --drop
rsync -a --delete "$SOURCE/uploads/" "$UPLOAD_DIR/"

if [[ "$WAS_ACTIVE" == true ]]; then
  systemctl start mediqliq-backend
fi
trap - EXIT
printf 'Restore completed from %s\n' "$SOURCE"
