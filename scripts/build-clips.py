#!/usr/bin/env python3
"""Varre `web/clips/` e gera `web/clips/clips.json` com lat/lng/duração/etc.

O app web não tem como ler EXIF de arquivos .MOV/.mp4 no browser de forma
robusta — então pré-extraímos os metadados via `exiftool` (já usado em outros
scripts do projeto) e servimos um índice estático.

Cada entrada:
    {
      "file": "IMG_4761.MOV",
      "lat": -23.4506,
      "lng": -46.7073,
      "duration": 9.17,
      "width": 2160,
      "height": 3840,
      "date": "2026:05:26 21:08:04"
    }

Roda assim:
    python scripts/build-clips.py
"""
from __future__ import annotations
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent
# Fontes em `web/clips/raw/`; saídas otimizadas em `web/clips/` (servidas
# pelo app). Catálogo + manifesto em `web/clips/clips.json`. Áudio extraído
# vai em `web/clips/audio/` pra um loop ambiente independente do vídeo.
CLIPS_OUT_DIR = ROOT / 'web' / 'clips'
CLIPS_RAW_DIR = CLIPS_OUT_DIR / 'raw'
AUDIO_OUT_DIR = CLIPS_OUT_DIR / 'audio'
OUT_PATH = CLIPS_OUT_DIR / 'clips.json'
EXTS = {'.mov', '.mp4', '.m4v'}
# Sufixos das versões transcodificadas. 360p é o default; 720p existe pra
# quando o app pedir mais qualidade (opt-in em Ajustes).
SHARE_SUFFIX = '.360p.mp4'
SHARE_SUFFIX_HD = '.720p.mp4'
AUDIO_SUFFIX = '.m4a'

# ExifTool imprime GPS em formato "23 deg 27' 2.16" S" — parse pra decimal.
DMS_RE = re.compile(
    r'^\s*(\d+)\s*deg\s*(\d+)\'\s*([\d.]+)"\s*([NSEW])\s*$'
)

def dms_to_decimal(s: str) -> float | None:
    m = DMS_RE.match(s)
    if not m:
        return None
    deg = float(m.group(1))
    minutes = float(m.group(2))
    seconds = float(m.group(3))
    hemi = m.group(4)
    dec = deg + minutes / 60 + seconds / 3600
    if hemi in ('S', 'W'):
        dec = -dec
    return round(dec, 6)


def to_float(v: str) -> float | None:
    if not v:
        return None
    # Duration vem como "9.17 s" ou "0:00:09" — só os números na frente.
    m = re.match(r'^[\s]*([\d.]+)', v)
    return float(m.group(1)) if m else None


def to_int(v: str) -> int | None:
    if not v:
        return None
    m = re.match(r'^[\s]*(\d+)', v)
    return int(m.group(1)) if m else None


def parse_exiftool(path: Path) -> dict | None:
    try:
        out = subprocess.check_output([
            'exiftool',
            '-GPSLatitude', '-GPSLongitude',
            '-Duration', '-MediaDuration', '-TrackDuration',
            '-ImageWidth', '-ImageHeight',
            '-CreateDate',
            '-s',  # short field names
            str(path),
        ], text=True)
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        print(f'  [{path.name}] exiftool failed: {e}', file=sys.stderr)
        return None

    fields: dict[str, str] = {}
    for line in out.splitlines():
        if ':' in line:
            k, _, v = line.partition(':')
            fields[k.strip()] = v.strip()

    lat = dms_to_decimal(fields.get('GPSLatitude', ''))
    lng = dms_to_decimal(fields.get('GPSLongitude', ''))
    if lat is None or lng is None:
        print(f'  [{path.name}] sem GPS — pulando', file=sys.stderr)
        return None

    # `Duration` no MOV/MP4 às vezes vem no track de áudio também. Pegamos
    # o primeiro que existir e for parseável.
    duration = None
    for k in ('Duration', 'MediaDuration', 'TrackDuration'):
        v = to_float(fields.get(k, ''))
        if v and v > 0:
            duration = v
            break

    return {
        'file': path.name,
        'lat': lat,
        'lng': lng,
        'duration': duration,
        'width': to_int(fields.get('ImageWidth', '')),
        'height': to_int(fields.get('ImageHeight', '')),
        'date': fields.get('CreateDate') or None,
    }


