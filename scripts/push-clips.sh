#!/usr/bin/env bash
#
# Push targeted: só sincroniza `web/clips/` (vídeos transcodificados) pro
# amora, ignorando `web/clips/raw/` (originais, ~800MB). Não reinicia o
# serviço — clips são estáticos, o Flask serve direto.
#
# Usage:
#   scripts/push-clips.sh             # sync incremental
#   scripts/push-clips.sh --dry-run   # preview sem transferir
#
# Overridable via env (mesmas defaults do deploy):
#   AMORA_INSTANCE   default: phidro
#   AMORA_ZONE       default: southamerica-east1-a
#   AMORA_PROJECT    default: gcloud config atual
#   AMORA_USER       default: danlessa
#   AMORA_PATH       default: /home/danlessa/pedalhidrografico
#   RSYNC_EXTRA      args extras (ex.: --delete pra espelhar exato)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

AMORA_INSTANCE="${AMORA_INSTANCE:-phidro}"
AMORA_ZONE="${AMORA_ZONE:-southamerica-east1-a}"
AMORA_USER="${AMORA_USER:-danlessa}"
AMORA_PATH="${AMORA_PATH:-/home/danlessa/pedalhidrografico}"
RSYNC_EXTRA="${RSYNC_EXTRA:-}"

# ─── Argument parsing ────────────────────────────────────────────────────────
DRY=()
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY=(--dry-run)
  echo "↻ DRY RUN — nada será transferido."
fi

# ─── Pre-flight ──────────────────────────────────────────────────────────────
if ! command -v rsync >/dev/null 2>&1; then
  echo "ERROR: rsync not found locally." >&2
  exit 1
fi
if ! command -v gcloud >/dev/null 2>&1; then
  echo "ERROR: gcloud CLI não encontrado." >&2
  exit 1
fi

SRC="$REPO_ROOT/web/clips"
if [[ ! -d "$SRC" ]]; then
  echo "ERROR: $SRC não existe localmente." >&2
  exit 1
fi

SSH_WRAPPER="$REPO_ROOT/scripts/gcloud-ssh-rsync.sh"
if [[ ! -x "$SSH_WRAPPER" ]]; then
  echo "ERROR: wrapper SSH não encontrado em $SSH_WRAPPER" >&2
  exit 1
fi
export AMORA_ZONE AMORA_PROJECT

# ─── Progress flag (3.1+ ganha barra global; macOS 2.6.9 usa --progress) ────
PROGRESS=(--progress)
if rsync --version 2>/dev/null | awk 'NR==1{
  split($3, v, ".");
  if ((v[1]+0) > 3 || ((v[1]+0) == 3 && (v[2]+0) >= 1)) exit 0;
  exit 1;
}'; then
  PROGRESS=(--info=progress2,name0)
fi

# ─── rsync ───────────────────────────────────────────────────────────────────
DEST="${AMORA_USER}@${AMORA_INSTANCE}:${AMORA_PATH}/web/clips/"
echo "→ Push  $SRC/  →  $DEST  (via IAP)"

# -rltz (sem -a) pra ignorar perms/owner/group; --rsync-path='sudo rsync'
# pro caso da árvore destino ter mistura de donos. Sem --delete por padrão
# (preserva clips que existem no servidor mas não local).
# shellcheck disable=SC2086
rsync -rltvz --human-readable --rsync-path='sudo rsync' "${PROGRESS[@]}" \
  --no-perms --no-owner --no-group \
  ${DRY[@]+"${DRY[@]}"} \
  -e "$SSH_WRAPPER" \
  --exclude='raw/' \
  --exclude='.DS_Store' \
  $RSYNC_EXTRA \
  "$SRC/" "$DEST"

echo "✓ Done."
