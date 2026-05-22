"""
Pedal Hidrográfico — backend auto-hospedável (Raspberry Pi)

Um único serviço Flask, sem nenhuma dependência de nuvem:
  - serve o app do mapa (public/)
  - serve as fotos do acervo (data/fotos/)
  - recebe uploads, processa (EXIF + thumbnail) e mantém o photos.jsonld
  - apaga fotos

Arquivos ficam em disco; o índice das fotos fica em SQLite.

Rotas:
  GET  /                health do app — public/index.html
  GET  /<arquivo>       estáticos do app (app.js, style.css, sw.js, ...)
  GET  /fotos/<cam>     fotos processadas, thumbnails e photos.jsonld
  GET  /health          "ok"
  POST /sign-upload     devolve uma URL de PUT no próprio host (token)
  PUT  /put/<cam>       recebe o arquivo e o processa
  POST /delete-photo    apaga uma foto (token)

Variáveis de ambiente:
  UPLOAD_SECRET   token de upload/delete (obrigatório)
  PHIDRO_DATA     pasta de dados             (padrão: ./data)
  PHIDRO_PUBLIC   pasta do app               (padrão: ../../public)
  PUBLIC_BASE     prefixo das URLs de foto   (padrão: /fotos)

Deploy no Raspberry Pi: ver README.md.
"""
import base64
import datetime
import io
import json
import math
import os
import re
import sqlite3
import uuid
from pathlib import Path, PurePosixPath

import pillow_heif
from flask import Flask, abort, jsonify, request, send_from_directory
from PIL import ExifTags, Image, ImageOps

pillow_heif.register_heif_opener()

DATA = Path(os.environ.get("PHIDRO_DATA", "data")).resolve()
PUBLIC = Path(os.environ.get(
    "PHIDRO_PUBLIC",
    Path(__file__).resolve().parents[2] / "public")).resolve()
SECRET = os.environ.get("UPLOAD_SECRET", "")
PUBLIC_BASE = os.environ.get("PUBLIC_BASE", "/fotos").rstrip("/")

FOTOS = DATA / "fotos"
PHOTOS_DIR = FOTOS / "photos"
THUMBS_DIR = FOTOS / "thumbs"
ORIGINALS = DATA / "originals"
DB_PATH = DATA / "photos.db"
for _d in (PHOTOS_DIR, THUMBS_DIR, ORIGINALS):
    _d.mkdir(parents=True, exist_ok=True)

IMG_EXTS = {".heic", ".heif", ".jpg", ".jpeg", ".png"}
ALLOWED_TYPES = {"image/jpeg", "image/png", "image/heic", "image/heif"}
DISPLAY_MAX, THUMB_MAX, QUALITY = 1600, 400, 82

CONTEXT = {
    "ph": "https://pedalhidrografi.co/vocab/1.0/",
    "schema": "https://schema.org/",
    "xsd": "http://www.w3.org/2001/XMLSchema#",
    "id": "@id",
    "type": "@type",
    "photos": "@graph",
    "orig": "schema:name",
    "file": {"@id": "schema:contentUrl", "@type": "@id"},
    "thumb": {"@id": "schema:thumbnailUrl", "@type": "@id"},
    "lat": "schema:latitude",
    "lng": "schema:longitude",
    "alt": "schema:elevation",
    "datetime": {"@id": "schema:dateCreated", "@type": "xsd:dateTime"},
}

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024  # 50 MB por upload


# ── SQLite ───────────────────────────────────────────────────────────────
def _db():
    con = sqlite3.connect(DB_PATH)
    con.execute("CREATE TABLE IF NOT EXISTS photos "
                "(id TEXT PRIMARY KEY, datetime TEXT, data TEXT)")
    return con


def _authorized(body):
    token = request.headers.get("X-Upload-Token") or body.get("token")
    return bool(SECRET) and token == SECRET


# ── EXIF ─────────────────────────────────────────────────────────────────
def _dms_to_decimal(dms, ref):
    try:
        d, m, s = (float(x) for x in dms)
    except (TypeError, ValueError):
        return None
    dec = d + m / 60.0 + s / 3600.0
    if str(ref).strip().upper() in ("S", "W"):
        dec = -dec
    return dec