def extract_audio(src: Path, dst: Path) -> bool:
    """Extrai a trilha de áudio do clipe pra AAC 96 kbps em `.m4a`.
    Pula se `dst` já existe e é mais novo que o source."""
    if dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime:
        return True
    try:
        subprocess.check_call([
            'ffmpeg', '-y', '-i', str(src),
            '-vn',                    # descarta vídeo
            '-c:a', 'aac', '-b:a', '96k',
            '-movflags', '+faststart',
            '-loglevel', 'error',
            str(dst),
        ])
        return True
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        print(f'  [{src.name}] audio extract failed: {e}', file=sys.stderr)
        return False


def _transcode(src: Path, dst: Path, target_short_side: int) -> bool:
    """Re-encoda `src` pra mp4 com lado menor = `target_short_side` px,
    h264 + AAC + faststart. Pula se `dst` existe e é mais novo que o source."""
    if dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime:
        return True
    s = target_short_side
    try:
        subprocess.check_call([
            'ffmpeg', '-y', '-i', str(src),
            '-vf', f"scale='if(gt(iw,ih),-2,{s})':'if(gt(iw,ih),{s},-2)'",
            '-c:v', 'libx264',
            '-preset', 'fast',
            '-crf', '28',
            '-movflags', '+faststart',
            '-c:a', 'aac', '-b:a', '96k',
            '-loglevel', 'error',
            str(dst),
        ])
        return True
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        print(f'  [{src.name}] ffmpeg failed ({s}p): {e}', file=sys.stderr)
        return False

def transcode_360p(src: Path, dst: Path) -> bool: return _transcode(src, dst, 360)
def transcode_720p(src: Path, dst: Path) -> bool: return _transcode(src, dst, 720)


def main() -> int:
    if not CLIPS_RAW_DIR.is_dir():
        print(f'raw clips dir not found: {CLIPS_RAW_DIR}', file=sys.stderr)
        return 1
    CLIPS_OUT_DIR.mkdir(parents=True, exist_ok=True)
    AUDIO_OUT_DIR.mkdir(parents=True, exist_ok=True)

    clips = []
    for p in sorted(CLIPS_RAW_DIR.iterdir()):
        if p.suffix.lower() not in EXTS:
            continue
        meta = parse_exiftool(p)
        if not meta:
            continue
        # Gera (ou reaproveita) a versão 360p em `web/clips/`; aponta
        # clips.json pra ela. Também gera a 720p (opt-in via Ajustes no app).
        share_name = p.stem + SHARE_SUFFIX
        share_path = CLIPS_OUT_DIR / share_name
        if not transcode_360p(p, share_path):
            continue
        size_kb = share_path.stat().st_size / 1024
        meta['file'] = share_name
        meta['sizeKB'] = round(size_kb, 1)
        # 720p — falha não bloqueia o clipe; se faltar, o app cai pro 360p.
        hd_name = p.stem + SHARE_SUFFIX_HD
        hd_path = CLIPS_OUT_DIR / hd_name
        if transcode_720p(p, hd_path):
            meta['file720'] = hd_name
            meta['sizeKB720'] = round(hd_path.stat().st_size / 1024, 1)
        # Trilha de áudio em `web/clips/audio/<base>.m4a` pra o loop
        # ambiente. Falhar a extração não bloqueia o clipe — só não
        # listamos no campo `audio`.
        audio_name = p.stem + AUDIO_SUFFIX
        audio_path = AUDIO_OUT_DIR / audio_name
        if extract_audio(p, audio_path):
            meta['audio'] = f'audio/{audio_name}'
            audio_kb = audio_path.stat().st_size / 1024
            meta['audioKB'] = round(audio_kb, 1)
        clips.append(meta)
        audio_tag = f' + audio {meta.get("audioKB", "?")} KB' if 'audio' in meta else ''
        print(f'  ok {share_name}  lat={meta["lat"]} lng={meta["lng"]} '
              f'dur={meta["duration"]}  {size_kb:.0f} KB{audio_tag}')

    OUT_PATH.write_text(json.dumps(clips, indent=2, ensure_ascii=False))
    print(f'\nWrote {OUT_PATH.relative_to(ROOT)} ({len(clips)} clips)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
