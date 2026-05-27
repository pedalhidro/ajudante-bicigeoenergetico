#!/usr/bin/env python3
"""Varre `web/clips/raw/`, re-encoda cada fonte pra 360p+720p mp4 +
áudio .m4a em `web/clips/`, e registra cada clipe como ph:Video em
`web/data/uploads.ttl` (catálogo único — não há mais clips.json).

Cada ph:Video carrega:
  - IRI determinístico `phd:video_<md5(stem)[:16]>` (idempotente)
  - dcterms:date              (CreateDate do EXIF, fuso de SP)
  - schema:locationCreated    (GeoCoordinates lat/lng)
  - schema:duration           (xsd:duration PT…S)
  - ph:audio / ph:video360p / ph:video720p (paths sob web/clips/)
  - ph:availableResolution    ("audio", "360p", "720p")
  - prov:wasAttributedTo / pav:providedBy → phd:pessoaDandan (default)
  - dcterms:license <CC BY-SA 4.0>

Requisitos: ffmpeg + exiftool no PATH.

Roda:
    python scripts/build-clips.py
"""
from __future__ import annotations
import hashlib
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

from rdflib import BNode, Graph, Literal, Namespace, URIRef
from rdflib.namespace import RDF, XSD


ROOT = Path(__file__).resolve().parent.parent
CLIPS_OUT_DIR = ROOT / "web" / "clips"
CLIPS_RAW_DIR = CLIPS_OUT_DIR / "raw"
AUDIO_OUT_DIR = CLIPS_OUT_DIR / "audio"
UPLOADS_TTL   = ROOT / "web" / "data" / "uploads.ttl"
TOURS_TTL     = ROOT / "web" / "data" / "tours.ttl"

# Janela pra associar clipe a passeio: ±12h em torno do passeio.
TOUR_WINDOW_SEC = 12 * 3600

EXTS = {".mov", ".mp4", ".m4v"}
SHARE_SUFFIX    = ".360p.mp4"
SHARE_SUFFIX_HD = ".720p.mp4"
AUDIO_SUFFIX    = ".m4a"
THUMB_SUFFIX    = ".thumb.jpg"

PH    = Namespace("https://pedalhidrografi.co/terms#")
PHD   = Namespace("https://pedalhidrografi.co/data/")
SCHEMA = Namespace("https://schema.org/")
DCT   = Namespace("http://purl.org/dc/terms/")
PROV  = Namespace("http://www.w3.org/ns/prov#")
PAV   = Namespace("http://purl.org/pav/")

DEFAULT_AUTHOR   = URIRef(PHD + "pessoaDandan")
DEFAULT_PROVIDER = URIRef(PHD + "pessoaDandan")
DEFAULT_LICENSE  = URIRef("https://creativecommons.org/licenses/by-sa/4.0/")
LOCAL_TZ = "-03:00"  # São Paulo, sem DST desde 2019

# ExifTool imprime GPS em formato `23 deg 27' 2.16" S` — parse pra decimal.
DMS_RE = re.compile(r"^\s*(\d+)\s*deg\s*(\d+)\'\s*([\d.]+)\"\s*([NSEW])\s*$")
# CreateDate vem como "2026:05:27 00:52:34" (sem fuso) — mvhd, hora de save.
DATE_RE = re.compile(r"^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$")
# CreationDate (Apple) vem como "2026:05:26 19:09:57-03:00" — hora real de
# gravação no iPhone, com fuso. É o que queremos pra clipes do iPhone.
DATE_TZ_RE = re.compile(
    r"^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})([+-]\d{2}:\d{2}|Z)?$"
)


def dms_to_decimal(s: str) -> float | None:
    m = DMS_RE.match(s)
    if not m:
        return None
    deg, minutes, seconds, hemi = m.groups()
    dec = float(deg) + float(minutes) / 60 + float(seconds) / 3600
    if hemi in ("S", "W"):
        dec = -dec
    return round(dec, 6)


def to_float(v: str) -> float | None:
    if not v:
        return None
    m = re.match(r"^\s*([\d.]+)", v)
    return float(m.group(1)) if m else None


