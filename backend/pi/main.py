"""
Pedal Hidrográfico — backend Flask.

Mesmo código serve dois alvos:

  STORAGE_BACKEND=local (padrão)  — Pi/dev: estado mutável no filesystem
  STORAGE_BACKEND=gcs              — Cloud Run: estado num bucket GCS

Cada upload contém:
  - `ttl`        : bloco Turtle com exatamente 1 `ph:Image` (texto ou arquivo)
  - `original`   : arquivo da foto fonte (jpg/png/heic). Opcional.
  - `large`      : foto reduzida (~500 KB). Opcional.
  - `thumb`      : miniatura. Opcional.

Validação SHACL contra `web/data/shapes.ttl` (sempre do filesystem do
container/repo); variantes vão para `photos/<phash>/...` no store; triples
deduplicadas em `data/uploads.ttl` no store; manifesto em
`data/data_graphs.ttl` no store.

Rotas:
  GET  /                          serve web/index.html
  GET  /health                    "ok"
  GET  /data/uploads.ttl          do store (mutável)
  GET  /data/data_graphs.ttl      do store (mutável)
  GET  /photos/<path>             do store (redirect p/ URL pública em GCS,
                                  stream local em modo local)
  GET  /<path>                    estáticos de web/ (app.js, shapes.ttl, …)
  POST /upload-image              multipart com `ttl` + variantes
  POST /delete-image/<phash>      remove arquivos + triples

Sem auth — quem alcança o servidor é de confiança.

Variáveis de ambiente:
  STORAGE_BACKEND   local | gcs                 (padrão: local)
  GCS_BUCKET        nome do bucket (modo gcs)
  PHIDRO_WEB        pasta do app                (padrão: ../../web)
  PORT              porta HTTP                  (padrão: 8000)
  STORAGE_EMULATOR_HOST   p/ rodar contra fake-gcs-server localmente
                          (https://github.com/fsouza/fake-gcs-server)
"""
import os
from pathlib import Path

from datetime import datetime, timezone
from flask import Flask, Response, abort, jsonify, redirect, request, send_from_directory

from storage import make_store_from_env

# ── Caminhos ─────────────────────────────────────────────────────────────
# WEB é o filesystem read-only do container/repo: HTML/JS/CSS/icons + os
# TTLs estáticos (shapes, ontology, tours). Resolve em duas tentativas:
#   1. Pi/dev: backend/pi/main.py → repo_root/web ( parents[2] / "web" )
#   2. Container: /app/main.py    → /app/web      ( parent  / "web" )
# `os.environ.get(k, default)` avalia `default` SEMPRE — não dá pra confiar
# em parents[2] cru porque dá IndexError no container.
def _default_web_path():
    here = Path(__file__).resolve()
    try:
        repo_layout = here.parents[2] / "web"
        if repo_layout.is_dir():
            return repo_layout
    except IndexError:
        pass
    return here.parent / "web"

WEB = Path(os.environ.get("PHIDRO_WEB") or _default_web_path()).resolve()
DATA_DIR      = WEB / "data"
SHAPES_PATH   = DATA_DIR / "shapes.ttl"
ONTOLOGY_PATH = DATA_DIR / "ontology.ttl"

# Store = estado mutável. Em modo local, raiz = PHIDRO_WEB (mesma layout
# que o Pi: data/uploads.ttl, photos/<phash>/...); em modo gcs, raiz é o
# bucket GCS. Os "keys" são strings relativas, mesmas em ambos os modos.
STORE = make_store_from_env(WEB)

# Keys de estado mutável (usados como `STORE.read_text(...)` etc.)
KEY_UPLOADS  = "data/uploads.ttl"
KEY_MANIFEST = "data/data_graphs.ttl"

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
    # Lê via _load_dump_text — bucket-first (permite override sem redeploy),
    # com fallback pro arquivo baked-in no container. Mesma semântica que
    # o catálogo: bucket é a fonte vigente, container é o seed inicial.
    shapes_text = _load_dump_text("shapes.ttl")
    ont_text    = _load_dump_text("ontology.ttl")
    if not shapes_text:
        raise RuntimeError("shapes.ttl ausente em bucket e container")
    if not ont_text:
        raise RuntimeError("ontology.ttl ausente em bucket e container")
    shapes = Graph().parse(data=shapes_text, format="turtle")
    ont    = Graph().parse(data=ont_text, format="turtle")
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


