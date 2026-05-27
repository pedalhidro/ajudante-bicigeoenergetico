# pedalhidrografico

Static PWA: an OpenStreetMap with the Pedal Hidrográfico hydrography overlay,
every passeio of the collective drawn on top of it, filterable by date, with
the linked Instagram post embedded on click. Includes an in-browser GPX
drawing tool and a photo overlay sourced from RDF/Turtle. Architecture and
conventions in [CLAUDE.md](CLAUDE.md); ontology notes in
[research/photos-rdf/DESIGN.md](research/photos-rdf/DESIGN.md); self-hosted
backend in [backend/pi/README.md](backend/pi/README.md).

## What it does

- OpenStreetMap base + custom hydrography overlay
  (`https://telhas.pedalhidrografi.co/rmsampa-v2/{z}/{x}/{y}.png`), togglable
  via the layer control.
- Renders every passeio from `web/data/tours.ttl` in white with a dark
  casing, labelled by `Data — Nome`.
- Numbered overlay per route (plain text + halo). Multi-series tours show
  every series code stacked (e.g. `PH 79` / `BP 4`).
- Sidebar sorted by date descending. Date-window slider filters in real
  time.
- Click a route → modal embedding the linked Instagram post.
- **Traçar GPX** button: click the map to drop trackpoints, drag them to
  move, Undo/Redo (also ⌘/Ctrl+Z / ⌘/Ctrl+Shift+Z), then **Salvar GPX**
  downloads a `.gpx` file. Esc cancels.
- Geo-tagged photo overlay loaded from `web/data/uploads.ttl`. Click a
  photo dot → centered modal preview (auto-fallback when the popup won't
  fit the viewport).
- **Animação** — toggles a photo-marker spotlight pulse and a translucent
  ghost-video overlay on the map (clips from `web/clips/`, segments
  picked at random with audio + image cross-fading). Each clip's GPS
  marker is a white ring that pulses with the audio's RMS amplitude;
  bracketed by a 1-second green intro and orange outro to flag the
  handoff between clips.
- **Loop de áudio** — same clip catalog, ambient audio-only mode with
  longer crossfades. Independent of Animação.
- Mobile-first UI: bottom-sheet dialogs (Camadas, Rotas, Enviar,
  Ajustes, Ajuda), dual-thumb date slider with native date pickers on
  the labels, dark theme with orange accent. PWA installable as "Amora".

## Architecture

It's a fully static site with an optional self-hosted backend for uploads.
Two stages:

1. **Build steps (Python, with credentials).**
   - `python research/photos-rdf/build-tours.py` reads
     `research/photos-rdf/data/tours.csv` and writes
     `web/data/tours.ttl` (the Tour catalog).
   - `python scripts/build-routes.py` reads `web/data/tours.ttl`, fetches
     every referenced GPX from RideWithGPS, downsamples each track to
     ≤400 points, and writes everything into `web/routes.json`. Unique
     RWGPS IDs are fetched once even when multiple tours share a route
     (e.g. anniversary re-rides). This is the only place RWGPS credentials
     are needed — the browser never sees them.
   - `python scripts/build-clips.py` (optional) re-encodes any source
     videos in `web/clips/raw/` to 360p + 720p mp4 plus an `.m4a` audio
     extract, and writes `web/clips/clips.json`. Requires `ffmpeg` and
     `exiftool` in PATH.

2. **Runtime (browser only).** `web/index.html` loads `routes.json` and
   resolves data graphs via `web/data/data_graphs.ttl`. No backend
   required at runtime; serve `web/` from any static host. For uploads
   and photo storage, run the backend — see
   [backend/pi/README.md](backend/pi/README.md).

## Run it

```bash
pip install python-dotenv rdflib pyshacl       # build + backend deps
cp .env.example .env
# fill in RWGPS_API_KEY and RWGPS_AUTH_TOKEN — see "Credentials" below

python research/photos-rdf/build-tours.py      # writes web/data/tours.ttl
python scripts/build-routes.py                 # writes web/routes.json
```

Then serve `web/` with anything:

```bash
cd web && python -m http.server 8000
# open http://localhost:8000/
```

Python 3.10+ recommended (uses `str | None` annotations and `urllib`).

Re-run `build-tours.py` whenever the spreadsheet changes, then
`build-routes.py` to refresh `routes.json`.

### Static deploy

After the build steps above, `web/` is fully self-contained. Push it to
GitHub Pages, Netlify, S3, etc. and you're done — no server needed.
Photos won't show on a static mirror unless you also publish `web/data/`
and `web/photos/` from a backend run.

## Credentials

`.env` is gitignored. Build steps are the only thing that touches
credentials.

- `RWGPS_API_KEY` — request one at <https://ridewithgps.com/api>.
- `RWGPS_AUTH_TOKEN` — auth token for the user account that owns the routes.
  You can get it by `POST`ing email+password to
  `https://ridewithgps.com/users/current.json` (response includes
  `user.auth_token`), or from your account settings page.
- `RWGPS_COLLECTION_PRIVACY_CODE` — set if some routes are unlisted and need
  the collection privacy code.

## Caveats

- **Instagram embeds only work for public posts.** Private-account posts won't
  render in the iframe — the modal falls back to a "View on Instagram ↗" link.
- **`web/routes.json` is gitignored** so credentials-derived data isn't
  committed by accident. To deploy via GitHub Pages without a build server,
  remove it from `.gitignore` and commit the JSON.
- **The Traçar GPX tool produces a bare track** (no elevation, no per-point
  timestamps — there's no real source for those when drawing from scratch).
  Most platforms (RWGPS, Strava, Komoot) will fill in elevation server-side
  on upload.