def parse_create_date(s: str) -> str | None:
    """Parse o CreateDate (mvhd) — sem fuso, presume horário local de SP."""
    if not s:
        return None
    m = DATE_RE.match(s)
    if not m:
        return None
    y, mo, d, h, mi, se = m.groups()
    return f"{y}-{mo}-{d}T{h}:{mi}:{se}{LOCAL_TZ}"


def parse_creation_date(s: str) -> str | None:
    """Parse o CreationDate Apple (`com.apple.quicktime.creationdate`) —
    traz fuso real do dispositivo. Normaliza pra xsd:dateTime ISO 8601."""
    if not s:
        return None
    m = DATE_TZ_RE.match(s)
    if not m:
        return None
    y, mo, d, h, mi, se, tz = m.groups()
    tz = tz or LOCAL_TZ
    return f"{y}-{mo}-{d}T{h}:{mi}:{se}{tz}"


def stem_to_vhash(stem: str) -> str:
    return hashlib.md5(stem.encode("utf-8")).hexdigest()[:16]


def parse_exiftool(path: Path) -> dict | None:
    try:
        # exiftool retorna tags com o nome em CamelCase; o `-s` faz só a tag
        # e o valor (sem descrição longa). `-api QuickTimeUTC=0` mantém o
        # CreationDate (Apple) com o fuso original em vez de converter pra UTC.
        # Importante distinguir:
        #   CreateDate    (mvhd, sem TZ)           = hora de "save"/edit
        #   CreationDate  (Apple iOS, com TZ)      = hora real de gravação
        # Pedimos os dois; preferimos CreationDate.
        out = subprocess.check_output([
            "exiftool",
            "-GPSLatitude", "-GPSLongitude",
            "-Duration", "-MediaDuration", "-TrackDuration",
            "-CreateDate", "-CreationDate",
            "-api", "QuickTimeUTC=0",
            "-s",
            str(path),
        ], text=True)
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        print(f"  [{path.name}] exiftool failed: {e}", file=sys.stderr)
        return None

    fields: dict[str, str] = {}
    for line in out.splitlines():
        if ":" in line:
            k, _, v = line.partition(":")
            fields[k.strip()] = v.strip()

    lat = dms_to_decimal(fields.get("GPSLatitude", ""))
    lng = dms_to_decimal(fields.get("GPSLongitude", ""))
    if lat is None or lng is None:
        print(f"  [{path.name}] sem GPS — pulando", file=sys.stderr)
        return None

    duration = None
    for k in ("Duration", "MediaDuration", "TrackDuration"):
        v = to_float(fields.get(k, ""))
        if v and v > 0:
            duration = v
            break

    # Prefere CreationDate (Apple, com fuso real) sobre CreateDate (mvhd).
    date_xsd = (parse_creation_date(fields.get("CreationDate", ""))
                or parse_create_date(fields.get("CreateDate", "")))

    return {
        "lat": lat,
        "lng": lng,
        "duration": duration,
        "date_xsd": date_xsd,
    }


def extract_audio(src: Path, dst: Path) -> bool:
    if dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime:
        return True
    try:
        subprocess.check_call([
            "ffmpeg", "-y", "-i", str(src),
            "-vn", "-c:a", "aac", "-b:a", "96k",
            "-movflags", "+faststart",
            "-loglevel", "error",
            str(dst),
        ])
        return True
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        print(f"  [{src.name}] audio extract failed: {e}", file=sys.stderr)
        return False


def extract_thumb(src: Path, dst: Path, duration: float | None) -> bool:
    """Extrai um quadro do meio do clipe pra JPEG ~256px. Idempotente
    (pula se dst é mais novo). Igual ao thumb que photos/<phash>/thumb.jpg
    tem pra fotos — usado nos markers do mapa."""
    if dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime:
        return True
    # Seek pro meio: muitos clipes têm primeiros frames pretos / com letra-
    # box. Cai pra 0.5s se a duração for desconhecida.
    seek = max(0.5, (duration or 1.0) * 0.5)
    try:
        subprocess.check_call([
            "ffmpeg", "-y", "-ss", f"{seek}", "-i", str(src),
            "-vframes", "1",
            "-vf", "scale='if(gt(iw,ih),-2,256)':'if(gt(iw,ih),256,-2)'",
            "-q:v", "4",  # qualidade JPEG razoável
            "-loglevel", "error",
            str(dst),
        ])
        return True
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        print(f"  [{src.name}] thumb extract failed: {e}", file=sys.stderr)
        return False


