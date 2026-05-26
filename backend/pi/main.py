"""
Pedal Hidrográfico — backend Pi.

Flask service, sem nuvem. Serve o app estático em `web/` e recebe uploads de
foto (uma de cada vez) já modelados em RDF/Turtle no upload-form-live.html.

Cada upload contém:
  - `ttl`        : bloco Turtle com exatamente 1 `ph:Image` (texto ou arquivo)
  - `original`   : arquivo da foto fonte (jpg/png/heic). Opcional.
  - `large`      : foto reduzida (~500 KB). Opcional.
  - `thumb`      : miniatura. Opcional.

O backend valida o TTL contra `web/data/shapes.ttl` + a ontologia,
grava as variantes em `web/photos/<phash>/{original|large|thumb}.<ext>` e
anexa as triples ao catálogo único em `web/data/photos.ttl` (deduplicando
por IRI da imagem).

Rotas:
  GET  /                     serve web/index.html
  GET  /health               "ok"
  GET  /<path>               estáticos de web/ (app.js, fotos, photos.ttl, …)
  POST /upload-image         multipart com `ttl` + variantes; valida e grava
  POST /delete-image/<phash> remove arquivos + triples

Sem auth — quem alcança o servidor é de confiança. Restrinja na borda se
precisar.

Variáveis de ambiente:
  PHIDRO_WEB    pasta do app   (padrão: ../../web)
  PORT          porta HTTP     (padrão: 8000)
"""
import os
from pathlib import Path

from datetime import datetime, timezone
from flask import Flask, abort, jsonify, request, send_from_directory

# ── Caminhos ─────────────────────────────────────────────────────────────
WEB = Path(os.environ.get(
    "PHIDRO_WEB",
    Path(__file__).resolve().parents[2] / "web")).resolve()
DATA_DIR      = WEB / "data"
SHAPES_PATH   = DATA_DIR / "shapes.ttl"
ONTOLOGY_PATH = DATA_DIR / "ontology.ttl"
MANIFEST_PATH = DATA_DIR / "data_graphs.ttl"
UPLOADS_TTL   = DATA_DIR / "uploads.ttl"
PHOTOS_DIR    = WEB / "photos"
DATA_DIR.mkdir(parents=True, exist_ok=True)
PHOTOS_DIR.mkdir(parents=True, exist_ok=True)

VOID_NS = "http://rdfs.org/ns/void#"

PH_NS  = "https://pedalhidrografi.co/terms#"
PHD_NS = "https://pedalhidrografi.co/data/"

MAX_PER_UPLOAD = 32 * 1024 * 1024  # 32 MB por requisição

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_PER_UPLOAD


# ── Validador SHACL (lazy) ───────────────────────────────────────────────
# rdflib + pyshacl são pesados: carregamos só na primeira validação para
# manter o boot do servidor barato.
_validator = None


def _load_validator():
    global _validator
    if _validator is not None:
        return _validator
    import pyshacl
    from rdflib import Graph
    shapes = Graph().parse(SHAPES_PATH, format="turtle")
    ont    = Graph().parse(ONTOLOGY_PATH, format="turtle")
    _validator = {
        "pyshacl": pyshacl,
        "Graph":   Graph,
        "shapes":  shapes,
        "ont":     ont,
    }
    print(f"[shacl] carregados shapes={len(shapes)} triples, "
          f"ontology={len(ont)} triples")
    return _validator


# Mundo (TTLs listadas no manifesto), construído sob demanda e invalidado
# após cada upload/delete. O validador o mescla com o TTL recebido para
# que `sh:class ph:Tour` etc. enxerguem o universo todo (passeios,
# pessoas, uploads anteriores).
_catalog_cache = None


def _invalidate_catalog():
    global _catalog_cache
    _catalog_cache = None


