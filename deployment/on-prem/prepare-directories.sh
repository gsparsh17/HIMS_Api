#!/usr/bin/env bash
set -Eeuo pipefail

SERVICE_USER="${SERVICE_USER:-mediqliq}"
SERVICE_GROUP="${SERVICE_GROUP:-mediqliq}"

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  sudo useradd --system --home /opt/mediqliq --shell /usr/sbin/nologin "$SERVICE_USER"
fi

sudo install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0750 \
  /opt/mediqliq/backend \
  /srv/mediqliq/uploads \
  /srv/mediqliq/tmp \
  /var/www/mediqliq \
  /etc/mediqliq \
  /etc/mediqliq/tls

printf 'Prepared MediQliq application and storage directories.\n'
