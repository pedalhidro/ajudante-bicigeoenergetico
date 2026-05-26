#!/usr/bin/env bash
#
# Sync this repo to amora.pedalhidrografi.co (GCE instance: pedalhidro) via
# rsync over SSH, then restart the Flask service that serves web/ as static
# + handles /upload-image. Same backend code as the Pi (backend/pi/main.py).
#
# Usage:
#   scripts/deploy-amora.sh             # rsync + restart service
#   scripts/deploy-amora.sh --dry-run   # preview, no transfer/restart
#
# Overridable via env:
#   AMORA_HOST       FQDN or ssh-config alias    (default: amora.pedalhidrografi.co)
#   AMORA_USER       SSH user                    (default: $USER)
#   AMORA_PATH       repo path on the instance   (default: /home/$AMORA_USER/pedalhidrografico)
#   PHIDRO_SERVICE   systemd unit name           (default: phidro.service)
#   RSYNC_EXTRA      extra args to rsync         (default: empty)
#
# Excludes (runtime state on the server — never overwritten):
#   web/photos/                  uploaded image variants per phash
#   web/data/photos.ttl          catálogo gerado pelos uploads
#   web/data/uploads.ttl         idem (variante)
#   web/data/data_graphs.ttl     manifesto void:Dataset
#   backend/pi/data/             legacy data dir (Pi only)
#
# Requirements:
#   - rsync installed locally
#   - SSH access to amora (gcloud compute config-ssh, or direct key on host)
#   - sudo on amora to restart phidro.service (or set PHIDRO_SERVICE="" to skip)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

AMORA_HOST="${AMORA_HOST:-amora.pedalhidrografi.co}"
AMORA_USER="${AMORA_USER:-$USER}"
AMORA_PATH="${AMORA_PATH:-/home/${AMORA_USER}/pedalhidrografico}"
PHIDRO_SERVICE="${PHIDRO_SERVICE:-phidro.service}"
RSYNC_EXTRA="${RSYNC_EXTRA:-}"

# ─── Argument parsing ────────────────────────────────────────────────────────
DRY=()
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY=(--dry-run)
  echo "↻ DRY RUN — no remote changes will be made."
fi

# ─── Pre-flight ──────────────────────────────────────────────────────────────
if ! command -v rsync >/dev/null 2>&1; then
  echo "ERROR: rsync not found locally." >&2
  exit 1
fi
if [[ ! -d "$REPO_ROOT/web" ]]; then
  echo "ERROR: $REPO_ROOT/web missing." >&2
  exit 1
fi
if [[ ! -f "$REPO_ROOT/web/routes.json" ]]; then
  echo "→ web/routes.json missing — building com 'python scripts/build-routes.py'…"
  (cd "$REPO_ROOT" && python scripts/build-routes.py)
fi

DEST="${AMORA_USER}@${AMORA_HOST}:${AMORA_PATH}/"
echo "→ Syncing $REPO_ROOT  →  $DEST"

# --delete remove órfãos no destino, exceto os caminhos --exclude (estado
# de runtime do servidor — preservado entre deploys).
# shellcheck disable=SC2086
rsync -avz --human-readable \
  ${DRY[@]+"${DRY[@]}"} \
  --delete \
  --exclude='.git/' \
  --exclude='.DS_Store' \
  --exclude='__pycache__/' \
  --exclude='*.pyc' \
  --exclude='*.pyo' \
  --exclude='*.swp' \
  --exclude='.venv/' \
  --exclude='node_modules/' \
  --exclude='web/photos/' \
  --exclude='web/data/photos.ttl' \
  --exclude='web/data/uploads.ttl' \
  --exclude='web/data/data_graphs.ttl' \
  --exclude='backend/pi/data/' \
  $RSYNC_EXTRA \
  "$REPO_ROOT/" "$DEST"

# ─── Service restart ─────────────────────────────────────────────────────────
if [[ "${#DRY[@]}" -eq 0 && -n "$PHIDRO_SERVICE" ]]; then
  echo "→ Restarting $PHIDRO_SERVICE em $AMORA_HOST"
  ssh "${AMORA_USER}@${AMORA_HOST}" "sudo systemctl restart $PHIDRO_SERVICE"
  # Saúde rápida: confirma que voltou rodando.
  ssh "${AMORA_USER}@${AMORA_HOST}" "systemctl is-active $PHIDRO_SERVICE" || {
    echo "WARN: $PHIDRO_SERVICE não está active após restart. Veja:"
    echo "  ssh ${AMORA_USER}@${AMORA_HOST} 'sudo journalctl -u $PHIDRO_SERVICE -n 50 --no-pager'"
    exit 2
  }
fi

echo "✓ Done."
echo "  Public URL: https://${AMORA_HOST}/"