def _load_dump_text(fname):
    """Resolve um dump TTL — bucket primeiro, container como fallback.

    Bucket-first permite override de shapes/ontology/tours sem redeploy do
    container: basta `gcloud storage cp` pro bucket. O container traz uma
    cópia "seed" usada quando o bucket ainda não tem o arquivo (boot inicial,
    rollback, dev local sem GCS).
    """
    text = STORE.read_text(f"data/{fname}")
    if text:
        return text
    static_path = DATA_DIR / fname
    if static_path.exists() and static_path.stat().st_size > 0:
        return static_path.read_text()
    return None


def _load_catalog():
    global _catalog_cache
    if _catalog_cache is not None:
        return _catalog_cache
    v = _load_validator()
    Graph = v["Graph"]
    catalog = Graph()
    manifest_text = STORE.read_text(KEY_MANIFEST)
    if manifest_text is None:
        _catalog_cache = catalog
        return catalog
    manifest = Graph().parse(
        data=manifest_text, format="turtle", publicID=MANIFEST_BASE)
    from rdflib import URIRef
    pred = URIRef(VOID_NS + "dataDump")
    loaded = 0
    for _s, _p, o in manifest.triples((None, pred, None)):
        url = str(o)
        fname = url[len(MANIFEST_BASE):] if url.startswith(MANIFEST_BASE) \
                else url.rsplit("/", 1)[-1]
        text = _load_dump_text(fname)
        if not text:
            continue
        try:
            catalog.parse(data=text, format="turtle")
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
    text = STORE.read_text(KEY_MANIFEST)
    if text is not None:
        g.parse(data=text, format="turtle", publicID=MANIFEST_BASE)
    else:
        g.parse(data=MANIFEST_SEED, format="turtle", publicID=MANIFEST_BASE)
    return g


def _save_manifest(g):
    import re
    out = g.serialize(format="turtle", base=MANIFEST_BASE)
    out = re.sub(r'^@base\s+<[^>]*>\s*\.\s*\n', '', out, count=1, flags=re.MULTILINE)
    STORE.write_text(KEY_MANIFEST, out)


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
    if not STORE.exists(KEY_MANIFEST):
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
    existing = STORE.read_text(KEY_UPLOADS)
    if existing:
        catalog.parse(data=existing, format="turtle")
    # 1) Tira da imagem (+ bnodes de hash/loc).
    _purge_subject(catalog, image_iri)
    # 2) Tira qualquer ph:Upload activity que tenha gerado essa imagem.
    for s in list(catalog.subjects(URIRef(PROV_GEN_URI), image_iri)):
        _purge_subject(catalog, s)
    # 3) Mescla os novos blocos (imagem + nova activity).
    catalog += Graph().parse(data=image_ttl + audit_ttl, format="turtle")
    STORE.write_text(KEY_UPLOADS, catalog.serialize(format="turtle"))


def remove_image_from_uploads(phash):
    """Remove triples da imagem + da sua activity de envio. Retorna nº de triples."""
    existing = STORE.read_text(KEY_UPLOADS)
    if not existing:
        return 0
    v = _load_validator()
    from rdflib import URIRef
    image_iri = URIRef(PHD_NS + "image_" + phash)
    catalog = v["Graph"]()
    catalog.parse(data=existing, format="turtle")
    n = _purge_subject(catalog, image_iri)
    for s in list(catalog.subjects(URIRef(PROV_GEN_URI), image_iri)):
        n += _purge_subject(catalog, s)
    STORE.write_text(KEY_UPLOADS, catalog.serialize(format="turtle"))
    return n


# ── Rotas ────────────────────────────────────────────────────────────────
@app.get("/health")
def health():
    return "ok\n"