def _load_catalog():
    global _catalog_cache
    if _catalog_cache is not None:
        return _catalog_cache
    v = _load_validator()
    Graph = v["Graph"]
    catalog = Graph()
    if not MANIFEST_PATH.exists():
        _catalog_cache = catalog
        return catalog
    manifest = Graph().parse(
        MANIFEST_PATH, format="turtle", publicID=MANIFEST_BASE)
    from rdflib import URIRef
    pred = URIRef(VOID_NS + "dataDump")
    loaded = 0
    for _s, _p, o in manifest.triples((None, pred, None)):
        url = str(o)
        # Resolve para Path local: o objeto está sob MANIFEST_BASE; o que
        # vier depois é o nome do arquivo em web/data/.
        fname = url[len(MANIFEST_BASE):] if url.startswith(MANIFEST_BASE) \
                else url.rsplit("/", 1)[-1]
        path = DATA_DIR / fname
        if not (path.exists() and path.stat().st_size > 0):
            continue
        try:
            catalog.parse(path, format="turtle")
            loaded += 1
        except Exception as e:  # noqa: BLE001
            print(f"[validator] não consegui parsear {fname}: {e}")
    _catalog_cache = catalog
    print(f"[validator] catálogo: {loaded} arquivo(s), {len(catalog)} triples")
    return catalog


def validate_image_ttl(ttl_text):
    """Verifica que o TTL contém exatamente 1 ph:Image e satisfaz as shapes.
    Retorna (ok, phash, errors). `errors` traz só violations (warnings passam)
    cujo focusNode está no TTL recebido — ruído do catálogo (passeios velhos
    com warnings, etc.) não bloqueia o upload."""
    v = _load_validator()
    from rdflib import URIRef, Namespace
    data = v["Graph"]().parse(data=ttl_text, format="turtle")

    RDFT = URIRef("http://www.w3.org/1999/02/22-rdf-syntax-ns#type")
    images = list(data.subjects(RDFT, URIRef(PH_NS + "Image")))
    if len(images) != 1:
        return False, None, [
            f"TTL deve conter exatamente 1 ph:Image (achou {len(images)})"
        ]
    image_iri = str(images[0])
    if not image_iri.startswith(PHD_NS + "image_"):
        return False, None, [
            f"IRI da Image deve começar com phd:image_ (atual: {image_iri})"
        ]
    phash = image_iri[len(PHD_NS + "image_"):]
    if not phash or not all(c in "0123456789abcdef" for c in phash.lower()):
        return False, phash, [f"phash inválido na IRI: {phash}"]

    # Mescla data + ontology + catálogo, MAS exclui triples do catálogo cujo
    # subject é a imagem em curso (ou bnodes alcançáveis a partir dela). Sem
    # isso, re-upload da mesma foto sobrepõe os triples antigos aos novos, e
    # SHACL flagra cardinalidade > 1 em `dcterms:date` etc.
    from rdflib import BNode
    img_uri = URIRef(image_iri)
    catalog = _load_catalog()
    # Coleta bnodes alcançáveis a partir da imagem (hash, locationCreated, …).
    img_bnodes = set()
    queue = [img_uri]
    while queue:
        cur = queue.pop()
        for _s, _p, o in catalog.triples((cur, None, None)):
            if isinstance(o, BNode) and o not in img_bnodes:
                img_bnodes.add(o)
                queue.append(o)
    exclude = img_bnodes | {img_uri}
    merged = data + v["ont"]
    for s, p, o in catalog:
        if s not in exclude:
            merged.add((s, p, o))
    conforms, results_graph, _txt = v["pyshacl"].validate(
        merged, shacl_graph=v["shapes"], inference="rdfs", advanced=True)
    if conforms:
        return True, phash, []

    # Reporta apenas violations cujo focusNode é um sujeito do TTL recebido.
    # Catálogo (tours.ttl) pode ter warnings legítimos; não são problema do
    # upload em curso.
    own_subjects = set(data.subjects())
    SH = Namespace("http://www.w3.org/ns/shacl#")
    errors = []
    for r in results_graph.subjects(SH.resultSeverity, SH.Violation):
        focus = next(results_graph.objects(r, SH.focusNode), None)
        if focus is None or focus in own_subjects:
            msg = next(results_graph.objects(r, SH.resultMessage), None)
            errors.append(str(msg) if msg else "(sem mensagem)")
    if not errors:
        return True, phash, []
    return False, phash, errors


