# Pedal Hidrográfico

Static-PWA web map for an urban cycling collective in São Paulo, plus a
self-hosted backend, Python automation scripts, and an RDF ontology. No cloud
dependency — the project deliberately walked away from GCP and is now
local-first.

## Repo layout

- `web/` — the app. A static PWA: `index.html`, one big `app.js` (single
  file, no build step), `style.css`, `sw.js` (service worker),
  `manifest.json`, icons, `lib/` (vendored deps: `utils.js`, `n3.min.js`,
  `energy-worker.js`, `tom-select.complete.min.js`, `tom-select.min.css`).
  Leaflet-based map. Also hosts `upload_images.html` (per-photo upload
  form) and the `data/`, `photos/`, and `clips/` directories the app
  reads from at runtime.
- `backend/pi/` — the self-hosted backend. One Flask service (`main.py`)
  that serves `web/` as static files **and** validates+stores incoming
  photos. No SQLite; state lives in `web/data/uploads.ttl` (per-image
  triples), `web/data/data_graphs.ttl` (manifest pointing at every dump),
  and `web/photos/<phash>/{original,large,thumb}.*` (image variants).
  `phidro.service` (systemd) / `phidro.plist` (launchd),
  `requirements.txt`, `README.md`. Runs on a Raspberry Pi or macOS.
- `research/photos-rdf/` — the RDF research lab. Currently holds
  `build-tours.py` (writes `web/data/tours.ttl` from `data/tours.csv`),
  the seed `data/initial-data.ttl`, `decisions.ttl`, `design.ttl`, and
  the legacy `upload-form.html` (kit-download form — superseded in
  production by `web/upload_images.html`). The active SHACL `shapes.ttl`
  and `ontology.ttl` live alongside the data in `web/data/`; the Pi reads
  them from there at startup. `DESIGN.md` documents the substrate.
- `ontology/` — older RDF vocabulary (`pedalhidrografico.ttl`, v1.1) with a
  JSON-LD context. Superseded by `web/data/ontology.ttl`; kept for
  reference.
- `scripts/` — `build-routes.py` (bakes `routes.json` from
  `web/data/tours.ttl` + RideWithGPS), `build-clips.py` (re-encodes the
  raw videos in `web/clips/raw/` to 360p/720p mp4 + `.m4a` audio and
  writes `web/clips/clips.json`), `deploy.sh` (legacy GCS static mirror),
  `deploy-amora.sh` / `pull-amora.sh` / `pi-deploy.sh` /
  `gcloud-ssh-rsync.sh` (Pi deploy helpers), `gen-synthetic-rdf.py`,
  `exiftool_ph.config`. `coletor_*.py` / `build-photos.py` /
  `build-routes.mjs` are legacy artefacts pending removal — see
  "Open loose ends".

## Architecture

The app is fully static and works offline (service worker). It reads
pre-baked `routes.json` and resolves Turtle dumps via the manifest at
`web/data/data_graphs.ttl` (which currently lists `tours.ttl` and
`uploads.ttl`). When served by the Pi backend, uploads hit
`POST /upload-image` same-origin; on a static-only host (CDN) the form is
offline-friendly but uploads have nowhere to go.

**Photos are described in RDF/Turtle** per the SHACL shapes in
`web/data/shapes.ttl` (notably `ph:ImageShape`). One photo =
one `phd:image_<phash16>` IRI. `phash` is a 64-bit perceptual hash (pHash,
DCT-based, computed in the browser); near-duplicate uploads share an IRI
and naturally cluster.

Key flows:

- **Display.** `web/app.js` fetches `./data/data_graphs.ttl`, follows each
  `void:dataDump` IRI to load the constituent graphs (currently `tours.ttl`
  and `uploads.ttl`), parses them with the bundled N3.js
  (`web/lib/n3.min.js`), and renders one Leaflet marker per `ph:Image`
  (GPS from `schema:locationCreated`, popup from triples). The
  **Configurações** modal (gear icon in the topbar) lets the user switch
  between Pi (same-origin), CDN, or Local (kit ZIP file picker — stored in
  memory, image URLs become blob URLs). Import/export buttons live there.
- **Upload.** `web/upload_images.html` is the operational form. Each card =
  one photo with EXIF auto-fill, tour auto-detect, multi-select people
  (Tom Select w/ create-on-the-fly), license + anonymize/compress toggles.
  Each card POSTs `multipart/form-data` to `/upload-image` with a
  self-contained single-image TTL block + `original`/`large`/`thumb`
  variants. The Pi validates with pyshacl, writes files into
  `web/photos/<phash>/`, and merges the triples into `web/data/uploads.ttl`
  (deduping by IRI). The manifest at `web/data/data_graphs.ttl` registers
  the dump (idempotent). pHash dedup prevents accidental re-uploads in the
  same batch.
- **Validation.** `pyshacl` loads `web/data/shapes.ttl` +
  `web/data/ontology.ttl` once per process. The validator merges the
  incoming TTL with the ontology before checking — `pyshacl`'s `ont_graph`
  parameter does NOT expose ontology-declared instances (like
  `ph:rwgps a schema:Organization`) to `sh:class` checks, so manual
  merging is mandatory. See `research/photos-rdf/DESIGN.md` §2 for the
  full gotcha.