def transcode(src: Path, dst: Path, target_short_side: int) -> bool:
    if dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime:
        return True
    s = target_short_side
    try:
        subprocess.check_call([
            "ffmpeg", "-y", "-i", str(src),
            "-vf", f"scale='if(gt(iw,ih),-2,{s})':'if(gt(iw,ih),{s},-2)'",
            "-c:v", "libx264", "-preset", "fast", "-crf", "28",
            "-movflags", "+faststart",
            "-c:a", "aac", "-b:a", "96k",
            "-loglevel", "error",
            str(dst),
        ])
        return True
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        print(f"  [{src.name}] ffmpeg failed ({s}p): {e}", file=sys.stderr)
        return False


def load_tour_catalog() -> list[tuple[str, float]]:
    """Lê tours.ttl e devolve lista de (tour_iri, epoch_seconds) ordenada
    por data. Usada pra associar clipes ao passeio mais próximo (±12h)."""
    if not TOURS_TTL.exists():
        return []
    g = Graph()
    g.parse(TOURS_TTL, format="turtle")
    out: list[tuple[str, float]] = []
    for s in g.subjects(RDF.type, PH.Tour):
        for date_lit in g.objects(s, DCT.date):
            try:
                # rdflib devolve Literal; pegamos o python val (datetime).
                dt = date_lit.toPython()
                if hasattr(dt, "timestamp"):
                    out.append((str(s), dt.timestamp()))
                    break
            except Exception:
                pass
    out.sort(key=lambda x: x[1])
    return out


def closest_tour(tours: list[tuple[str, float]], clip_iso: str | None) -> str | None:
    """Match do clipe (dcterms:date no formato xsd:dateTime) com o passeio
    cuja data esteja a no máximo ±TOUR_WINDOW_SEC do clipe. Retorna o IRI
    do tour ou None."""
    if not clip_iso or not tours:
        return None
    try:
        clip_ts = datetime.fromisoformat(clip_iso).timestamp()
    except ValueError:
        return None
    best_iri = None
    best_delta = TOUR_WINDOW_SEC + 1
    for iri, ts in tours:
        delta = abs(ts - clip_ts)
        if delta < best_delta and delta <= TOUR_WINDOW_SEC:
            best_delta = delta
            best_iri = iri
    return best_iri


def upsert_clip(g: Graph, vhash: str, meta: dict, share_name: str,
                hd_name: str | None, audio_name: str | None,
                thumb_name: str | None, tour_iri: str | None = None) -> None:
    """Idempotente: limpa triples antigos do mesmo IRI (e dos seus bnodes
    alcançáveis) e regrava. Igual ao /upload-video do backend."""
    vid_iri = URIRef(PHD + f"video_{vhash}")
    to_remove = {vid_iri}
    queue = [vid_iri]
    while queue:
        cur = queue.pop()
        for _s, _p, o in list(g.triples((cur, None, None))):
            if isinstance(o, BNode) and o not in to_remove:
                to_remove.add(o)
                queue.append(o)
    for subj in to_remove:
        for triple in list(g.triples((subj, None, None))):
            g.remove(triple)

    g.add((vid_iri, RDF.type, PH.Video))
    if meta["date_xsd"]:
        g.add((vid_iri, DCT.date, Literal(meta["date_xsd"], datatype=XSD.dateTime)))
    geo = BNode()
    g.add((geo, RDF.type, SCHEMA.GeoCoordinates))
    g.add((geo, SCHEMA.latitude,  Literal(f"{meta['lat']}", datatype=XSD.decimal)))
    g.add((geo, SCHEMA.longitude, Literal(f"{meta['lng']}", datatype=XSD.decimal)))
    g.add((vid_iri, SCHEMA.locationCreated, geo))
    if meta["duration"]:
        iso_dur = f"PT{round(float(meta['duration']) * 100) / 100}S"
        g.add((vid_iri, SCHEMA.duration, Literal(iso_dur, datatype=XSD.duration)))
    g.add((vid_iri, PH.video360p, Literal(share_name)))
    resolutions = ["audio", "360p"]
    if hd_name:
        g.add((vid_iri, PH.video720p, Literal(hd_name)))
        resolutions.append("720p")
    if audio_name:
        g.add((vid_iri, PH.audio, Literal(audio_name)))
    if thumb_name:
        g.add((vid_iri, SCHEMA.thumbnail, Literal(thumb_name)))
    for r in resolutions:
        g.add((vid_iri, PH.availableResolution, Literal(r)))
    if tour_iri:
        g.add((vid_iri, PH.capturedDuring, URIRef(tour_iri)))
    g.add((vid_iri, PROV.wasAttributedTo, DEFAULT_AUTHOR))
    g.add((vid_iri, PAV.providedBy, DEFAULT_PROVIDER))
    g.add((vid_iri, DCT.license, DEFAULT_LICENSE))