def _upload_filename():
    """Timestamp único (microssegundos) — `upload_20260526T012345-678901Z.ttl`."""
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S-%f")
    return f"upload_{ts}Z.ttl"


def _ttl_escape(s):
    return (s or "").replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


def _build_audit_ttl(upload_local, phash):
    """Bloco PROV server-side anexado ao TTL do upload."""
    ts = datetime.now(timezone.utc).isoformat(timespec="microseconds")
    ts = ts.replace("+00:00", "Z")
    return (
        "\n# Registro de envio (provenance) — adicionado server-side.\n"
        "@prefix prov: <http://www.w3.org/ns/prov#> .\n"
        "@prefix ph:   <https://pedalhidrografi.co/terms#> .\n"
        "@prefix phd:  <https://pedalhidrografi.co/data/> .\n"
        "@prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .\n"
        "\n"
        f"phd:{upload_local} a ph:Upload ;\n"
        f"    prov:startedAtTime \"{ts}\"^^xsd:dateTime ;\n"
        f"    prov:generated phd:image_{phash} .\n"
    )


# Base estável e hierárquica para o manifesto. rdflib usa isto como o
# resolvido para `<>` e para `<tours.ttl>` etc., e na hora de serializar com
# `base=` essas URIs voltam a ser relativas — mantendo o arquivo limpo no
# disco. Precisa ser hierárquica (URN não serve por causa do RFC 3986).
MANIFEST_BASE = "https://pedalhidrografi.co/.manifest/"
MANIFEST_SEED = """\
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix void:    <http://rdfs.org/ns/void#> .

<> a void:Dataset ;
    dcterms:title "Pedal Hidrográfico — grafos de dados"@pt ;
    void:dataDump <tours.ttl> .
"""


def _load_manifest():
    """Devolve o Graph do manifesto; cria o esqueleto se faltando."""
    v = _load_validator()
    Graph = v["Graph"]
    g = Graph()
    if MANIFEST_PATH.exists() and MANIFEST_PATH.stat().st_size > 0:
        g.parse(MANIFEST_PATH, format="turtle", publicID=MANIFEST_BASE)
    else:
        g.parse(data=MANIFEST_SEED, format="turtle", publicID=MANIFEST_BASE)
    return g


def _save_manifest(g):
    import re
    out = g.serialize(format="turtle", base=MANIFEST_BASE)
    # rdflib injeta `@base <...>` no topo; isso é necessário internamente para
    # produzir URIs relativas (`<tours.ttl>`), mas se o arquivo ficar com a
    # diretiva o browser resolve as URIs contra o base opaco
    # (https://pedalhidrografi.co/.manifest/) em vez do URL real de fetch.
    # Removemos a primeira linha @base para que `<tours.ttl>` etc. resolvam
    # contra a URL onde o arquivo está servido (web/data/data_graphs.ttl).
    out = re.sub(r'^@base\s+<[^>]*>\s*\.\s*\n', '', out, count=1, flags=re.MULTILINE)
    MANIFEST_PATH.write_text(out)


def _manifest_root():
    """O sujeito `<>` resolvido contra a base opaca."""
    from rdflib import URIRef
    return URIRef(MANIFEST_BASE)


def _manifest_uri(filename):
    from rdflib import URIRef
    return URIRef(MANIFEST_BASE + filename)