- **Clips / Animação.** The "Animação" topbar button toggles both the
  photo-marker spotlight pulse AND a ghost-video overlay (`web/clips/`
  → translucent `<video>` over the map). The app fetches
  `./clips/clips.json`, places a marker per clip at its EXIF GPS, and
  plays through clips in random order with a 5-state marker handoff
  (green intro → pulsing white → orange outro). An independent "Loop de
  áudio" plays the same clips' audio-only tracks with a longer crossfade
  for ambient use. Both have controls in Ajustes and the layer panel.

## Clips workflow

Source videos in `web/clips/raw/` (`.MOV`/`.mp4`/`.m4v`). Run:

```sh
python scripts/build-clips.py
```

Requires `ffmpeg` and `exiftool` in `$PATH` (Homebrew on macOS, `apt` on
Pi). For each source the script:

- Reads GPS + duration + dimensions via `exiftool` (clips with no GPS are
  skipped).
- Transcodes a `<stem>.360p.mp4` (always) and `<stem>.720p.mp4`
  (best-effort, opt-in via `clipsGhost.useHd`) into `web/clips/`.
- Extracts the audio track to `web/clips/audio/<stem>.m4a` (AAC 96k).
- Writes the index `web/clips/clips.json` with `{file, file720, audio,
  lat, lng, duration, ...}` per clip.

The mtime check makes re-runs cheap. Adding a new clip = drop into
`raw/` and re-run.

## Conventions — please follow

- **Bump `sw.js` `VERSION`** on *any* change to files in `web/` —
  otherwise the service worker serves stale cached copies and the change
  won't reach users. It's a monotonic `phidro-vN` integer counter; just
  increment.
- **No backend auth.** Anyone who can reach the Pi can upload/delete — this
  is an intentional decision (trusted access assumed). Don't reintroduce a
  token; restrict at the edge if needed.
- **The Pi serves its own git clone.** Deploying changes = `git pull` on the
  Pi + restart the service + hard-reload the browser. There is no separate
  build/upload step for the self-hosted path.
- **Ontology:** reuse consolidated vocabularies (schema.org, PROV-O, QUDT,
  GeoSPARQL, Dublin Core); mint `ph:` terms only for what is specific to
  Pedal Hidrográfico.
- **No GCP.** The `scripts/deploy.sh` GCS path still exists for a read-only
  static mirror at `tiles.pedalhidrografi.co/rotas_app`, but the live system
  is the Pi. Don't add cloud dependencies.
- Comments and UI strings are in Portuguese; code identifiers in English.

## Verify before finishing

- JS in `web/`: load it in a browser (or the existing dev server) — the
  browser surfaces syntax errors immediately. No standalone JS tooling here.
- Bump `web/sw.js` `VERSION` if any file under `web/` changed.
- `python -m py_compile backend/pi/main.py`
- Ontology / shapes / data: parse with `rdflib` after editing `*.ttl`.

## Build & deploy

- `python scripts/build-routes.py` — regenerate `web/routes.json` by
  reading `web/data/tours.ttl` (the Tour catalog) and fetching each
  referenced GPX from RideWithGPS. Requires `python-dotenv` plus
  `RWGPS_API_KEY` / `RWGPS_AUTH_TOKEN` in `.env`.
- `python research/photos-rdf/build-tours.py` — regenerate
  `web/data/tours.ttl` from `research/photos-rdf/data/tours.csv`. Run this
  whenever the spreadsheet changes; `build-routes.py` consumes its output.
- `python scripts/build-clips.py` — re-encode anything in `web/clips/raw/`
  to 360p/720p mp4 + `.m4a` audio and rewrite `web/clips/clips.json`. See
  "Clips workflow" above. Requires `ffmpeg` + `exiftool`.
- `bash scripts/deploy.sh` (or `bash scripts/deploy.sh --dry-run`) — sync
  `web/` to the GCS static mirror (read-only; needs `gcloud` auth).
- Pi: `pip install -r backend/pi/requirements.txt && python backend/pi/main.py`
  (defaults to port 8000; override with `PORT=…`). See `backend/pi/README.md`.

## Open loose ends

- **Retire legacy build scripts.** `scripts/build-routes.mjs` (the old
  Node port; `package.json`'s `build:routes` script still points at it),
  `scripts/build-photos.py` (predates the upload form), and
  `scripts/coletor_*.py` are all superseded. User-deletes when ready:
  `git rm scripts/build-routes.mjs scripts/build-photos.py scripts/coletor_*.py`.
- **`research/photos-rdf/upload-form.html`** is the legacy "build a kit ZIP"
  form. Production uploads go through `web/upload_images.html`. Keep the
  research one only if you still use it for batch-export experiments.
- **`web/data/uploads.ttl` and `web/photos/<phash>/`** are runtime artifacts
  of the Pi — gitignore or commit per your deploy strategy. The CDN mirror
  shows no photos until those files exist at the destination.
- **`web/clips/raw/`** holds source videos (large). Probably want
  gitignored. The build artifacts (`*.360p.mp4`, `*.720p.mp4`, `audio/*.m4a`,
  `clips.json`) are smaller and can be committed if you want the static
  mirror to ship clips, or generated in CI.

## Notes

- Working files we changed this cycle are likely uncommitted — check
  `git status` and commit with meaningful messages.
- Permanent deletions (files, data) should be left to the user — provide the
  commands rather than running them.