def main() -> int:
    if not CLIPS_RAW_DIR.is_dir():
        print(f"raw clips dir not found: {CLIPS_RAW_DIR}", file=sys.stderr)
        return 1
    CLIPS_OUT_DIR.mkdir(parents=True, exist_ok=True)
    AUDIO_OUT_DIR.mkdir(parents=True, exist_ok=True)

    g = Graph()
    if UPLOADS_TTL.exists() and UPLOADS_TTL.stat().st_size > 0:
        g.parse(UPLOADS_TTL, format="turtle")
    g.bind("ph", PH); g.bind("phd", PHD)
    g.bind("schema", SCHEMA); g.bind("dcterms", DCT)
    g.bind("prov", PROV); g.bind("pav", PAV)

    tours = load_tour_catalog()
    print(f"[tour-catalog] {len(tours)} passeio(s) com dcterms:date")

    ok = 0; skipped = 0; matched_tour = 0
    for p in sorted(CLIPS_RAW_DIR.iterdir()):
        if p.suffix.lower() not in EXTS:
            continue
        meta = parse_exiftool(p)
        if not meta:
            skipped += 1
            continue

        share_name = p.stem + SHARE_SUFFIX
        share_path = CLIPS_OUT_DIR / share_name
        if not transcode(p, share_path, 360):
            skipped += 1
            continue

        hd_name = p.stem + SHARE_SUFFIX_HD
        hd_path = CLIPS_OUT_DIR / hd_name
        if not transcode(p, hd_path, 720):
            hd_name = None  # 720p é opcional

        audio_name = p.stem + AUDIO_SUFFIX
        audio_path = AUDIO_OUT_DIR / audio_name
        audio_rel = f"audio/{audio_name}" if extract_audio(p, audio_path) else None

        thumb_name = p.stem + THUMB_SUFFIX
        thumb_path = CLIPS_OUT_DIR / thumb_name
        thumb_rel = thumb_name if extract_thumb(p, thumb_path, meta["duration"]) else None

        vhash = stem_to_vhash(p.stem)
        tour_iri = closest_tour(tours, meta["date_xsd"])
        if tour_iri:
            matched_tour += 1
        upsert_clip(g, vhash, meta, share_name, hd_name, audio_rel, thumb_rel, tour_iri)
        ok += 1
        size_kb = share_path.stat().st_size / 1024
        tag = (f" + audio" if audio_rel else "") + (f" + thumb" if thumb_rel else "")
        if tour_iri:
            tag += f" + tour={tour_iri.rsplit('/', 1)[-1]}"
        print(f"  ok {share_name}  vhash={vhash} lat={meta['lat']} lng={meta['lng']} "
              f"dur={meta['duration']}  {size_kb:.0f} KB{tag}")

    UPLOADS_TTL.write_text(g.serialize(format="turtle"))
    print(f"\nUploads.ttl atualizado: {ok} clipe(s) ok, {skipped} pulado(s), "
          f"{matched_tour} associado(s) a passeio. Total triples: {len(g)}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