def register_upload_in_manifest(filename):
    """Adiciona `<> void:dataDump <filename>` ao manifesto (idempotente)."""
    from rdflib import URIRef
    g = _load_manifest()
    triple = (_manifest_root(), URIRef(VOID_NS + "dataDump"), _manifest_uri(filename))
    if triple not in g:
        g.add(triple)
        _save_manifest(g)
        _invalidate_catalog()


def unregister_upload_in_manifest(filename):
    """Remove a linha `void:dataDump <filename>` do manifesto."""
    if not MANIFEST_PATH.exists():
        return False
    from rdflib import URIRef
    g = _load_manifest()
    triple = (None, URIRef(VOID_NS + "dataDump"), _manifest_uri(filename))
    n = 0
    for s, p, o in list(g.triples(triple)):
        g.remove((s, p, o))
        n += 1
    if n:
        _save_manifest(g)
        _invalidate_catalog()
    return n > 0


def _purge_subject(graph, root):
    """Apaga triples cujo subject é `root` e bnodes alcançáveis a partir dele."""
    from rdflib import BNode
    seen, queue = set(), [root]
    while queue:
        cur = queue.pop()
        for _s, _p, o in graph.triples((cur, None, None)):
            if isinstance(o, BNode) and o not in seen:
                seen.add(o)
                queue.append(o)
    removed = 0
    for bn in seen:
        for s, p, o in list(graph.triples((bn, None, None))):
            graph.remove((s, p, o))
            removed += 1
    for s, p, o in list(graph.triples((root, None, None))):
        graph.remove((s, p, o))
        removed += 1
    return removed


PROV_GEN_URI = "http://www.w3.org/ns/prov#generated"


def upsert_image_in_uploads(image_ttl, phash, audit_ttl):
    """Mescla os blocos da imagem + da activity no único `uploads.ttl`,
    sobrescrevendo qualquer dado prévio para essa mesma imagem."""
    v = _load_validator()
    Graph = v["Graph"]
    from rdflib import URIRef
    image_iri = URIRef(PHD_NS + "image_" + phash)
    catalog = Graph()
    if UPLOADS_TTL.exists() and UPLOADS_TTL.stat().st_size > 0:
        catalog.parse(UPLOADS_TTL, format="turtle")
    # 1) Tira da imagem (+ bnodes de hash/loc).
    _purge_subject(catalog, image_iri)
    # 2) Tira qualquer ph:Upload activity que tenha gerado essa imagem.
    for s in list(catalog.subjects(URIRef(PROV_GEN_URI), image_iri)):
        _purge_subject(catalog, s)
    # 3) Mescla os novos blocos (imagem + nova activity).
    catalog += Graph().parse(data=image_ttl + audit_ttl, format="turtle")
    UPLOADS_TTL.write_text(catalog.serialize(format="turtle"))


def remove_image_from_uploads(phash):
    """Remove triples da imagem + da sua activity de envio. Retorna nº de triples."""
    if not UPLOADS_TTL.exists() or UPLOADS_TTL.stat().st_size == 0:
        return 0
    v = _load_validator()
    from rdflib import URIRef
    image_iri = URIRef(PHD_NS + "image_" + phash)
    catalog = v["Graph"]()
    catalog.parse(UPLOADS_TTL, format="turtle")
    n = _purge_subject(catalog, image_iri)
    for s in list(catalog.subjects(URIRef(PROV_GEN_URI), image_iri)):
        n += _purge_subject(catalog, s)
    UPLOADS_TTL.write_text(catalog.serialize(format="turtle"))
    return n


# ── Rotas ────────────────────────────────────────────────────────────────
@app.get("/health")
def health():
    return "ok\n"


@app.get("/")
def index():
    return send_from_directory(WEB, "index.html")