def read_exif(img):
    out = {"lat": None, "lng": None, "alt": None, "datetime": None,
           "bearing": None, "fov": None}
    try:
        exif = img.getexif()
    except Exception:
        return out
    if not exif:
        return out
    try:
        gps = exif.get_ifd(ExifTags.IFD.GPSInfo)
    except Exception:
        gps = {}
    if gps:
        lat = _dms_to_decimal(gps.get(2), gps.get(1))
        lng = _dms_to_decimal(gps.get(4), gps.get(3))
        if lat is not None and lng is not None:
            out["lat"] = round(lat, 6)
            out["lng"] = round(lng, 6)
        alt = gps.get(6)
        if alt is not None:
            try:
                out["alt"] = round(float(alt), 1)
            except (TypeError, ValueError):
                pass
        direction = gps.get(17)
        if direction is not None:
            try:
                out["bearing"] = round(float(direction) % 360, 1)
            except (TypeError, ValueError):
                pass
    f35 = exif.get(41989)
    if f35:
        try:
            f = float(f35)
            if f > 0:
                portrait = (exif.get(274) or 1) in (5, 6, 7, 8)
                frame = 24.0 if portrait else 36.0
                out["fov"] = round(
                    math.degrees(2 * math.atan(frame / (2 * f))), 1)
        except (TypeError, ValueError):
            pass
    dt_raw = exif.get(36867) or exif.get(306)
    if dt_raw:
        try:
            out["datetime"] = datetime.datetime.strptime(
                str(dt_raw).strip(), "%Y:%m:%d %H:%M:%S").isoformat()
        except ValueError:
            pass
    return out


def ride_from_name(name):
    """Lê o pedal embutido no caminho 'uploads/r-<base64url>/...'."""
    for part in name.split("/"):
        if part.startswith("r-"):
            try:
                token = part[2:]
                token += "=" * (-len(token) % 4)
                ride = json.loads(base64.urlsafe_b64decode(token))
                if isinstance(ride, dict) and ride.get("date"):
                    return ride
            except Exception:
                return None
    return None


def _render(raw, max_size):
    img = ImageOps.exif_transpose(Image.open(io.BytesIO(raw))).convert("RGB")
    img.thumbnail((max_size, max_size), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=QUALITY, optimize=True)
    return buf.getvalue()


def _rebuild_manifest():
    con = _db()
    rows = con.execute("SELECT data FROM photos").fetchall()
    con.close()
    photos = [json.loads(r[0]) for r in rows]
    photos.sort(key=lambda p: p.get("datetime") or "")
    now = datetime.datetime.utcnow().isoformat(timespec="seconds") + "Z"
    # Dataset de vozes (grafos nomeados). Hoje há uma só — voice/censo, a voz
    # do operador deste backend. A estrutura já comporta várias: o app sempre
    # renderiza por uma "fold" que funde as vozes numa visão única.
    manifest = {
        "@context": CONTEXT,
        "generatedAt": now,
        "voices": [
            {
                "id": "voice/censo",
                "label": "Censo Hidrográfico",
                "generatedAt": now,
                "photos": photos,
            }
        ],
    }
    (FOTOS / "photos.jsonld").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[manifest] {len(photos)} fotos em 1 voz")


# ── Servir o app e as fotos ──────────────────────────────────────────────
@app.get("/health")
def health():
    return "ok\n"


@app.get("/")
def index():
    return send_from_directory(PUBLIC, "index.html")


@app.get("/fotos/<path:p>")
def fotos(p):
    resp = send_from_directory(FOTOS, p)
    if p.endswith(".jsonld"):
        resp.headers["Content-Type"] = "application/ld+json"
        resp.headers["Cache-Control"] = "no-cache"
    else:
        resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return resp


@app.get("/<path:p>")
def public_files(p):
    if (PUBLIC / p).is_file():
        return send_from_directory(PUBLIC, p)
    abort(404)