@app.post("/reload")
def reload_caches():
    """Invalida os caches do validador (shapes/ontology) e do catálogo
    (uploads, tours). Chame após mexer manualmente em qualquer TTL no
    bucket pra forçar a próxima requisição a re-ler do GCS.

    Sem auth — quem alcança o servidor é de confiança (mesma política
    do resto da API). Restrinja na borda (Cloudflare Worker / Access)
    se isso deixar de valer.

    Em Cloud Run com múltiplas instâncias, isto só invalida o cache
    *desta* instância. Pra forçar todas as instâncias a recarregar,
    role um novo deploy ou:
       gcloud run services update-traffic phidro --to-latest \\
         --region=southamerica-east1 --project=pedal-hidrografico
    (Touchar o traffic recria todas as instâncias.)"""
    global _validator
    _validator = None
    _invalidate_catalog()
    return jsonify(ok=True, reloaded=["validator", "catalog"])


@app.get("/")
def index():
    return send_from_directory(WEB, "index.html")


@app.get("/data/<filename>")
def get_data_ttl(filename):
    """Handler único pra /data/*.ttl — bucket-first, container fallback.

    Inclui os mutáveis (uploads.ttl, data_graphs.ttl) e os estáticos
    overrideables (shapes.ttl, ontology.ttl, tours.ttl). Quando o arquivo
    não existe em nenhum dos dois lugares, devolve um seed razoável pros
    dois mutáveis ou 404 pros demais.
    """
    text = _load_dump_text(filename)
    if text is None:
        if filename == "uploads.ttl":
            text = ""             # catálogo vazio — válido
        elif filename == "data_graphs.ttl":
            text = MANIFEST_SEED  # manifesto mínimo
        else:
            abort(404)
    return Response(text, mimetype="text/turtle",
                    headers={"Cache-Control": "no-cache"})


@app.get("/photos/<path:p>")
def get_photo(p):
    key = f"photos/{p}"
    # Se o store expõe URL pública (GCS), redireciona — muito mais eficiente
    # que streamar via Flask. Local store retorna None e cai no fallback.
    url = STORE.public_url(key)
    if url:
        return redirect(url, code=302)
    # Fallback: serve diretamente do filesystem (modo local).
    if (WEB / "photos" / p).is_file():
        resp = send_from_directory(WEB / "photos", p)
        resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return resp
    abort(404)


@app.get("/<path:p>")
def web_files(p):
    """Estáticos de web/ — inclui ./data/{shapes,ontology,tours}.ttl e tudo
    o que não é mutável. Os mutáveis (uploads, data_graphs, photos/*) têm
    handlers próprios acima e nunca caem aqui."""
    if (WEB / p).is_file():
        resp = send_from_directory(WEB, p)
        if p.endswith(".ttl") or p.endswith(".json"):
            resp.headers["Cache-Control"] = "no-cache"
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
            if ext == "jpeg":
                ext = "jpg"
        else:
            ext = "jpg"
        key = f"photos/{phash}/{variant}.{ext}"
        # MIME por extensão; deixamos o store inferir se ausente.
        ct = {
            "jpg": "image/jpeg", "png": "image/png",
            "heic": "image/heic", "heif": "image/heif",
        }.get(ext)
        data = f.read()
        STORE.write_bytes(key, data, content_type=ct)
        written.append(f"{variant}.{ext}")
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