@app.get("/<path:p>")
def web_files(p):
    """Estáticos de web/ — inclui ./data/photos.ttl e ./photos/<phash>/*.jpg."""
    if (WEB / p).is_file():
        resp = send_from_directory(WEB, p)
        if p.endswith(".ttl") or p.endswith(".json"):
            resp.headers["Cache-Control"] = "no-cache"
        elif p.startswith("photos/"):
            resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return resp
    abort(404)


@app.post("/upload-image")
def upload_image():
    # `ttl` pode vir como campo de formulário ou como arquivo.
    ttl_text = request.form.get("ttl")
    if not ttl_text:
        f = request.files.get("ttl")
        if f:
            ttl_text = f.read().decode("utf-8", errors="replace")
    if not ttl_text:
        return jsonify(error="ttl ausente"), 400

    try:
        ok, phash, errors = validate_image_ttl(ttl_text)
    except Exception as e:  # noqa: BLE001
        return jsonify(error=f"parse: {e}"), 400
    if not ok:
        return jsonify(error="shacl", details=errors, phash=phash), 400

    # Variantes — pelo menos uma é obrigatória.
    folder = PHOTOS_DIR / phash
    folder.mkdir(parents=True, exist_ok=True)
    written = []
    for variant in ("original", "large", "thumb"):
        f = request.files.get(variant)
        if not f:
            continue
        # `large` e `thumb` são sempre re-encodadas em JPEG; `original`
        # preserva extensão (heic/png/jpg).
        if variant == "original":
            ext = (os.path.splitext(f.filename or "")[1].lstrip(".") or "jpg").lower()
            if ext not in ("jpg", "jpeg", "png", "heic", "heif"):
                ext = "jpg"
            # Normaliza pra `.jpg` — o cliente resolve URLs como `original.jpg`
            # e não tem como descobrir extensões alternativas; sem isso, fotos
            # salvas como `original.jpeg` 404am no download/preview.
            if ext == "jpeg":
                ext = "jpg"
        else:
            ext = "jpg"
        out = folder / f"{variant}.{ext}"
        f.save(str(out))
        written.append(out.name)
    if not written:
        return jsonify(error="nenhuma variante de imagem enviada"), 400

    # Single-file mode: upsert no web/data/uploads.ttl, deduplicando por phash.
    # O nome da activity ainda inclui timestamp pra ser único como IRI; o
    # "ph:Upload" antigo da mesma imagem é removido pelo upsert. Git history
    # do uploads.ttl preserva o histórico de quem-fez-o-quê-quando.
    try:
        upload_local = _upload_filename()[:-len(".ttl")]   # phd:upload_TIMESTAMP
        audit_block  = _build_audit_ttl(upload_local, phash)
        upsert_image_in_uploads(ttl_text, phash, audit_block)
        register_upload_in_manifest("uploads.ttl")          # idempotente
    except Exception as e:  # noqa: BLE001
        return jsonify(
            error=f"persistência ttl: {e}", phash=phash, files=written,
        ), 500
    print(f"[upload-image] phash={phash} files={written} activity={upload_local}")
    return jsonify(phash=phash, files=written, activity=upload_local, ok=True)


@app.post("/delete-image/<phash>")
def delete_image(phash):
    phash = (phash or "").strip().lower()
    if not phash or not all(c in "0123456789abcdef" for c in phash):
        return jsonify(error="phash inválido"), 400
    folder = PHOTOS_DIR / phash
    removed_files = 0
    if folder.is_dir():
        for f in folder.iterdir():
            try:
                f.unlink()
                removed_files += 1
            except OSError:
                pass
        try:
            folder.rmdir()
        except OSError:
            pass
    try:
        removed_triples = remove_image_from_uploads(phash)
        _invalidate_catalog()
    except Exception as e:  # noqa: BLE001
        return jsonify(
            error=f"persistência ttl: {e}", phash=phash, files=removed_files,
        ), 500
    print(f"[delete-image] phash={phash} files={removed_files} triples={removed_triples}")
    return jsonify(phash=phash, files=removed_files, triples=removed_triples)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8000)))
