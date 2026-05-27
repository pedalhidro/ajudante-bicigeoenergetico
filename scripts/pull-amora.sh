#!/usr/bin/env bash
#
# Inverso de scripts/deploy-amora.sh: puxa do GCE (`phidro`) para o repo
# local o estado vivo do servidor — `web/photos/` (variantes de imagem)
# e `web/data/` (catálogos TTL gerados pelos uploads). Usa o mesmo
# transporte (`gcloud compute ssh` via wrapper IAP).
#
# Usage:
#   scripts/pull-amora.sh                # photos + data
#   scripts/pull-amora.sh --dry-run      # preview, sem baixar
#   scripts/pull-amora.sh --photos-only  # só web/photos/
#   scripts/pull-amora.sh --data-only    # só web/data/
#
# Overridable via env (mesmas defaults do deploy):
#   AMORA_INSTANCE   default: phidro
#   AMORA_ZONE       default: southamerica-east1-a
#   AMORA_PROJECT    default: gcloud config atual
#   AMORA_USER       default: danlessa
#   AMORA_PATH       default: /home/danlessa/pedalhidrografico
#   RSYNC_EXTRA      args extras pro rsync
#
# IMPORTANTE: este script NÃO usa --delete. Arquivos locais que não
# existem mais no servidor são preservados (segurança: pull não destrói).
# Se quiser espelhar exato, passe `RSYNC_EXTRA=--delete`.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

AMORA_INSTANCE="${AMORA_INSTANCE:-phidro}"
AMORA_ZONE="${AMORA_ZONE:-southamerica-east1-a}"
AMORA_USER="${AMORA_USER:-danlessa}"
AMORA_PATH="${AMORA_PATH:-/home/danlessa/pedalhidrografico}"
RSYNC_EXTRA="${RSYNC_EXTRA:-}"

# ─── Argument parsing ────────────────────────────────────────────────────────
DRY=()
SYNC_PHOTOS=1
SYNC_DATA=1
for arg in "$@"; do
  case "$arg" in
    --dry-run)     DRY=(--dry-run); echo "↻ DRY RUN — nada será baixado." ;;
    --photos-only) SYNC_DATA=0 ;;
    --data-only)   SYNC_PHOTOS=0 ;;
    -h|--help)
      sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Argumento desconhecido: $arg" >&2; exit 2 ;;
  esac
done

# ─── Pre-flight ──────────────────────────────────────────────────────────────
if ! command -v rsync >/dev/null 2>&1; then
  echo "ERROR: rsync not found locally." >&2
  exit 1
fi
if ! command -v gcloud >/dev/null 2>&1; then
  echo "ERROR: gcloud CLI não encontrado." >&2
  exit 1
fi

SSH_WRAPPER="$REPO_ROOT/scripts/gcloud-ssh-rsync.sh"
if [[ ! -x "$SSH_WRAPPER" ]]; then
  echo "ERROR: wrapper SSH não encontrado em $SSH_WRAPPER" >&2
  exit 1
fi
export AMORA_ZONE AMORA_PROJECT

# ─── Progress flag (3.1+ ganha barra global; macOS 2.6.9 fica em --progress) ─
PROGRESS=(--progress)
if rsync --version 2>/dev/null | awk 'NR==1{
  split($3, v, ".");
  if ((v[1]+0) > 3 || ((v[1]+0) == 3 && (v[2]+0) >= 1)) exit 0;
  exit 1;
}'; then
  PROGRESS=(--info=progress2,name0)
fi

# ─── Pull function ──────────────────────────────────────────────────────────
pull_dir() {
  local subdir="$1"
  local src="${AMORA_USER}@${AMORA_INSTANCE}:${AMORA_PATH}/${subdir}/"
  local dst="$REPO_ROOT/${subdir}/"
  mkdir -p "$dst"
  echo "→ Pulling  $src  →  $dst  (via IAP)"
  # shellcheck disable=SC2086
  rsync -rltvz --human-readable --rsync-path='sudo rsync' "${PROGRESS[@]}" \
    --no-perms --no-owner --no-group \
    ${DRY[@]+"${DRY[@]}"} \
    -e "$SSH_WRAPPER" \
    $RSYNC_EXTRA \
    "$src" "$dst"
}

# ─── Execute ─────────────────────────────────────────────────────────────────
[[ "$SYNC_DATA"   -eq 1 ]] && pull_dir "web/data"
[[ "$SYNC_PHOTOS" -eq 1 ]] && pull_dir "web/photos"

echo "✓ Done."