# ── API ──────────────────────────────────────────────────────────────────
@app.post("/sign-upload")
def sign_upload():
    body = request.get_json(silent=True) or {}
    if not _authorized(body):
        return jsonify(error="unauthorized"), 403
    ct = (body.get("contentType") or "").lower()
    if ct not in ALLOWED_TYPES:
        return jsonify(error=f"tipo nao permitido: {ct}"), 400
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", body.get("filename") or "foto")[-80:]
    stamp = datetime.datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    leaf = f"{stamp}-{uuid.uuid4().hex[:8]}-{safe}"
    ride = body.get("ride")
    if isinstance(ride, dict) and ride.get("date"):
        token = (base64.urlsafe_b64encode(
            json.dumps(ride, ensure_ascii=False).encode("utf-8"))
            .decode("ascii").rstrip("="))
        objname = f"uploads/r-{token}/{leaf}"
    else:
        objname = f"uploads/{leaf}"
    return jsonify(uploadUrl=f"/put/{objname}", objectPath=objname)


@app.route("/put/<path:objpath>", methods=["PUT"])
def put(objpath):
    if not objpath.startswith("uploads/"):
        abort(400)
    ext = PurePosixPath(objpath).suffix.lower()
    if ext not in IMG_EXTS:
        abort(400)
    raw = request.get_data()
    if not raw:
        abort(400)

    pid = re.sub(r"[^A-Za-z0-9._-]", "_", PurePosixPath(objpath).stem)
    (ORIGINALS / f"{pid}{ext}").write_bytes(raw)  # arquiva o original

    try:
        meta = read_exif(Image.open(io.BytesIO(raw)))
    except Exception as e:  # noqa: BLE001
        print(f"[put] imagem ilegível {objpath}: {e}")
        return ("imagem ilegivel", 200)
    if meta["lat"] is None or meta["lng"] is None:
        return ("sem GPS — arquivada, fora do mapa", 200)

    (PHOTOS_DIR / f"{pid}.jpg").write_bytes(_render(raw, DISPLAY_MAX))
    (THUMBS_DIR / f"{pid}.jpg").write_bytes(_render(raw, THUMB_MAX))
    item = {
        "id": pid,
        "type": "ph:Image",
        "orig": PurePosixPath(objpath).name,
        "file": f"{PUBLIC_BASE}/photos/{pid}.jpg",
        "thumb": f"{PUBLIC_BASE}/thumbs/{pid}.jpg",
        "lat": meta["lat"],
        "lng": meta["lng"],
        "alt": meta["alt"],
        "datetime": meta["datetime"],
        "bearing": meta["bearing"],
        "fov": meta["fov"],
        "ride": ride_from_name(objpath),
    }
    con = _db()
    con.execute("INSERT OR REPLACE INTO photos (id, datetime, data) "
                "VALUES (?, ?, ?)",
                (pid, meta["datetime"] or "",
                 json.dumps(item, ensure_ascii=False)))
    con.commit()
    con.close()
    _rebuild_manifest()
    print(f"[put] processado {objpath} -> {pid}")
    return ("ok", 200)


@app.post("/delete-photo")
def delete_photo():
    body = request.get_json(silent=True) or {}
    if not _authorized(body):
        return jsonify(error="unauthorized"), 403
    pid = str(body.get("id") or "").strip()
    if not pid or not re.fullmatch(r"[A-Za-z0-9._-]+", pid):
        return jsonify(error="id invalido"), 400
    removed = 0
    for p in (PHOTOS_DIR / f"{pid}.jpg", THUMBS_DIR / f"{pid}.jpg"):
        if p.exists():
            p.unlink()
            removed += 1
    for orig in ORIGINALS.glob(f"{pid}.*"):
        orig.unlink()
        removed += 1
    con = _db()
    con.execute("DELETE FROM photos WHERE id = ?", (pid,))
    con.commit()
    con.close()
    _rebuild_manifest()
    print(f"[delete] {pid} ({removed} arquivos)")
    return jsonify(deleted=pid, removed=removed)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8000)))