def validate_video_ttl(ttl_text):
    """Espelha validate_image_ttl pra ph:Video: verifica que tem exatamente
    1 ph:Video com IRI phd:video_<vhash16>, e dispara SHACL contra shapes+
    ontology+catálogo (catálogo é mesclado MENOS os triples do próprio vídeo
    em curso, pra que re-uploads não disparem violações de cardinalidade).
    Retorna (ok, vhash, errors)."""
    v = _load_validator()
    from rdflib import URIRef, Namespace, BNode
    data = v["Graph"]().parse(data=ttl_text, format="turtle")

    RDFT = URIRef("http://www.w3.org/1999/02/22-rdf-syntax-ns#type")
    videos = list(data.subjects(RDFT, URIRef(PH_NS + "Video")))
    if len(videos) != 1:
        return False, None, [
            f"TTL deve conter exatamente 1 ph:Video (achou {len(videos)})"
        ]
    video_iri = str(videos[0])
    if not video_iri.startswith(PHD_NS + "video_"):
        return False, None, [
            f"IRI do Video deve começar com phd:video_ (atual: {video_iri})"
        ]
    vhash = video_iri[len(PHD_NS + "video_"):]
    if not vhash or not all(c in "0123456789abcdef" for c in vhash.lower()):
        return False, vhash, [f"vhash inválido na IRI: {vhash}"]

    vid_uri = URIRef(video_iri)
    catalog = _load_catalog()
    vid_bnodes = set()
    queue = [vid_uri]
    while queue:
        cur = queue.pop()
        for _s, _p, o in catalog.triples((cur, None, None)):
            if isinstance(o, BNode) and o not in vid_bnodes:
                vid_bnodes.add(o)
                queue.append(o)
    exclude = vid_bnodes | {vid_uri}
    merged = data + v["ont"]
    for s, p, o in catalog:
        if s not in exclude:
            merged.add((s, p, o))
    conforms, results_graph, _txt = v["pyshacl"].validate(
        merged, shacl_graph=v["shapes"], inference="rdfs", advanced=True)
    if conforms:
        return True, vhash, []

    own_subjects = set(data.subjects())
    SH = Namespace("http://www.w3.org/ns/shacl#")
    errors = []
    for r in results_graph.subjects(SH.resultSeverity, SH.Violation):
        focus = next(results_graph.objects(r, SH.focusNode), None)
        if focus is None or focus in own_subjects:
            msg = next(results_graph.objects(r, SH.resultMessage), None)
            errors.append(str(msg) if msg else "(sem mensagem)")
    if not errors:
        return True, vhash, []
    return False, vhash, errors


@app.post("/upload-video")
def upload_video():
    """Recebe um clipe já processado no browser:
      - `audio`     : opus dentro de webm (sempre presente, alta qualidade)
      - `video360`  : webm 360p sem trilha de áudio (opcional, audio-only mode)
      - `video720`  : webm 720p sem trilha de áudio (opcional, audio-only mode)
      - `ttl`       : TTL auto-suficiente com 1 ph:Video e seus metadados
      - `id`        : pHash de vídeo (16 hex)
    Valida com SHACL (ph:VideoShape), persiste os arquivos em `clips/<id>.*`
    e mescla os triples no único `data/uploads.ttl` (que serve imagens E
    vídeos — namespaces de IRI distinguem: phd:image_ vs phd:video_)."""
    ttl_text = request.form.get("ttl")
    if not ttl_text:
        f = request.files.get("ttl")
        if f:
            ttl_text = f.read().decode("utf-8", errors="replace")
    if not ttl_text:
        return jsonify(error="ttl ausente"), 400

    vid_id = (request.form.get("id") or "").strip().lower()
    if not vid_id or len(vid_id) != 16 or not all(c in "0123456789abcdef" for c in vid_id):
        return jsonify(error="id inválido (esperado vhash de 16 hex)"), 400

    # Audio é obrigatório (a SHACL VideoShape exige ph:audio).
    audio_file = request.files.get("audio")
    if not audio_file:
        return jsonify(error="audio ausente (sempre obrigatório)"), 400

    # Valida antes de gravar — evita lixo em disco se o TTL não bate com a id.
    ok, vhash, errors = validate_video_ttl(ttl_text)
    if not ok and not vhash:
        return jsonify(error="; ".join(errors)), 400
    if vhash != vid_id:
        return jsonify(error=f"id (form) {vid_id} != vhash (ttl) {vhash}"), 400
    if not ok:
        return jsonify(error="SHACL violations", details=errors), 422

    # Grava: audio.webm sempre; webms só se vieram (audio-only mode); thumb
    # opcional (mas o app espera ele pra renderizar o marker como photo-style).
    written = []
    audio_key = f"clips/{vid_id}.audio.webm"
    STORE.write_bytes(audio_key, audio_file.read(), content_type="audio/webm")
    written.append(audio_key)
    thumb_file = request.files.get("thumb")
    if thumb_file:
        thumb_key = f"clips/{vid_id}.thumb.jpg"
        STORE.write_bytes(thumb_key, thumb_file.read(), content_type="image/jpeg")
        written.append(thumb_key)
    for form_field, key_suffix in (("video360", "360p.webm"), ("video720", "720p.webm")):
        f = request.files.get(form_field)
        if not f:
            continue
        key = f"clips/{vid_id}.{key_suffix}"
        STORE.write_bytes(key, f.read(), content_type="video/webm")
        written.append(key)

    # Persiste TTL em uploads.ttl — mesma file dos uploads de imagem. Dedup
    # por IRI (re-upload sobrescreve triples antigos do mesmo vhash).
    try:
        from rdflib import URIRef, BNode, Graph as RdfGraph
        vid_iri = URIRef(PHD_NS + f"video_{vid_id}")
        existing_text = STORE.read_text(KEY_UPLOADS) or ""
        catalog = RdfGraph()
        if existing_text:
            catalog.parse(data=existing_text, format="turtle")
        to_remove_subjects = {vid_iri}
        queue = [vid_iri]
        while queue:
            cur = queue.pop()
            for _s, _p, o in list(catalog.triples((cur, None, None))):
                if isinstance(o, BNode) and o not in to_remove_subjects:
                    to_remove_subjects.add(o)
                    queue.append(o)
        for subj in to_remove_subjects:
            for triple in list(catalog.triples((subj, None, None))):
                catalog.remove(triple)
        catalog.parse(data=ttl_text, format="turtle")
        STORE.write_text(KEY_UPLOADS, catalog.serialize(format="turtle"))
        register_upload_in_manifest("uploads.ttl")  # idempotente
    except Exception as e:  # noqa: BLE001
        return jsonify(error=f"persistência ttl: {e}", id=vid_id, files=written), 500

    print(f"[upload-video] id={vid_id} files={written}")
    return jsonify(id=vid_id, files=written, ok=True)


