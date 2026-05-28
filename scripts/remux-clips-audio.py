"""Remixa o áudio separado nos webms de vídeo dos clipes já existentes.

Histórico: até v224 do transcode browser-side, os webms de vídeo subidos
via upload_images.html não tinham trilha de áudio — o áudio vivia num
arquivo paralelo `<vhash>.audio.webm`. O ghost-video player no iOS
Safari fica mudo nesses clipes (e em geral, audio só toca via audio
loop). v225+ embute o áudio direto no webm. Este script faz a migração
dos clipes já em disco/bucket: mux do video+áudio existentes num único
webm, sem re-encode (ffmpeg `-c copy`), substituindo o arquivo original
atomicamente.

Não toca em:
  - .mp4 (já tem áudio AAC embutido, do build-clips.py)
  - webms que já têm áudio (idempotente — confere via ffprobe antes)
  - clipes audio-only (sem .360p/.720p.webm correspondente)

Uso:
    python scripts/remux-clips-audio.py             # remixa in-place
    python scripts/remux-clips-audio.py --dry-run   # só lista o que faria
"""
from __future__ import annotations
import argparse
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CLIPS_DIR = ROOT / "web" / "clips"

# Pares (video, audio): mesmo stem antes do sufixo de resolução.
# `<vhash>.360p.webm` ou `<vhash>.720p.webm` <- pareados com `<vhash>.audio.webm`.
VIDEO_RE = re.compile(r"^(?P<stem>.+)\.(?P<res>360p|720p)\.webm$")


def has_audio_stream(path: Path) -> bool:
    """Retorna True se o webm já tem stream de áudio (skip remux nesse caso)."""
    try:
        out = subprocess.check_output([
            "ffprobe", "-v", "error",
            "-select_streams", "a",
            "-show_entries", "stream=index",
            "-of", "csv=p=0",
            str(path),
        ], text=True)
        return bool(out.strip())
    except (subprocess.CalledProcessError, FileNotFoundError):
        return False


def remux(video: Path, audio: Path, dry_run: bool) -> bool:
    """Mux video+audio em um único webm via ffmpeg `-c copy` (sem re-encode).
    Escreve num temp e renomeia atomicamente quando termina."""
    # Temp com `.tmp.webm` (sufixo .webm no fim) — ffmpeg precisa do
    # extension reconhecido pra escolher o muxer, e o flag `-f webm`
    # cobre o caso de não dar pra adivinhar.
    tmp = video.with_name(video.name + ".tmp.webm")
    print(f"  remux: {video.name}  +  {audio.name}  →  (in-place)")
    if dry_run:
        return True
    try:
        subprocess.check_call([
            "ffmpeg", "-y",
            "-i", str(video),
            "-i", str(audio),
            "-map", "0:v:0",
            "-map", "1:a:0",
            "-c", "copy",
            "-shortest",
            "-f", "webm",
            "-loglevel", "error",
            str(tmp),
        ])
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        print(f"  [{video.name}] ffmpeg falhou: {e}", file=sys.stderr)
        tmp.unlink(missing_ok=True)
        return False
    shutil.move(str(tmp), str(video))
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="apenas lista os pares; nenhum arquivo é alterado")
    args = ap.parse_args()

    if not CLIPS_DIR.is_dir():
        print(f"clips dir não encontrado: {CLIPS_DIR}", file=sys.stderr)
        return 1
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        print("ffmpeg/ffprobe ausentes do PATH (brew install ffmpeg).", file=sys.stderr)
        return 1

    remuxed = skipped_has_audio = skipped_no_audio_file = failed = 0
    for video in sorted(CLIPS_DIR.iterdir()):
        m = VIDEO_RE.match(video.name)
        if not m:
            continue
        stem = m.group("stem")
        audio = CLIPS_DIR / f"{stem}.audio.webm"
        if not audio.exists():
            skipped_no_audio_file += 1
            continue
        if has_audio_stream(video):
            skipped_has_audio += 1
            continue
        if remux(video, audio, args.dry_run):
            remuxed += 1
        else:
            failed += 1

    print(f"\n✓ {remuxed} remixado(s) · "
          f"{skipped_has_audio} já com áudio · "
          f"{skipped_no_audio_file} sem .audio.webm par · "
          f"{failed} falharam.")
    if args.dry_run:
        print("  (DRY RUN — nada foi gravado)")
    return 0 if failed == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
