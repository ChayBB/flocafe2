#!/usr/bin/env bash
set -euo pipefail
mkdir -p backups
chmod 700 backups
stamp=$(date -u +%Y%m%dT%H%M%SZ)
docker compose exec -T postgres pg_dump -U qrserver -Fc qrserver > "backups/qrserver-${stamp}.dump"
chmod 600 "backups/qrserver-${stamp}.dump"
echo "Backup saved locally; copy encrypted backup offsite and test restore regularly."