def remove_video_from_uploads(vhash):
    """Lê os caminhos dos arquivos do vídeo, purga triples (vídeo + bnodes
    alcançáveis), persiste, e devolve (paths, n_triples) — pra que o caller
    delete os blobs no STORE."""
    existing = STORE.read_text(KEY_UPLOADS)
    if not existing:
        return [], 0
    from rdflib import URIRef
    v = _load_validator()
    vid_iri = URIRef(PHD_NS + "video_" + vhash)
    catalog = v["Graph"]()
    catalog.parse(data=existing, format="turtle")
    SCHEMA = "https://schema.org/"
    paths = []
    for pred in (PH_NS + "audio", PH_NS + "video360p", PH_NS + "video720p",
                 SCHEMA + "thumbnail"):
        for o in catalog.objects(vid_iri, URIRef(pred)):
            paths.append(str(o))
    n = _purge_subject(catalog, vid_iri)
    STORE.write_text(KEY_UPLOADS, catalog.serialize(format="turtle"))
    return paths, n


@app.post("/delete-video/<vhash>")
def delete_video(vhash):
    vhash = (vhash or "").strip().lower()
    if not vhash or len(vhash) != 16 or not all(c in "0123456789abcdef" for c in vhash):
        return jsonify(error="vhash inválido"), 400
    try:
        paths, removed_triples = remove_video_from_uploads(vhash)
        _invalidate_catalog()
    except Exception as e:  # noqa: BLE001
        return jsonify(error=f"persistência ttl: {e}", vhash=vhash), 500
    removed_files = 0
    for rel in paths:
        # `rel` é relativo a web/clips/ (ex.: "audio/IMG_X.m4a", "IMG_X.360p.mp4").
        key = f"clips/{rel}"
        try:
            STORE.delete(key)
            removed_files += 1
        except Exception as e:  # noqa: BLE001
            print(f"[delete-video] aviso ao remover {key}: {e}")
    print(f"[delete-video] vhash={vhash} files={removed_files} triples={removed_triples}")
    return jsonify(vhash=vhash, files=removed_files, triples=removed_triples)


@app.post("/delete-image/<phash>")
def delete_image(phash):
    phash = (phash or "").strip().lower()
    if not phash or not all(c in "0123456789abcdef" for c in phash):
        return jsonify(error="phash inválido"), 400
    prefix = f"photos/{phash}/"
    removed_files = len(STORE.list_keys(prefix)) if hasattr(STORE, "list_keys") else 0
    try:
        STORE.delete_prefix(prefix)
    except Exception as e:  # noqa: BLE001
        print(f"[delete-image] erro removendo {prefix}: {e}")
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
