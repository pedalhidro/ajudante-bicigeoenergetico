// Pedal Hidrográfico — "Rotas" page (standalone)
//
// Reads the pre-baked web/routes.json (produced by `python scripts/build-routes.py`),
// renders every route on a Leaflet map with OSM + the custom hydrography
// overlay, sorts the sidebar by Data descending, and supports:
//   - a date-window slider that filters routes in real time
//   - clicking a route to open a modal embedding the linked Instagram post

const ROUTES_JSON_URL = 'routes.json';
const SP = [-23.5505, -46.6333];
const DAY_MS = 86_400_000;

// First ES-module migration step: pure helpers + toast + storage live in
// lib/utils.js. The rest of app.js still uses module-level let/const to be
// migrated incrementally.
import {
  escapeHtml,
  escapeXml,
  formatHMS,
  mapConcurrent,
  haversineMeters as haversine,
  showToast,
  storage,
} from './lib/utils.js';

// ─── Settings ────────────────────────────────────────────────────────────────
// Tudo aqui é tunável pelo modal de Configurações (gear no topbar). Defaults
// vivem em SETTINGS_DEFAULTS; o objeto `settings` é o estado vivo, persistido
// em localStorage e exportável/importável como JSON-LD.
const SETTINGS_KEY = 'phidro:settings';
const SETTINGS_DEFAULTS = {
  photoSource: 'pi',                    // 'pi' | 'cdn' | 'auto' | 'local'
  spotlight: {
    enabled: false,
    boost: 10.0,
    peakSec: 1,
    peakCount: 1,
    pulseShape: 7,
    echoAmp: 0.7,
    echoOffset: 0.7,
    tickMs: 200,
  },
  markerLayout: {
    minScaleFloor: 0.4,
    minScaleCeil: 0.9,
    rampStart: 13,
    rampEnd: 18,
    hoverScale: 3.3,                    // ×40px = tamanho do photo-dot no hover
  },
  mapDefaults: {
    startZoom: 12,                      // aplicado no load inicial
    baseLayer: 'osm',                   // 'osm' | 'satellite'
  },
  clipsGhost: {
    enabled: true,                      // tocar vídeo fantasma quando Animação ligada
    segmentSec: 10,                     // duração de cada clipe em laço
    fadeSec: 2,                         // duração do fade-in/out da imagem
    audioFadeSec: 4,                    // fade do áudio — geralmente mais longo que o vídeo
    useHd: false,                       // usar a variante 720p (mais pesada) em vez da 360p
  },
  clipMarker: {
    baseSizePx: 18,                     // diâmetro do anel branco em repouso
    borderPx: 3,                        // espessura da borda
    minScale: 0.1,                      // escala no silêncio
    maxScale: 20,                       // escala no pico de RMS
    intensityGain: 4,                   // multiplicador no RMS pra esticar a faixa visual
  },
  audioLoop: {
    enabled: false,                     // loop ambiente só com o áudio dos clipes
    segmentSec: 12,                     // tempo por trilha antes do crossfade
    crossfadeSec: 5,                    // duração do crossfade entre trilhas
  },
  fovCone: {
    enabled: true,                      // mostra cone de visada quando há EXIF bearing
    sizeScale: 1.0,                     // multiplica o raio do cone (1 = default ~38 SVG units)
    opacity: 0.45,                      // 0..1, aplicado em fill-opacity via custom property
  },
  images: {
    // Markers usam `image-set(thumb 1x, large 2x)` por padrão — em retina
    // o browser baixa a versão `large` (~500 KB) pra nitidez. Com dezenas
    // de markers isso estoura memória em celular. Quando OFF (padrão), o
    // 2x não é declarado e os markers ficam no thumb mesmo em retina.
    // Não afeta o popup de preview (que sempre usa `large`).
    useLarge: false,
  },
  attendees: {
    // Toggle de privacidade pra listagem nominal de participantes /
    // iniciantes nos passeios. OFF por padrão — quando ON, o modal de
    // rota mostra "Participantes" e "Iniciantes" como chips, o censo
    // ganha colunas com a contagem nominal, e o upload_tour expõe os
    // campos pra edição. Os dados nos triples (schema:attendee,
    // ph:hasNewcomer) NÃO são afetados pelo toggle — só a renderização.
    list: false,
  },
};
function _deepMerge(base, over) {
  if (!over || typeof over !== 'object') return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const k of Object.keys(over)) {
    const v = over[k];
    if (v && typeof v === 'object' && !Array.isArray(v)
        && base && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = _deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return JSON.parse(JSON.stringify(SETTINGS_DEFAULTS));
    return _deepMerge(SETTINGS_DEFAULTS, JSON.parse(raw));
  } catch {
    return JSON.parse(JSON.stringify(SETTINGS_DEFAULTS));
  }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
}
const settings = loadSettings();
// Migração: fonte de imagens ficava em chave separada — preserva valor antigo.
{
  const legacy = localStorage.getItem('phidro:photoSource');
  if (legacy && settings.photoSource === SETTINGS_DEFAULTS.photoSource) {
    settings.photoSource = legacy;
  }
}
// Animação NÃO persiste entre sessões — sempre arranca desligada. Se o
// usuário ligar no Ajustes/botão, vale só pra sessão atual.
if (settings.spotlight) settings.spotlight.enabled = false;

// ─── Map ─────────────────────────────────────────────────────────────────────
const map = L.map('map', { zoomControl: true })
  .setView(SP, settings.mapDefaults.startZoom);

// Preview de foto/vídeo: popup do Leaflet quando cabe na viewport; senão
// (tipicamente mobile portrait), promovemos pra um modal bottom-sheet
// centralizado. O Leaflet sozinho não dá uma UX boa em mobile — o popup
// fica espremido contra as bordas, hit-area pequena pro fechar, e o
// autoPan acaba escondendo o marker. O modal resolve isso.

let savedMapViewForPhoto = null;
function panMapAbovePhotoSheet(latlng, modal) {
  if (!latlng) return;
  // Salva a view só na primeira chamada de uma sessão — chamadas seguintes
  // (ex.: avançando entre clipes) já estão num estado deslocado.
  if (!savedMapViewForPhoto) {
    savedMapViewForPhoto = { center: map.getCenter(), zoom: map.getZoom() };
  }
  const mapEl = map.getContainer();
  const mapRect = mapEl.getBoundingClientRect();
  const sheet = modal && !modal.hidden ? modal.querySelector('.modal-content') : null;
  const modalRect = sheet
    ? sheet.getBoundingClientRect()
    : { top: window.innerHeight };
  const visTop = Math.max(0, mapRect.top);
  const visBottom = Math.min(modalRect.top, mapRect.bottom);
  const desiredY = (visTop + visBottom) / 2 - mapRect.top;
  const desiredX = mapEl.clientWidth / 2;
  const pt = map.latLngToContainerPoint(latlng);
  const dx = pt.x - desiredX;
  const dy = pt.y - desiredY;
  if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
    map.panBy([dx, dy], { animate: true, duration: 0.25 });
  }
}
// Pausa qualquer <video>/<audio> dentro do container — usado tanto no
// fechamento do popup do Leaflet quanto do fallback modal pra evitar
// áudio tocando em background depois que o dialog fecha.
function pauseMediaIn(root) {
  if (!root) return;
  for (const el of root.querySelectorAll?.('video, audio') || []) {
    try { el.pause(); } catch (_) {}
  }
}

// Leaflet só fecha o popup detachando o DOM; em alguns browsers o <video>
// continua tocando antes do GC. Pausa explícita no popupclose.
map.on('popupclose', (e) => {
  const el = e.popup?.getElement?.();
  if (el) pauseMediaIn(el);
});

function restoreMapViewAfterPhoto() {
  if (!savedMapViewForPhoto) return;
  const { center, zoom } = savedMapViewForPhoto;
  savedMapViewForPhoto = null;
  map.flyTo(center, zoom, { duration: 0.3 });
}
function showPhotoFallbackModal(innerHtml) {
  let modal = document.getElementById('photo-fallback-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'photo-fallback-modal';
    modal.className = 'modal photo-fallback-modal';
    modal.hidden = true;
    modal.addEventListener('click', (ev) => {
      if (ev.target === modal) {
        pauseMediaIn(modal);
        modal.hidden = true;
        restoreMapViewAfterPhoto();
      }
    });
    document.body.appendChild(modal);
  }
  modal.innerHTML =
    '<div class="modal-content photo-fallback-content">' +
      '<button class="close photo-fallback-close" type="button" aria-label="Fechar">×</button>' +
      innerHtml +
    '</div>';
  modal.querySelector('.photo-fallback-close').addEventListener('click', () => {
    pauseMediaIn(modal);
    modal.hidden = true;
    restoreMapViewAfterPhoto();
  });
  modal.hidden = false;
}
function popupFitsViewport(el) {
  const rect = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const margin = 16;
  return (
    rect.left >= margin &&
    rect.top >= margin &&
    rect.right <= vw - margin &&
    rect.bottom <= vh - margin
  );
}
map.on('popupopen', (e) => {
  const popup = e.popup;
  const el = popup.getElement?.();
  if (!el || !el.classList.contains('photo-popup-wrap')) return;
  // Se já tem um modal aberto (de outro marker), fecha — evita dois previews
  // visíveis e o snap-back de map view ficar incoerente.
  const existingModal = document.getElementById('photo-fallback-modal');
  if (existingModal && !existingModal.hidden) {
    pauseMediaIn(existingModal);
    existingModal.hidden = true;
    restoreMapViewAfterPhoto();
  }
  const promoteIfNeeded = () => {
    if (!el.isConnected || el.style.visibility === 'hidden') return;
    if (popupFitsViewport(el)) return;
    const inner = el.querySelector('.photo-popup');
    if (!inner) return;
    el.style.visibility = 'hidden';
    showPhotoFallbackModal(inner.outerHTML);
    setTimeout(() => map.closePopup(popup), 0);
    const latlng = popup.getLatLng?.();
    const modal = document.getElementById('photo-fallback-modal');
    requestAnimationFrame(() => panMapAbovePhotoSheet(latlng, modal));
  };
  // Espera o layout assentar, e re-checa quando a img/video terminar de
  // baixar (sem dimensões a primeira medição erra).
  requestAnimationFrame(promoteIfNeeded);
  const media = el.querySelector('.photo-popup img, .photo-popup video');
  if (media) {
    const evt = media.tagName === 'VIDEO' ? 'loadedmetadata' : 'load';
    if (!media.complete && !(media.duration > 0)) {
      media.addEventListener(evt, () => requestAnimationFrame(promoteIfNeeded), { once: true });
    }
  }
});

const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors',
});
const satellite = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  {
    maxZoom: 19,
    attribution:
      'Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community',
  },
);
// Camada base inicial vem do settings.mapDefaults.baseLayer.
(settings.mapDefaults.baseLayer === 'satellite' ? satellite : osm).addTo(map);

const rmsampa = L.tileLayer('https://telhas.pedalhidrografi.co/rmsampa-v2/{z}/{x}/{y}.png', {
  maxZoom: 19,
  // O servidor só tem tiles até z=16; acima disso o Leaflet escala o tile do
  // z=16 (interpolado) em vez de pedir z≥17 e levar 404.
  maxNativeZoom: 16,
  opacity: 0.85,
  attribution: 'Topografia: Pedal Hidrográfico',
}).addTo(map);

// Historical aerial photo mosaic of São Paulo (SARA Brasil, 1930), served
// from GeoSampa's GeoServer. Leaflet's L.tileLayer.wms requests one tile at
// a time. To browse other historical mosaics on the same workspace see:
//   https://raster.geosampa.prefeitura.sp.gov.br/geoserver/geoportal/wms?service=WMS&request=GetCapabilities
const sara1930 = L.tileLayer.wms(
  'https://raster.geosampa.prefeitura.sp.gov.br/geoserver/geoportal/wms',
  {
    layers: 'SaraBrasil_1930',
    format: 'image/png',
    transparent: true,
    version: '1.3.0',
    opacity: 0.85,
    maxZoom: 19,
    attribution: 'SARA Brasil 1930 · GeoSampa / Prefeitura de São Paulo',
  },
);

// ─── Combined layer panel ────────────────────────────────────────────────────
// A single control with both visibility (radio for base, checkbox for
// overlays) and an opacity slider per layer — all clustered together.
const BASE_LAYERS = [
  { id: 'osm',       label: 'OpenStreetMap', layer: osm,       defaultActive: true,  defaultPct: 100 },
  { id: 'satellite', label: 'Satélite',      layer: satellite, defaultActive: false, defaultPct: 100 },
];
const OVERLAY_LAYERS = [
  { id: 'rmsampa',  label: 'Topografia colorida', layer: rmsampa,  defaultVisible: true,  defaultPct: 85 },
  { id: 'sara1930', label: 'SARA 1930',           layer: sara1930, defaultVisible: false, defaultPct: 85 },
  // Pseudo-layer for the loaded sidebar routes. Custom show/hide/setOpacity
  // because routes are a Map of polylines + markers, not a single tileLayer.
  {
    id: 'routes',
    label: 'Rotas cadastradas',
    defaultVisible: true,
    defaultPct: 100,
    show: () => setRoutesGloballyVisible(true),
    hide: () => setRoutesGloballyVisible(false),
    setOpacity: (frac) => applyRoutesOpacity(frac * 100),
  },
  // Live OSM hydrography + ridges via Overpass. Re-queries on pan/zoom.
  {
    id: 'osm-overpass',
    label: 'Morros e Águas',
    defaultVisible: false,
    defaultPct: 100,
    show: () => showOverpass(),
    hide: () => hideOverpass(),
    setOpacity: (frac) => setOverpassOpacity(frac),
  },
  // Live OSM cycling infrastructure (cyclovias, ciclofaixas, paths).
  {
    id: 'osm-cicloinfra',
    label: 'Cicloinfra OSM',
    defaultVisible: false,
    defaultPct: 100,
    show: () => showCycloinfra(),
    hide: () => hideCycloinfra(),
    setOpacity: (frac) => setCycloinfraOpacity(frac),
  },
  // Fotos geotaggeadas (lidas do manifesto web/data/data_graphs.ttl, que
  // aponta pra uploads.ttl entre outros dumps). Pequenos círculos que abrem
  // o thumbnail num popup ao clicar.
  {
    id: 'photos',
    label: 'Imagens contribuídas',
    defaultVisible: true,
    defaultPct: 100,
    show: () => showPhotos(),
    hide: () => hidePhotos(),
    setOpacity: (frac) => setPhotosOpacity(frac),
  },
  // Vídeo fantasma — o checkbox espelha `settings.clipsGhost.enabled`
  // (start/stop da reprodução); o slider controla a opacidade visual do
  // <video> sobreposto. Animação (botão da topbar) é o switch global.
  {
    id: 'clips-ghost',
    label: 'Vídeo fantasma',
    defaultVisible: true,
    defaultPct: 70,
    show: () => {
      if (settings.clipsGhost) settings.clipsGhost.enabled = true;
      saveSettings();
      applyClipsGhostSettings();
      setClipsGhostOpacity(clipsGhostUserOpacity);
    },
    hide: () => {
      if (settings.clipsGhost) settings.clipsGhost.enabled = false;
      saveSettings();
      applyClipsGhostSettings();
    },
    setOpacity: (frac) => { clipsGhostUserOpacity = frac; setClipsGhostOpacity(frac); },
  },
  // Loop de áudio — o checkbox espelha `settings.audioLoop.enabled`; o
  // slider controla o volume máximo das trilhas durante o crossfade.
  {
    id: 'audio-loop',
    label: 'Loop de áudio',
    defaultVisible: false,
    defaultPct: 80,
    show: () => {
      if (settings.audioLoop) settings.audioLoop.enabled = true;
      saveSettings();
      applyAudioLoopSettings();
    },
    hide: () => {
      if (settings.audioLoop) settings.audioLoop.enabled = false;
      saveSettings();
      applyAudioLoopSettings();
    },
    setOpacity: (frac) => setAudioLoopUserVolume(frac),
  },
  // User-defined tile sources. The URL is prompted on demand and persisted
  // in localStorage so the layer is restored on reload.
  {
    id: 'custom-xyz',
    label: 'XYZ custom',
    defaultVisible: false,
    defaultPct: 80,
    editable: true,
    show: () => showCustomXyz(),
    hide: () => hideCustomXyz(),
    setOpacity: (frac) => { if (customXyzLayer) customXyzLayer.setOpacity(frac); },
    edit: () => promptCustomXyzUrl(),
  },
  {
    id: 'custom-wms',
    label: 'WMS custom',
    defaultVisible: false,
    defaultPct: 80,
    editable: true,
    show: () => showCustomWms(),
    hide: () => hideCustomWms(),
    setOpacity: (frac) => { if (customWmsLayer) customWmsLayer.setOpacity(frac); },
    edit: () => promptCustomWmsConfig(),
  },
];

// ─── Overpass (OSM live) overlay ─────────────────────────────────────────────
// Live-queries the OSM Overpass API for waterways and ridges in the current
// viewport. Re-runs on pan/zoom (debounced). Hover any feature to see its
// name + type in a tooltip. Style mirrors the user's JOSM "Morros e Águas"
// stylesheet:
//   waterway=river                green  #A6C045 w5  (dashed if tunnel)
//   waterway=stream/canal/etc     ochre  #DDB84F w3  (dashed if tunnel)
//   natural=ridge                 orange #EF7A30 w3
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const OVERPASS_MIN_ZOOM = 13;
const overpassLayers = [];
let overpassActive = false;
let overpassOpacity = 1;
let overpassDebounce = null;
let overpassFetchSeq = 0;

async function queryOverpass(b) {
  // Three buckets:
  //   - waterways within the viewport bbox
  //   - natural=ridge within the viewport bbox
  //   - relations tagged cycle_network=BR:PedalHidrografico (no bbox; the
  //     network is small and local, easier to fetch them all and let the
  //     viewport clip naturally on draw)
  // The trailing `>;` recursion expands relations down to their member ways
  // and nodes so we can render the actual cycle paths.
  const q = `[out:json][timeout:60];
(
  way["waterway"](${b.south},${b.west},${b.north},${b.east});
  way["natural"="ridge"](${b.south},${b.west},${b.north},${b.east});
  relation["cycle_network"="BR:PedalHidrografico"];
);
out body;
>;
out skel qt;`;
  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    body: 'data=' + encodeURIComponent(q),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  if (!res.ok) throw new Error(`Overpass ${res.status}`);
  return res.json();
}

function styleForOverpassWay(tags, isCycle) {
  if (isCycle) {
    // Pedal Hidrográfico cycle-network member ways: bright accent blue,
    // thick, on top of everything else.
    return { color: '#2da9ff', weight: 5, opacity: overpassOpacity };
  }
  const tunnel = !!tags.tunnel;
  if (tags.natural === 'ridge') {
    return { color: '#EF7A30', weight: 3, opacity: overpassOpacity };
  }
  if (tags.waterway === 'river') {
    return {
      color: '#A6C045',
      weight: 5,
      opacity: overpassOpacity,
      dashArray: tunnel ? '4 6' : null,
    };
  }
  if (tags.waterway) {
    return {
      color: '#DDB84F',
      weight: 3,
      opacity: overpassOpacity,
      dashArray: tunnel ? '4 4' : null,
    };
  }
  return { color: '#888', weight: 2, opacity: overpassOpacity };
}

function clearOverpassLayers() {
  for (const l of overpassLayers) map.removeLayer(l);
  overpassLayers.length = 0;
}

function renderOverpass(data) {
  clearOverpassLayers();
  const nodes = new Map();
  // First pass: index nodes and collect cycle-network relations + their
  // member-way IDs so the second pass can style/label cycle ways distinctly.
  const wayToCycleRelation = new Map(); // way id → relation element
  for (const el of data.elements || []) {
    if (el.type === 'node') {
      nodes.set(el.id, [el.lat, el.lon]);
    } else if (
      el.type === 'relation' &&
      el.tags &&
      el.tags.cycle_network === 'BR:PedalHidrografico'
    ) {
      for (const member of el.members || []) {
        if (member.type === 'way') wayToCycleRelation.set(member.ref, el);
      }
    }
  }

  // Second pass: render every way.
  for (const el of data.elements || []) {
    if (el.type !== 'way') continue;
    const latlngs = (el.nodes || []).map((id) => nodes.get(id)).filter(Boolean);
    if (latlngs.length < 2) continue;
    const tags = el.tags || {};
    const cycleRel = wayToCycleRelation.get(el.id);
    const isCycle = !!cycleRel;
    const layer = L.polyline(latlngs, styleForOverpassWay(tags, isCycle));

    let html;
    if (isCycle) {
      const relName = cycleRel.tags?.name || 'Pedal Hidrográfico';
      const ref = cycleRel.tags?.ref;
      const parts = [`<strong>${escapeHtml(relName)}</strong>`];
      if (ref) parts.push(`<em>ref ${escapeHtml(ref)}</em>`);
      if (tags.name) parts.push(escapeHtml(tags.name));
      html = parts.join(' · ');
    } else {
      const parts = [];
      if (tags.name) parts.push(`<strong>${escapeHtml(tags.name)}</strong>`);
      const kind = tags.waterway || tags.natural || '';
      if (kind) parts.push(`<em>${escapeHtml(kind)}</em>`);
      if (tags.tunnel) parts.push('(túnel)');
      html = parts.join(' · ') || 'OSM';
    }
    layer.bindTooltip(html, { sticky: true, className: 'osm-tip' });
    layer.addTo(map);
    overpassLayers.push(layer);
  }
}

async function refreshOverpass() {
  if (!overpassActive) return;
  if (map.getZoom() < OVERPASS_MIN_ZOOM) {
    clearOverpassLayers();
    showToast(`Aproxime o mapa (zoom ≥ ${OVERPASS_MIN_ZOOM}) para buscar OSM`);
    return;
  }
  const b = map.getBounds();
  const bbox = {
    south: b.getSouth().toFixed(6),
    west: b.getWest().toFixed(6),
    north: b.getNorth().toFixed(6),
    east: b.getEast().toFixed(6),
  };
  const seq = ++overpassFetchSeq;
  showToast('Buscando hidrografia OSM…', 1500);
  try {
    const data = await queryOverpass(bbox);
    if (seq !== overpassFetchSeq || !overpassActive) return;
    renderOverpass(data);
    showToast(`OSM: ${overpassLayers.length} feições`, 1800);
  } catch (err) {
    if (seq !== overpassFetchSeq) return;
    console.warn('Overpass failed:', err);
    showToast(`Falha Overpass: ${err.message}`);
  }
}

function onOverpassMoveEnd() {
  clearTimeout(overpassDebounce);
  overpassDebounce = setTimeout(refreshOverpass, 700);
}

function showOverpass() {
  overpassActive = true;
  map.on('moveend', onOverpassMoveEnd);
  refreshOverpass();
}
function hideOverpass() {
  overpassActive = false;
  map.off('moveend', onOverpassMoveEnd);
  clearTimeout(overpassDebounce);
  clearOverpassLayers();
}
function setOverpassOpacity(frac) {
  overpassOpacity = frac;
  for (const l of overpassLayers) l.setStyle({ opacity: frac });
}

// ─── Fotos geotaggeadas (manifesto → dumps em web/data/*.ttl) ─────────────
// Cada foto com GPS vira um pequeno círculo no mapa; clicar abre um popup
// com o thumbnail. O acervo é descrito em RDF/Turtle conforme
// `data/shapes.ttl` (ph:ImageShape). O app lê `data/data_graphs.ttl` (um
// void:Dataset) pra descobrir quais dumps carregar — atualmente
// `uploads.ttl` (imagens) e `tours.ttl` (passeios). N3.js parseia tudo
// no browser; a fonte pode ser o Pi, a CDN, ou um kit local (.zip).
const PHOTOS_DIR_REL    = 'photos/';                       // <phash>/{original,large,thumb}.jpg
const PHOTOS_CDN_BASE   = 'https://tiles.pedalhidrografi.co/rotas_app/';
const TOURS_TTL_REL     = 'data/tours.ttl';                // catálogo de passeios (opcional)

// Origem persistida em localStorage: 'auto' | 'pi' | 'cdn' | 'local'.
// Default 'pi' (mesma origem). 'auto' tentaria CDN também — útil em prod,
// mas pra dev local gera DNS errors barulhentos quando o CDN não existe.
// O usuário pode trocar via 🗂 Fonte….
let photoSource = settings.photoSource;
// Quando local: kit ZIP descompactado em memória, com blob URLs por arquivo.
let localKit = null;   // { ttlText, files: Map<path,blob URL> }

let photoMarkers   = [];
// Declarado cedo (não na seção de clipes) porque relaxPhotoMarkers o lê,
// e essa função pode rodar via applyPhotoAnim/zoomend antes da seção de
// clipes inicializar — let na TDZ jogava ReferenceError.
let clipsMarkers   = [];
let photosLoaded   = false;
let photosLoading  = null;
let photosVisible  = false;
let photosOpacity  = 1;
// Quando setado ({date, label}), só as fotos daquele pedal ficam visíveis.
let photoRideFilter = null;
// Janela de data herdada do filtro da sidebar — {from, to} em ms, ou null.
// Quando setada, fotos cujo datetime cai fora da janela ficam ocultas.
let photoDateWindow = null;
// Conteúdo bruto da última .ttl carregada (para o "Baixar .ttl").
let lastTtlText  = '';
let lastTtlOrigin = '';   // URL / nome de arquivo de origem (para debug + status)
// Catálogos derivados do TTL: tours[iri]={title,date}, persons[iri]={name}.
let tourCatalog   = new Map();
let personCatalog = new Map();

// Delegação de clique nos popups de foto: link no Passeio abre o modal da
// rota correspondente (mesma janela que a barra lateral usa).
document.addEventListener('click', (ev) => {
  const a = ev.target.closest?.('.photo-popup a.ride-link[data-route-id]');
  if (a) {
    ev.preventDefault();
    const id = a.getAttribute('data-route-id');
    if (id && typeof openRouteModal === 'function') openRouteModal(id);
    return;
  }
  // Botão "Excluir" no popup: chama o backend e recarrega a camada.
  const del = ev.target.closest?.('.photo-popup button.photo-del[data-phash]');
  if (del) {
    ev.preventDefault();
    const phash = del.getAttribute('data-phash');
    if (!phash) return;
    if (!confirm('Excluir esta imagem? Remove arquivos + triples no servidor.')) return;
    del.disabled = true; del.textContent = 'Excluindo…';
    fetch(`./delete-image/${encodeURIComponent(phash)}`, { method: 'POST' })
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.text().catch(() => '');
          throw new Error(`HTTP ${r.status}${body ? ` — ${body.slice(0, 200)}` : ''}`);
        }
        showToast('Imagem excluída.');
        map.closePopup();
        reloadPhotos();
      })
      .catch((err) => {
        del.disabled = false; del.textContent = 'Excluir ✕';
        alert(`Falha ao excluir: ${err.message}`);
      });
    return;
  }
  // Botão "Excluir" no popup de vídeo: POST /delete-video/<vhash>.
  const delV = ev.target.closest?.('.photo-popup button.video-del[data-vhash]');
  if (delV) {
    ev.preventDefault();
    const vhash = delV.getAttribute('data-vhash');
    if (!vhash) return;
    if (!confirm('Excluir este vídeo? Remove arquivos webm/mp4/audio/thumb + triples no servidor.')) return;
    delV.disabled = true; delV.textContent = 'Excluindo…';
    fetch(`./delete-video/${encodeURIComponent(vhash)}`, { method: 'POST' })
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.text().catch(() => '');
          throw new Error(`HTTP ${r.status}${body ? ` — ${body.slice(0, 200)}` : ''}`);
        }
        showToast('Vídeo excluído.');
        map.closePopup();
        // Recarrega o catálogo de clipes do zero pra refletir.
        clipsCatalog = null;
        loadClipsCatalog().then((clips) => makeClipMarkers(clips));
      })
      .catch((err) => {
        delV.disabled = false; delV.textContent = 'Excluir ✕';
        alert(`Falha ao excluir: ${err.message}`);
      });
  }
});

// Marcadores de foto de um pedal específico (data ISO AAAA-MM-DD).
function ridePhotos(date) {
  return photoMarkers.filter(
    (m) => m._photo.ride && m._photo.ride.date === date,
  );
}

// Clipes do mesmo passeio — match por:
//  (a) tourIri direto se o TTL declara ph:capturedDuring (uploads via form), OU
//  (b) fallback: dcterms:date do clipe igual à data do passeio (clipes
//      importados de raw/ via build-clips.py não têm ph:capturedDuring).
function rideClips(date, tourIri) {
  if (!clipsMarkers.length) return [];
  return clipsMarkers.filter(({ clip }) => {
    if (tourIri && clip.tourIri === tourIri) return true;
    return Boolean(clip.date && clip.date === date);
  });
}

// ── Marcador de foto: círculo, ou cone de visada quando há bússola ───────
const CARDINALS = ['N', 'NE', 'L', 'SE', 'S', 'SO', 'O', 'NO'];
function cardinal(deg) {
  return CARDINALS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

// Caminho SVG de um setor (cone) com vértice em (cx,cy), abrindo `fov` graus
// em torno do rumo `bearing` (0 = norte = para cima).
function conePath(cx, cy, r, bearing, fov) {
  const a1 = ((bearing - fov / 2) * Math.PI) / 180;
  const a2 = ((bearing + fov / 2) * Math.PI) / 180;
  const x1 = (cx + r * Math.sin(a1)).toFixed(1);
  const y1 = (cy - r * Math.cos(a1)).toFixed(1);
  const x2 = (cx + r * Math.sin(a2)).toFixed(1);
  const y2 = (cy - r * Math.cos(a2)).toFixed(1);
  const largeArc = fov > 180 ? 1 : 0;
  return `M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${largeArc} 1 ${x2},${y2} Z`;
}

// Deriva rumo + campo de visão dos metadados EXIF (saída do exifr).
function cameraFromExif(meta) {
  let bearing = null;
  let fov = null;
  const dir = meta && meta.GPSImgDirection;
  if (Number.isFinite(dir)) bearing = ((dir % 360) + 360) % 360;
  const f35 = meta && meta.FocalLengthIn35mmFilm;
  if (Number.isFinite(f35) && f35 > 0) {
    const portrait = [5, 6, 7, 8].includes(meta.Orientation);
    const frame = portrait ? 24 : 36;
    fov = (2 * Math.atan(frame / (2 * f35)) * 180) / Math.PI;
  }
  return { bearing, fov };
}

// divIcon da foto. Com bússola → cone translúcido + thumbnail no vértice;
// sem bússola → o círculo simples.
function photoDivIcon(thumbUrl, bearing, fov, extraClass, largeUrl) {
  const dotClass = 'photo-dot' + (extraClass ? ' ' + extraClass : '');
  // image-set: navegadores em telas HiDPI (devicePixelRatio >= 2) pegam o
  // large (~2400px) em vez do thumb (~256px), eliminando o borrão de
  // upscaling durante a animação (peak ~150px CSS = 300 device-pixels em 2x).
  // Em telas 1x a banda fica preservada (só thumb baixa).
  const url1x = thumbUrl;
  const url2x = largeUrl || thumbUrl;
  // Ordem: fallback primeiro, image-set depois — navegadores aceitam o
  // último declaração válida; quem não entende image-set fica com url() simples.
  const bg =
    `background-image: url('${url1x}'); ` +
    `background-image: -webkit-image-set(url('${url1x}') 1x, url('${url2x}') 2x); ` +
    `background-image: image-set(url('${url1x}') 1x, url('${url2x}') 2x);`;
  const dot = `<div class="${dotClass}" style="${bg}"></div>`;
  // Cone só aparece quando: EXIF traz `bearing` E o usuário não desligou
  // em Ajustes. Sem cone, cai pro ícone redondo padrão.
  const wantCone = Number.isFinite(bearing) && settings.fovCone?.enabled !== false;
  if (!wantCone) {
    return L.divIcon({
      className: 'photo-dot-wrap',
      html: dot,
      iconSize: [40, 40],
      iconAnchor: [20, 20],
      popupAnchor: [0, -20],
    });
  }
  const SZ = 120;
  const C = SZ / 2;
  const f = Number.isFinite(fov) ? Math.max(10, Math.min(170, fov)) : 70;
  const scale = Number.isFinite(settings.fovCone?.sizeScale)
    ? Math.max(0.25, Math.min(2, settings.fovCone.sizeScale)) : 1;
  const r = 38 * scale;
  return L.divIcon({
    className: 'photo-dot-wrap',
    html:
      `<div class="photo-aim" style="width:${SZ}px;height:${SZ}px">` +
      `<svg width="${SZ}" height="${SZ}" viewBox="0 0 ${SZ} ${SZ}">` +
      `<path d="${conePath(C, C, r, bearing, f)}" class="photo-cone"/>` +
      `</svg>${dot}</div>`,
    iconSize: [SZ, SZ],
    iconAnchor: [C, C],
    popupAnchor: [0, -C],
  });
}

// Encolhe os círculos/cones de foto fora do zoom 16+ via custom property
// CSS (--photo-scale). 2/3 a cada tick a partir do 15.
function updatePhotoScale() {
  const reductions = Math.max(0, 12 - map.getZoom());
  const scale = Math.pow(2 / 3, reductions);
  document.body.style.setProperty('--photo-scale', scale.toFixed(3));
}

// Encolhe + nudge por densidade local: marcadores em vizinhanças com muitas
// fotos ficam menores (1/sqrt(1+n), piso 0.4) e se afastam uns dos outros
// (deslocamento em px, capado em ~1 raio do dot). Custom properties por ícone:
//   --photo-density-scale  multiplica --photo-scale
//   --photo-dx / --photo-dy  translação CSS sem mexer no LatLng real
const PHOTO_BASE_RADIUS = 20;   // metade do diâmetro nominal do .photo-dot (40px)
const PHOTO_RELAX_ITERS = 8;

// Piso da escala por densidade dependente do zoom — todos os parâmetros
// vêm de settings.markerLayout (configuráveis no modal de Configurações).
function photoMinScaleForZoom(z) {
  const { minScaleFloor, minScaleCeil, rampStart, rampEnd } = settings.markerLayout;
  const span = Math.max(0.0001, rampEnd - rampStart);
  const t = (z - rampStart) / span;
  const ramp = minScaleFloor + (minScaleCeil - minScaleFloor) * t;
  return Math.max(minScaleFloor, Math.min(minScaleCeil, ramp));
}

function relaxPhotoMarkers() {
  const zoomScale = parseFloat(
    document.body.style.getPropertyValue('--photo-scale')) || 1;
  const bounds = map.getBounds();
  const items = [];
  // Combina fotos + clipes na mesma relaxação: vídeos clusterizam com
  // imagens (encolhem + se afastam por densidade local). NÃO ganham
  // `_spotIntensity`, então o boost da animação não os afeta.
  const allMarkers = [];
  for (const m of photoMarkers) allMarkers.push(m);
  for (const { marker } of clipsMarkers) allMarkers.push(marker);
  for (const m of allMarkers) {
    if (!m._icon) continue;                     // ainda não adicionado ao mapa
    if (!bounds.contains(m.getLatLng())) {
      // Limpa override em quem caiu da viewport, evita herdar valor stale.
      m._icon.style.removeProperty('--photo-density-scale');
      m._icon.style.removeProperty('--photo-dx');
      m._icon.style.removeProperty('--photo-dy');
      continue;
    }
    const pt = map.latLngToContainerPoint(m.getLatLng());
    items.push({ marker: m, x: pt.x, y: pt.y, dx: 0, dy: 0, scale: 1 });
  }

  const baseR = PHOTO_BASE_RADIUS * zoomScale;
  const neighborWindow2 = (2 * baseR) ** 2;
  const minScale = photoMinScaleForZoom(map.getZoom());

  // 1) escala por densidade local
  for (const a of items) {
    let n = 0;
    for (const b of items) {
      if (a === b) continue;
      const dx = a.x - b.x, dy = a.y - b.y;
      if (dx * dx + dy * dy < neighborWindow2) n++;
    }
    a.scale = Math.max(minScale, 1 / Math.sqrt(1 + n));
    // 1.1) spotlight contínuo: intensidade por marcador (0..1, atualizada
    // pelo loop em photoSpotlightTick) modula um boost no scale. Raio
    // efetivo cresce junto, então a relaxação empurra vizinhos suavemente.
    const intensity = a.marker._spotIntensity || 0;
    a.scale *= 1 + (settings.spotlight.boost - 1) * intensity;
  }

  // 1.5) pré-dispersão de fotos exatamente co-localizadas (mesmo GPS).
  // Sem isto, dist=0 entre pares "duplicados" zera a força de repulsão e elas
  // ficam empilhadas — só a de cima recebe clique, as de baixo ficam inacessíveis.
  const groups = new Map();
  for (const item of items) {
    const key = Math.round(item.x) + ',' + Math.round(item.y);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (let k = 0; k < group.length; k++) {
      const angle = (k / group.length) * Math.PI * 2;
      group[k].dx = Math.cos(angle) * baseR;
      group[k].dy = Math.sin(angle) * baseR;
    }
  }

  // 2) relaxação iterativa: empurra pares que ainda colidem; cap maior para
  //    grupos co-localizados (até 2 raios) para deixar espaço para espalhar.
  const maxJitter = baseR * 2;
  for (let iter = 0; iter < PHOTO_RELAX_ITERS; iter++) {
    let moved = false;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        const ra = baseR * a.scale, rb = baseR * b.scale;
        const minDist = ra + rb;
        const dx = (b.x + b.dx) - (a.x + a.dx);
        const dy = (b.y + b.dy) - (a.y + a.dy);
        const dist = Math.hypot(dx, dy);
        if (dist < minDist && dist > 1e-3) {
          const push = (minDist - dist) / 2;
          const nx = dx / dist, ny = dy / dist;
          a.dx -= nx * push; a.dy -= ny * push;
          b.dx += nx * push; b.dy += ny * push;
          a.dx = Math.max(-maxJitter, Math.min(maxJitter, a.dx));
          a.dy = Math.max(-maxJitter, Math.min(maxJitter, a.dy));
          b.dx = Math.max(-maxJitter, Math.min(maxJitter, b.dx));
          b.dy = Math.max(-maxJitter, Math.min(maxJitter, b.dy));
          moved = true;
        }
      }
    }
    if (!moved) break;
  }

  // 3) commit nas custom properties do ícone
  for (const a of items) {
    const el = a.marker._icon;
    el.style.setProperty('--photo-density-scale', a.scale.toFixed(3));
    el.style.setProperty('--photo-dx', a.dx.toFixed(1) + 'px');
    el.style.setProperty('--photo-dy', a.dy.toFixed(1) + 'px');
  }
}

function refreshPhotoLayout() {
  updatePhotoScale();
  relaxPhotoMarkers();
}
map.on('zoomend moveend', refreshPhotoLayout);
updatePhotoScale();

// ── Spotlight contínuo ───────────────────────────────────────────────────
// Cada marcador tem uma fase φ ∈ [0,1) constante; ao longo do tempo, sua
// intensidade segue um pulso gaussiano periódico. As fases são distribuídas
// aleatoriamente, então em qualquer instante alguns marcadores estão perto
// do pico (boost ~ settings.spotlight.boost) e outros em repouso. O loop atualiza
// _spotIntensity e re-chama relaxPhotoMarkers, que ajusta tamanhos e nudges
// — as transições CSS suavizam tudo. Pausa durante pan pra não brigar com
// o gesto.
// Todos os tunables vivem em settings.spotlight (modal de Configurações).

let photoSpotlightPaused = false;
map.on('movestart', () => { photoSpotlightPaused = true; });
map.on('moveend',   () => { photoSpotlightPaused = false; });

function photoSpotlightTick() {
  if (photoSpotlightPaused) return;
  const bounds = map.getBounds();
  const visible = [];
  for (const m of photoMarkers) {
    if (!m._icon) continue;
    if (!bounds.contains(m.getLatLng())) {
      m._spotIntensity = 0;
      continue;
    }
    // Atribui fase preguiçosa na primeira visita.
    if (m._spotPhase === undefined) m._spotPhase = Math.random();
    visible.push(m);
  }
  if (visible.length === 0) return;

  const sp = settings.spotlight;
  // Período derivado: cada pico dura ≈peakSec, e queremos ~peakCount ativos.
  const period = Math.max(
    sp.peakSec,
    visible.length * sp.peakSec / Math.max(0.001, sp.peakCount));
  const peakFrac = Math.min(0.5, sp.peakSec / period);
  const halfWidth = peakFrac / 2;

  const t = performance.now() / 1000 / period;
  for (const m of visible) {
    const x = ((t + m._spotPhase) % 1 + 1) % 1;     // posição na onda [0,1)
    const d = Math.min(x, 1 - x);                    // distância circular ao pico
    const main = Math.exp(-Math.pow(d / halfWidth, sp.pulseShape));
    const xEcho = ((x - sp.echoOffset) % 1 + 1) % 1;
    const dEcho = Math.min(xEcho, 1 - xEcho);
    const echo = sp.echoAmp *
      Math.exp(-Math.pow(dEcho / halfWidth, sp.pulseShape));
    m._spotIntensity = Math.max(main, echo);
  }
  relaxPhotoMarkers();
}

// Toggle persistente no topbar ✨ + interruptor pro modal de Configurações.
// Quando desliga: para o timer, zera intensidades e re-relaxa pra que os
// marcadores voltem ao tamanho/posição que a relaxação por densidade definiria.
let photoSpotlightTimer = null;

function applyPhotoAnim() {
  if (settings.spotlight.enabled) {
    if (!photoSpotlightTimer) {
      photoSpotlightTimer = setInterval(photoSpotlightTick, settings.spotlight.tickMs);
    }
  } else {
    if (photoSpotlightTimer) {
      clearInterval(photoSpotlightTimer);
      photoSpotlightTimer = null;
    }
    for (const m of photoMarkers) m._spotIntensity = 0;
    relaxPhotoMarkers();
  }
  // Mantém o botão visual sincronizado.
  const btn = document.getElementById('photo-anim-btn');
  if (btn) btn.setAttribute('aria-pressed', String(settings.spotlight.enabled));
}

const photoAnimBtn = document.getElementById('photo-anim-btn');
if (photoAnimBtn) {
  // Animação liga/desliga TUDO: o spotlight (animação dos marcadores) e o
  // ghost video (clipes em loop como pano de fundo translúcido sobre o mapa).
  photoAnimBtn.setAttribute('aria-pressed', String(settings.spotlight.enabled));
  photoAnimBtn.addEventListener('click', async () => {
    const enabling = !settings.spotlight.enabled;
    settings.spotlight.enabled = enabling;
    saveSettings();
    applyPhotoAnim();
    photoAnimBtn.setAttribute('aria-pressed', String(enabling));
    if (enabling) await startClipsGhost();
    else stopClipsGhost();
  });
}
applyPhotoAnim();

// ── Clips: ghost backdrop ─────────────────────────────────────────────────
// Catálogo de clipes vive em `web/data/uploads.ttl` (ph:Video). Os arquivos
// transcodados ficam em `web/clips/`. Quando Animação está ligada, um
// `<video>` sobre o mapa toca segmentos aleatórios de 5s de cada clipe em
// laço, com áudio. O mapa não move; só os marcadores de cada clipe acendem
// quando seu vídeo está no ar.
const CLIPS_DIR = './clips/';
// Duração do segmento e do fade são lidos do `settings.clipsGhost` em tempo
// real — assim mudanças nos sliders de Ajustes pegam efeito no próximo clipe.
function clipSegmentS()   { return Math.max(2, settings.clipsGhost?.segmentSec ?? 10); }
function clipFadeS()      { return Math.max(0.1, Math.min(settings.clipsGhost?.fadeSec ?? 2, clipSegmentS() / 2)); }
function clipAudioFadeS() {
  // Áudio pode ser MAIOR que vídeo (até metade do segmento), mas nunca
  // menor — pra dar a impressão de fade sonoro mais suave que o visual.
  const desired = settings.clipsGhost?.audioFadeSec ?? 4;
  return Math.max(clipFadeS(), Math.min(desired, clipSegmentS() / 2));
}
let clipsCatalog = null;          // [{file, lat, lng, duration, ...}]
// clipsMarkers declarado cedo, perto de photoMarkers — ver comentário lá.
let clipsAdvanceTimer = null;
let clipsAudioOutTimer = null;
let clipsCurrentIndex = -1;
let clipsGhostVideo  = null;      // <video> element, criado preguiçosamente
// Valor inicial vem do `defaultPct` da entrada `clips-ghost` no OVERLAY_LAYERS
// — uma única fonte de verdade pro fade-in do primeiro clipe e pra posição
// inicial do slider do painel Camadas.
let clipsGhostUserOpacity = (
  (OVERLAY_LAYERS.find((l) => l.id === 'clips-ghost')?.defaultPct ?? 70) / 100
);

function setClipsGhostOpacity(frac) {
  if (clipsGhostVideo) clipsGhostVideo.style.opacity = String(frac);
}

function ensureClipsGhostVideo() {
  if (clipsGhostVideo) return clipsGhostVideo;
  const v = document.createElement('video');
  v.id = 'clips-ghost-video';
  v.className = 'clips-ghost-video';
  v.playsInline = true;
  v.preload = 'auto';
  v.loop = false;   // o avanço é controlado por advanceClip(), não loop nativo
  v.hidden = true;
  v.style.opacity = '0';
  v.volume = 0;
  // No `.leaflet-container` (sibling do `.leaflet-map-pane`). Não tentamos
  // mais empilhar com z-index entre tiles e markers porque o map-pane do
  // Leaflet cria seu próprio stacking context (transform), o que torna
  // impossível inserir um irmão entre suas panes internas. Trade-off
  // aceito: vídeo fica por cima de tudo, mas os marcadores (anel branco
  // grosso pulsando até 20×) atravessam visualmente o vídeo translúcido.
  map.getContainer().appendChild(v);
  // Salva-vidas pro loop infinito: se o clipe terminar antes do timer
  // (mais curto que o segmento), avança na hora. Se der erro de mídia,
  // também avança em vez de parar.
  // Só avança se Animação E o vídeo fantasma ainda estiverem ligados —
  // evita que um `ended`/`error` atrasado relance um clipe depois que o
  // usuário desativou o ghost via Camadas/Ajustes.
  const wantAdvance = () => settings.spotlight?.enabled && settings.clipsGhost?.enabled !== false;
  v.addEventListener('ended', () => { if (wantAdvance()) advanceClip(); });
  v.addEventListener('error', () => { if (wantAdvance()) advanceClip(); });
  clipsGhostVideo = v;
  return v;
}

// ── Audio intensity → pulso do marker do clipe ────────────────────────────
// Plugamos o <video> num AudioContext via MediaElementSource e medimos o
// RMS do sinal a cada frame. O valor (0..1) vira CSS custom property no
// marker ativo (`--clip-intensity`), que escala o círculo laranja.
let clipsAudioCtx = null;
let clipsAnalyser = null;
let clipsAudioBuf = null;
let clipsAudioRaf = null;

function ensureClipsAudioGraph(video) {
  if (clipsAnalyser) return clipsAnalyser;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    clipsAudioCtx = new AC();
    const src = clipsAudioCtx.createMediaElementSource(video);
    clipsAnalyser = clipsAudioCtx.createAnalyser();
    clipsAnalyser.fftSize = 256;
    clipsAnalyser.smoothingTimeConstant = 0.5;
    clipsAudioBuf = new Uint8Array(clipsAnalyser.fftSize);
    // Em série: source → analyser → destination. Sem o destination o vídeo
    // ficaria mudo (MediaElementSource desconecta o output direto do elemento).
    src.connect(clipsAnalyser);
    clipsAnalyser.connect(clipsAudioCtx.destination);
  } catch (err) {
    console.warn('[clips audio] init falhou:', err.message);
    return null;
  }
  return clipsAnalyser;
}

function setActiveMarkerIntensity(level) {
  if (clipsCurrentIndex < 0) return;
  const m = clipsMarkers[clipsCurrentIndex];
  if (!m) return;
  const dot = m.marker.getElement()?.querySelector('.clip-marker');
  if (dot) dot.style.setProperty('--clip-intensity', level.toFixed(3));
}

function startClipsIntensityLoop() {
  if (clipsAudioRaf || !clipsAnalyser) return;
  const tick = () => {
    if (!clipsAnalyser) { clipsAudioRaf = null; return; }
    clipsAnalyser.getByteTimeDomainData(clipsAudioBuf);
    // RMS amplitude do sinal (centrado em 128).
    let sum = 0;
    for (let i = 0; i < clipsAudioBuf.length; i++) {
      const x = (clipsAudioBuf[i] - 128) / 128;
      sum += x * x;
    }
    const rms = Math.sqrt(sum / clipsAudioBuf.length);
    // Voz típica fica ~0.1-0.3 RMS; multiplica pra esticar a faixa visual.
    const gain = settings.clipMarker?.intensityGain ?? 4;
    const level = Math.min(1, rms * gain);
    setActiveMarkerIntensity(level);
    clipsAudioRaf = requestAnimationFrame(tick);
  };
  clipsAudioRaf = requestAnimationFrame(tick);
}

function stopClipsIntensityLoop() {
  if (clipsAudioRaf) cancelAnimationFrame(clipsAudioRaf);
  clipsAudioRaf = null;
  setActiveMarkerIntensity(0);
}

// Rampas independentes pra opacidade do vídeo e pro volume do áudio.
// Separar permite que o fade sonoro seja mais longo que o visual (a
// transição auditiva fica perceptualmente mais suave). Cada uma cancela
// a anterior do mesmo tipo se chamada de novo.
let clipsOpacityRaf = null;
let clipsVolumeRaf  = null;
function fadeProp(v, prop, target, durationMs, rafSlot) {
  if (rafSlot.id) cancelAnimationFrame(rafSlot.id);
  return new Promise((resolve) => {
    const startVal = prop === 'opacity'
      ? (parseFloat(v.style.opacity) || 0)
      : v.volume;
    const t0 = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - t0) / durationMs);
      const val = startVal + (target - startVal) * t;
      if (prop === 'opacity') v.style.opacity = String(val);
      else v.volume = Math.max(0, Math.min(1, val));
      if (t < 1) rafSlot.id = requestAnimationFrame(step);
      else { rafSlot.id = null; resolve(); }
    };
    rafSlot.id = requestAnimationFrame(step);
  });
}
const _opacitySlot = { id: null };
const _volumeSlot  = { id: null };
function fadeClipOpacity(v, target, durationMs) { return fadeProp(v, 'opacity', target, durationMs, _opacitySlot); }
function fadeClipVolume(v, target, durationMs)  { return fadeProp(v, 'volume',  target, durationMs, _volumeSlot); }

async function loadClipsCatalog() {
  if (clipsCatalog) return clipsCatalog;
  // Fonte única: ph:Video em web/data/uploads.ttl. Clipes processados por
  // scripts/build-clips.py vivem em web/clips/ — o próprio build-clips.py
  // escreve as triples no uploads.ttl com autoria/licença default.
  try {
    clipsCatalog = await loadClipsFromUploadsTtl();
  } catch (err) {
    console.warn('[clips] falha ao carregar vídeos de uploads.ttl:', err.message);
    clipsCatalog = [];
  }
  return clipsCatalog;
}

// Lê `web/data/uploads.ttl` e extrai ph:Video → entradas no formato
// {file, file720, audio, thumb, lat, lng, duration, datetime, vhash, …}.
// Arquivos vivem em `web/clips/<id>.{360p.mp4,720p.mp4,audio.webm,thumb.jpg}`
// (clipes locais de build-clips.py usam stem original; uploads do form
// usam o vhash de 16 hex). Quando o vídeo é audio-only, ph:video360p/720p
// ficam ausentes — o app renderiza só como fonte sonora (audio loop), não
// como ghost-video no mapa.
async function loadClipsFromUploadsTtl() {
  const res = await fetch('./data/uploads.ttl', { cache: 'no-cache' });
  if (!res.ok) return [];
  const text = await res.text();
  if (!text.trim()) return [];
  await ensureN3();
  return new Promise((resolve) => {
    const parser = new window.N3.Parser({ format: 'text/turtle' });
    const PH_ = 'https://pedalhidrografi.co/terms#';
    const SCHEMA_ = 'https://schema.org/';
    const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
    const subs = new Map();
    const geos = new Map();
    parser.parse(text, (err, quad, done) => {
      if (err) { console.warn('[uploads-video] parse:', err.message); resolve([]); return; }
      if (done) {
        const clips = [];
        for (const [_s, props] of subs) {
          if (props.type !== PH_ + 'Video') continue;
          const geo = props.locationCreated ? geos.get(props.locationCreated) : null;
          if (!geo || !Number.isFinite(geo.lat) || !Number.isFinite(geo.lng)) continue;
          // Sem áudio = não tem o que tocar; ignora.
          if (!props.audio) continue;
          // Paths relativos a ./clips/ (sem prefixo) — playClipAt() e o
          // popup builder prepende CLIPS_DIR antes de usar.
          const file360 = props.video360p;
          const file720 = props.video720p;
          const audio   = props.audio;
          const file    = file360 || file720 || audio;
          let duration = null;
          if (props.duration) {
            const m = /^PT([\d.]+)S$/.exec(props.duration);
            if (m) duration = parseFloat(m[1]);
          }
          // Date como YYYY-MM-DD pra bater com `ride.date` das fotos no
          // gallery de passeio. Vem do dcterms:date (xsd:dateTime ISO 8601).
          // `datetime` preserva a string completa pro popup ("Quando?").
          const date = props.dateXsd ? props.dateXsd.slice(0, 10) : null;
          clips.push({
            iri: _s,
            vhash: _s.startsWith('https://pedalhidrografi.co/data/video_')
                   ? _s.slice('https://pedalhidrografi.co/data/video_'.length)
                   : null,
            file,
            file720: file720 || file360 || audio,
            audio,
            thumb: props.thumbnail || null,
            lat: geo.lat,
            lng: geo.lng,
            duration,
            date,
            datetime: props.dateXsd || null,
            tourIri: props.capturedDuring,
            license: props.license,
            audioOnly: !file360 && !file720,
          });
        }
        resolve(clips);
        return;
      }
      const s = quad.subject.value;
      const p = quad.predicate.value;
      const o = quad.object;
      const sub = subs.get(s) || {};
      if (p === RDF_TYPE) sub.type = o.value;
      else if (p === SCHEMA_ + 'latitude')   { const g = geos.get(s) || {}; g.lat = parseFloat(o.value); geos.set(s, g); }
      else if (p === SCHEMA_ + 'longitude')  { const g = geos.get(s) || {}; g.lng = parseFloat(o.value); geos.set(s, g); }
      else if (p === SCHEMA_ + 'duration')       sub.duration = o.value;
      else if (p === 'http://purl.org/dc/terms/license') sub.license = o.value;
      else if (p === SCHEMA_ + 'locationCreated') sub.locationCreated = o.value;
      else if (p === PH_ + 'capturedDuring')     sub.capturedDuring = o.value;
      else if (p === PH_ + 'video360p')          sub.video360p = o.value;
      else if (p === PH_ + 'video720p')          sub.video720p = o.value;
      else if (p === PH_ + 'audio')              sub.audio = o.value;
      else if (p === SCHEMA_ + 'thumbnail')      sub.thumbnail = o.value;
      else if (p === 'http://purl.org/dc/terms/date') sub.dateXsd = o.value;
      subs.set(s, sub);
    });
  });
}

// Render do popup de clipe — chamado lazy no popupopen pra ver `tourCatalog`
// (que é populado pelo loadPhotos, em paralelo com loadClipsCatalog no boot).
function renderClipPopupHtml(c) {
  const dur = Number.isFinite(c.duration) ? `${c.duration.toFixed(1)} s` : '—';
  const whenHuman = c.datetime
    ? new Date(c.datetime).toLocaleString('pt-BR', { dateStyle: 'medium', timeStyle: 'short' })
    : '—';
  // Mesmo render do Passeio do popup de foto: "CODE: Title" (ex.: "PH 92:
  // Crista do Lauzane…"), com link `.ride-link` que abre o modal da rota
  // na sidebar (delegação já existe pra .photo-popup a.ride-link).
  let tourHtml = '—';
  if (c.tourIri) {
    const t = tourCatalog?.get(c.tourIri);
    const label = t
      ? ((t.code && t.title) ? `${t.code}: ${t.title}`
         : (t.code || t.title || t.date || c.tourIri))
      : c.tourIri;
    tourHtml = `<a href="#" class="ride-link" data-route-id="${escapeHtml(c.tourIri)}">${escapeHtml(label)}</a>`;
  }
  const licShort = c.license
    ? (c.license.match(/licenses\/([a-z-]+)\/(\d+\.\d+)/i)?.slice(1).join(' ').toUpperCase()
       || c.license.match(/zero\/(\d+\.\d+)/i)?.[1]?.replace(/^/, 'CC0 ')
       || c.license)
    : null;
  const license = c.license
    ? `<a href="${escapeHtml(c.license)}" target="_blank" rel="noopener">${escapeHtml(licShort)}</a>`
    : '—';
  const delBtn = c.vhash
    ? `<button type="button" class="photo-del video-del" data-vhash="${escapeHtml(c.vhash)}">Excluir ✕</button>`
    : '';
  const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
  const videoSrc = c.file  ? CLIPS_DIR + enc(c.file)  : '';
  const v720Src  = c.file720 && c.file720 !== c.file ? CLIPS_DIR + enc(c.file720) : '';
  const audioSrc = c.audio ? CLIPS_DIR + enc(c.audio) : '';
  // `playsinline` é essencial em iOS Safari — sem ele, tap em ▶ tenta
  // entrar em fullscreen e dentro de popup falha silenciosamente. O
  // `webkit-playsinline` cobre iOS antigos pra garantia.
  const playerHtml = c.audioOnly
    ? (audioSrc ? `<audio controls preload="metadata" src="${audioSrc}"></audio>` : '')
    : (videoSrc ? `<video controls playsinline webkit-playsinline preload="metadata" src="${videoSrc}"></video>` : '');
  const dlChips = [];
  if (videoSrc) dlChips.push(`<a class="photo-dl" href="${videoSrc}" download="${escapeHtml(c.file)}">Vídeo 360p ↓</a>`);
  if (v720Src)  dlChips.push(`<a class="photo-dl" href="${v720Src}"  download="${escapeHtml(c.file720)}">Vídeo 720p ↓</a>`);
  if (audioSrc) dlChips.push(`<a class="photo-dl" href="${audioSrc}" download="${escapeHtml((c.audio || '').split('/').pop())}">Áudio ↓</a>`);
  const actions = [...dlChips, delBtn].filter(Boolean).join('');
  return (
    `<div class="photo-popup video-popup">` +
      playerHtml +
      `<dl class="photo-details">` +
        `<dt>Quando</dt><dd>${whenHuman}</dd>` +
        `<dt>Duração</dt><dd>${dur}</dd>` +
        `<dt>Passeio</dt><dd>${tourHtml}</dd>` +
        `<dt>Licença</dt><dd>${license}</dd>` +
        (c.vhash ? `<dt>vHash</dt><dd><code>${escapeHtml(c.vhash)}</code></dd>` : '') +
      `</dl>` +
      (actions ? `<div class="photo-actions">${actions}</div>` : '') +
    `</div>`
  );
}

function makeClipMarkers(clips) {
  // Pane dedicado pra clipes — z-index acima do markerPane (600) faz com
  // que os anéis pulsando fiquem ACIMA das fotos quando se sobrepõem.
  if (!map.getPane('clipMarkers')) {
    const pane = map.createPane('clipMarkers');
    pane.style.zIndex = '650';
  }
  for (const { marker } of clipsMarkers) map.removeLayer(marker);
  clipsMarkers = [];
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    if (!Number.isFinite(c.lat) || !Number.isFinite(c.lng)) continue;
    // Marker: círculo estilo foto com o thumb do clipe + borda red-orange.
    // O `.clip-marker` overlay continua escondido até a animação ativar,
    // quando ganha `.active` e pulsa em cima do dot.
    const thumbUrl = c.thumb ? CLIPS_DIR + c.thumb : '';
    const bg = thumbUrl
      ? `background-image: url('${thumbUrl}'); background-size: cover; background-position: center;`
      : 'background-color: rgba(255,87,34,0.35);';
    const icon = L.divIcon({
      className: 'photo-dot-wrap',
      html:
        `<div class="photo-dot photo-dot-video" style="${bg}"></div>` +
        `<div class="clip-marker"></div>`,
      iconSize: [40, 40],
      iconAnchor: [20, 20],
      popupAnchor: [0, -20],
    });
    const m = L.marker([c.lat, c.lng], { icon, interactive: true, pane: 'clipMarkers' });
    m._clip = c;
    // Popup gerado lazy via callback — `tourCatalog` pode ainda não ter
    // sido populado pelo loadPhotos() quando o marker é criado (boot race
    // entre loadClipsCatalog e loadPhotos). Adiando até o popupopen, o
    // lookup do tour title vê dados frescos.
    m.bindPopup(() => renderClipPopupHtml(c),
      { maxWidth: 440, className: 'photo-popup-wrap', autoPan: false });
    // Durante a Animação, o clique no marker dispara o ghost-video player
    // (mesma UX antiga). Fora da Animação, abre o popup normal.
    m.on('click', () => {
      if (settings.spotlight?.enabled && !c.audioOnly) {
        playClipAt(i);
      } else {
        m.openPopup();
      }
    });
    m.addTo(map);
    clipsMarkers.push({ clip: c, marker: m });
  }
}

function highlightClipMarker(index) {
  for (let i = 0; i < clipsMarkers.length; i++) {
    const dot = clipsMarkers[i].marker.getElement()?.querySelector('.clip-marker');
    if (!dot) continue;
    dot.classList.toggle('active', i === index);
  }
}

function pickNextClipIndex() {
  if (!clipsCatalog || clipsCatalog.length === 0) return -1;
  // O ghost-video player só toca clipes com trilha de vídeo de fato.
  // Clipes `audioOnly` (sem ph:video360p/ph:video720p) vão pro audio loop, não
  // pra ele — ver loadClipsFromUploadsTtl. Filtro idempotente: se nenhum
  // clipe tiver vídeo, devolve -1 (animação simplesmente não roda).
  const videoIndices = [];
  for (let i = 0; i < clipsCatalog.length; i++) {
    if (clipsCatalog[i].audioOnly !== true) videoIndices.push(i);
  }
  if (videoIndices.length === 0) return -1;
  if (videoIndices.length === 1) return videoIndices[0];
  let next;
  let tries = 0;
  do {
    next = videoIndices[Math.floor(Math.random() * videoIndices.length)];
    tries++;
  } while (next === clipsCurrentIndex && tries < 10);
  return next;
}

// Timers dos estados do marker. A cada `playClipAt` limpamos tudo e
// reagendamos: o marker novo entra em intro (verde, 1s), depois branco; o
// marker antigo fica branco por 1s de overlap, vira outro (laranja) por
// mais 1s, e some. Resultado visual:
//   [t=0]    new=intro(verde) + old=white     (2 visíveis, 1 branco)
//   [t=1s]   new=white         + old=outro(laranja) (2 visíveis, 1 branco)
//   [t=2s]   new=white                                 (1 branco)
let clipsIntroTimer = null;
let clipsOldOutroTimer = null;
let clipsOldRemoveTimer = null;
const CLIP_INTRO_OUTRO_MS = 1000;
function clearMarkerStateTimers() {
  if (clipsIntroTimer)     { clearTimeout(clipsIntroTimer);     clipsIntroTimer = null; }
  if (clipsOldOutroTimer)  { clearTimeout(clipsOldOutroTimer);  clipsOldOutroTimer = null; }
  if (clipsOldRemoveTimer) { clearTimeout(clipsOldRemoveTimer); clipsOldRemoveTimer = null; }
}
function getMarkerEl(index) {
  const m = clipsMarkers[index];
  return m ? m.marker.getElement()?.querySelector('.clip-marker') : null;
}

function playClipAt(index) {
  if (!clipsCatalog || index < 0 || index >= clipsCatalog.length) return;
  // Guarda defensiva: marker de clipe audio-only não deve disparar o
  // ghost-video player (que assume trilha de vídeo). O audio loop é
  // quem cuida desses — ver audioLoop* abaixo. Se um audio-only foi
  // clicado durante a Animação, simplesmente avança pro próximo vídeo.
  if (clipsCatalog[index].audioOnly === true) { advanceClip(); return; }
  const v = ensureClipsGhostVideo();
  const c = clipsCatalog[index];
  const prevIndex = clipsCurrentIndex;
  clipsCurrentIndex = index;

  // Handoff dos marcadores: NÃO removemos `.active` do anterior na hora —
  // ele continua branco por mais 1s (sobreposição com o intro do novo),
  // depois vira laranja (outro) por mais 1s, e só então some.
  clearMarkerStateTimers();
  const newDot = getMarkerEl(index);
  if (newDot) {
    newDot.classList.remove('outro');
    newDot.classList.add('active');
    newDot.classList.add('intro');
    clipsIntroTimer = setTimeout(() => {
      const el = getMarkerEl(clipsCurrentIndex);
      if (el) el.classList.remove('intro');
      clipsIntroTimer = null;
    }, CLIP_INTRO_OUTRO_MS);
  }
  if (prevIndex >= 0 && prevIndex !== index) {
    const prevDot = getMarkerEl(prevIndex);
    if (prevDot) {
      // 1s de overlap como branco — depois bolinha laranja por mais 1s.
      clipsOldOutroTimer = setTimeout(() => {
        prevDot.classList.remove('intro');
        prevDot.classList.add('outro');
        clipsOldOutroTimer = null;
      }, CLIP_INTRO_OUTRO_MS);
      clipsOldRemoveTimer = setTimeout(() => {
        prevDot.classList.remove('outro');
        prevDot.classList.remove('active');
        clipsOldRemoveTimer = null;
      }, CLIP_INTRO_OUTRO_MS * 2);
    }
  }

  if (clipsAdvanceTimer)  { clearTimeout(clipsAdvanceTimer);  clipsAdvanceTimer = null; }
  if (clipsAudioOutTimer) { clearTimeout(clipsAudioOutTimer); clipsAudioOutTimer = null; }

  // Escolhe variante 720p se o usuário pediu E o catálogo tem essa versão.
  const wantHd = settings.clipsGhost?.useHd === true;
  const fileName = wantHd && c.file720 ? c.file720 : c.file;
  const src = CLIPS_DIR + encodeURIComponent(fileName);
  if (v.src !== new URL(src, location.href).href) {
    v.src = src;
  }
  v.hidden = false;
  // Começa silencioso/invisível pra encadear o fade-in junto do início do
  // segmento. Se o usuário desligou o painel Camadas → opacity 0, o
  // efeito segue invisível mesmo após o fade.
  v.style.opacity = '0';
  v.volume = 0;

  const startAt = () => {
    const segS = clipSegmentS();
    const fadeS = clipFadeS();
    const audioFadeS = clipAudioFadeS();
    const dur = v.duration;
    const maxStart = Math.max(0, (Number.isFinite(dur) ? dur : c.duration || 0) - segS);
    const start = maxStart > 0 ? Math.random() * maxStart : 0;
    try { v.currentTime = start; } catch {}
    v.play().catch(() => {});
    ensureClipsAudioGraph(v);
    if (clipsAudioCtx && clipsAudioCtx.state === 'suspended') {
      clipsAudioCtx.resume().catch(() => {});
    }
    startClipsIntensityLoop();
    // Fade-in: opacidade no `fadeS`; áudio no `audioFadeS` (mais longo).
    fadeClipOpacity(v, clipsGhostUserOpacity, fadeS * 1000);
    fadeClipVolume(v, 1, audioFadeS * 1000);
    // Fade-out de áudio começa MAIS CEDO que o vídeo (porque é mais longo),
    // mas ambos chegam a zero ~ao mesmo tempo (advance). Rastreamos o timer
    // pra cancelar quando o usuário pula pro próximo clipe — senão ele
    // dispara em cima do `fadeClipVolume(v, 1, ...)` do próximo e mata o
    // fade-in.
    const audioOutDelay = Math.max(0, (segS - audioFadeS) * 1000);
    clipsAudioOutTimer = setTimeout(
      () => fadeClipVolume(v, 0, audioFadeS * 1000),
      audioOutDelay,
    );
    clipsAdvanceTimer = setTimeout(() => {
      fadeClipOpacity(v, 0, fadeS * 1000).then(() => advanceClip());
    }, (segS - fadeS) * 1000);
    // O "outro" do marker é agora agendado pelo PRÓXIMO playClipAt
    // (overlap entre marker antigo e novo), não pelo próprio clipe.
  };
  if (v.readyState >= 1) startAt();
  else v.addEventListener('loadedmetadata', startAt, { once: true });
}

function advanceClip() {
  if (!settings.spotlight.enabled) return;
  const next = pickNextClipIndex();
  if (next >= 0) playClipAt(next);
}

async function startClipsGhost() {
  if (!settings.clipsGhost?.enabled) return;
  await loadClipsCatalog();
  if (!clipsCatalog || clipsCatalog.length === 0) return;
  if (clipsMarkers.length === 0) makeClipMarkers(clipsCatalog);
  const start = pickNextClipIndex();
  if (start >= 0) playClipAt(start);
}

function stopClipsGhost() {
  if (clipsAdvanceTimer)  { clearTimeout(clipsAdvanceTimer);  clipsAdvanceTimer = null; }
  if (clipsAudioOutTimer) { clearTimeout(clipsAudioOutTimer); clipsAudioOutTimer = null; }
  clearMarkerStateTimers();
  if (clipsGhostVideo) {
    try { clipsGhostVideo.pause(); } catch {}
    clipsGhostVideo.hidden = true;
  }
  stopClipsIntensityLoop();
  // Limpa as classes residuais antes de soltar o `.active`.
  for (const { marker } of clipsMarkers) {
    const dot = marker.getElement()?.querySelector('.clip-marker');
    if (dot) { dot.classList.remove('intro'); dot.classList.remove('outro'); }
  }
  highlightClipMarker(-1);
}

// Carrega marcadores na boot pra mostrar onde existem clipes mesmo com
// Animação desligada. (`spotlight.enabled` é forçado pra false no boot,
// então não tentamos auto-iniciar o ghost aqui — fica só na ação do usuário.)
loadClipsCatalog().then((clips) => {
  if (clips && clips.length) makeClipMarkers(clips);
});

// ── Detecção automática do pedal de uma foto ─────────────────────────────
// Usa as rotas já carregadas na barra lateral: casa pela data (chave quase
// única, pedais são semanais) e, na falta, pela proximidade do traçado.
function rideFromEntry(e) {
  const num = e.number;
  return {
    date: e.date || null,
    code: num && num.value ? `${num.source} ${num.value}` : null,
    name: e.name || null,
  };
}
function dateKey(d) {
  return (
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0')
  );
}
function detectRideByDate(dateObj) {
  const cand = [dateKey(dateObj)];
  if (dateObj.getHours() < 6) {
    // foto de madrugada → provavelmente o pedal da véspera
    const prev = new Date(dateObj);
    prev.setDate(prev.getDate() - 1);
    cand.push(dateKey(prev));
  }
  for (const r of routes.values()) {
    if (r.entry.date && cand.includes(r.entry.date)) {
      return rideFromEntry(r.entry);
    }
  }
  return null;
}
function detectRideByGps(lat, lng) {
  const here = L.latLng(lat, lng);
  let best = null;
  let bestD = Infinity;
  for (const r of routes.values()) {
    const lls = r.entry.latlngs;
    if (!lls || !lls.length) continue;
    for (const ll of lls) {
      const d = here.distanceTo(L.latLng(ll[0], ll[1]));
      if (d < bestD) {
        bestD = d;
        best = r.entry;
      }
    }
  }
  return bestD < 250 && best ? rideFromEntry(best) : null;
}
// dateObj: Date local da captura (EXIF). Devolve {date,code,name} ou null.
function detectRide(dateObj, lat, lng) {
  let ride = null;
  if (dateObj instanceof Date && !isNaN(dateObj)) {
    ride = detectRideByDate(dateObj);
  }
  if (!ride && Number.isFinite(lat) && Number.isFinite(lng)) {
    ride = detectRideByGps(lat, lng);
  }
  return ride;
}


// ─── Carregamento do TTL + parsing ────────────────────────────────────────
// N3.js servido localmente em web/lib/n3.min.js (UMD; expõe window.N3).
// Bundled offline para não depender de CDN — alinha com o "local-first".
const N3_URL = './lib/n3.min.js';
let _n3Promise = null;
async function ensureN3() {
  if (!_n3Promise) {
    _n3Promise = (async () => {
      if (!window.N3) await loadScript(N3_URL);
      return window.N3.Parser;
    })();
  }
  return _n3Promise;
}

const PH_NS  = 'https://pedalhidrografi.co/terms#';
const PHD_NS = 'https://pedalhidrografi.co/data/';
const SCHEMA = 'https://schema.org/';
const DCT    = 'http://purl.org/dc/terms/';
const PROV   = 'http://www.w3.org/ns/prov#';
const NFO    = 'http://www.semanticdesktop.org/ontologies/2007/03/22/nfo#';
const EXIF   = 'http://www.w3.org/2003/12/exif/ns#';
const RDFT   = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

// Resolve a URL de uma variante de imagem com base na fonte ativa.
function resolvePhotoUrl(phash, variant /* 'large' | 'thumb' | 'original' */) {
  if (!phash) return '';
  if (localKit) {
    const candidates = variant === 'original'
      ? [`photos/${phash}/original.jpg`, `photos/${phash}/original.png`,
         `photos/${phash}/original.heic`, `photos/${phash}/original.jpeg`]
      : [`photos/${phash}/${variant}.jpg`];
    for (const p of candidates) {
      const u = localKit.files.get(p);
      if (u) return u;
    }
    return '';
  }
  const base = (photoSource === 'cdn') ? PHOTOS_CDN_BASE : './';
  return `${base}${PHOTOS_DIR_REL}${phash}/${variant}.jpg`;
}

// Parse de um texto TTL em quads (lista de triples N3.js).
async function parseTtlToQuads(text) {
  const Parser = await ensureN3();
  return new Parser().parse(text);
}

// Constrói o modelo (tours, persons, photos) a partir de uma lista de quads.
function buildModelFromQuads(quads) {
  const types = new Map(), titles = new Map(), dates = new Map();
  const names = new Map(), elev = new Map();
  const bearings = new Map(), focals = new Map();
  const tours = new Map();
  // Filiação a séries (PH, BP, BT, S...) por meio de Associações:
  //   Tour --ph:inSeriesEdition--> Association --ph:inEventSeries--> EventSeries
  //                                            --ph:sequenceInSeries--> N
  const tourAssocs    = new Map();   // tourIri → Set(assocIri)
  const assocSeries   = new Map();   // assocIri → seriesIri
  const assocSequence = new Map();   // assocIri → integer
  // ph:linkRoute → RouteReference (bn) → schema:url (RWGPS URL).
  const tourRouteRef  = new Map();   // tourIri → bn IRI
  const subjectUrl    = new Map();   // subject IRI/bn → URL string
  const authors = new Map(), provs = new Map();
  const licenses = new Map();
  const locOf = new Map(), locLat = new Map(), locLng = new Map();
  // Activity (ph:Upload) → { startedAt, generated: imageIri }
  const uploadProps    = new Map();
  const uploadByImage  = new Map();   // image IRI → activity props

  for (const q of quads) {
    const s = q.subject.value, p = q.predicate.value, ov = q.object.value;
    if      (p === RDFT) { if (!types.has(s)) types.set(s, new Set()); types.get(s).add(ov); }
    else if (p === DCT + 'title')           titles.set(s, ov);
    else if (p === DCT + 'date')            dates.set(s, ov);
    else if (p === DCT + 'license')         licenses.set(s, ov);
    else if (p === SCHEMA + 'alternateName' || p === SCHEMA + 'name') names.set(s, ov);
    else if (p === SCHEMA + 'latitude')     locLat.set(s, parseFloat(ov));
    else if (p === SCHEMA + 'longitude')    locLng.set(s, parseFloat(ov));
    else if (p === SCHEMA + 'elevation')    elev.set(s, parseFloat(ov));
    else if (p === SCHEMA + 'locationCreated') locOf.set(s, ov);
    else if (p === EXIF + 'gpsImgDirection')   bearings.set(s, parseFloat(ov));
    else if (p === EXIF + 'focalLengthIn35mmFilm') focals.set(s, parseFloat(ov));
    else if (p === PH_NS + 'capturedDuring')   tours.set(s, ov);
    else if (p === PH_NS + 'inSeriesEdition') {
      if (!tourAssocs.has(s)) tourAssocs.set(s, new Set());
      tourAssocs.get(s).add(ov);
    }
    else if (p === PH_NS + 'inEventSeries')    assocSeries.set(s, ov);
    else if (p === PH_NS + 'sequenceInSeries') assocSequence.set(s, parseInt(ov, 10));
    else if (p === PH_NS + 'linkRoute')        tourRouteRef.set(s, ov);
    else if (p === SCHEMA + 'url')             subjectUrl.set(s, ov);
    else if (p === PROV + 'wasAttributedTo') {
      if (!authors.has(s)) authors.set(s, new Set()); authors.get(s).add(ov);
    }
    else if (p === 'http://purl.org/pav/providedBy') {
      if (!provs.has(s)) provs.set(s, new Set()); provs.get(s).add(ov);
    }
    // ph:Upload activity (adicionado pelo backend em cada /upload-image).
    else if (p === PROV + 'startedAtTime') {
      const a = uploadProps.get(s) || {}; a.startedAt = ov; uploadProps.set(s, a);
    }
    else if (p === PROV + 'generated') {
      const a = uploadProps.get(s) || {}; a.generated = ov; uploadProps.set(s, a);
    }
  }
  // Indexa activities pelas imagens que geraram.
  for (const [_aIri, a] of uploadProps) {
    if (a.generated) uploadByImage.set(a.generated, a);
  }

  // Mapeia IRI de série pra sigla de exibição. Slug do IRI por padrão;
  // exceção: a série S (Suado) historicamente é grafada "PH-S".
  const SERIES_LABEL_OVERRIDE = { S: 'PH-S' };
  const seriesLabel = (iri) => {
    const slug = iri.split(/[/#]/).pop();
    return SERIES_LABEL_OVERRIDE[slug] || slug;
  };
  // Concatena as siglas de filiação de um passeio, ex.: "PH 92" ou
  // "PH 92 & PH-S 6". Ordena por sigla pra estabilidade.
  const buildTourCode = (tourIri) => {
    const assocs = tourAssocs.get(tourIri);
    if (!assocs || !assocs.size) return null;
    const parts = [];
    for (const a of assocs) {
      const sIri = assocSeries.get(a);
      const seq  = assocSequence.get(a);
      if (!sIri || !Number.isFinite(seq)) continue;
      parts.push(`${seriesLabel(sIri)} ${seq}`);
    }
    if (!parts.length) return null;
    parts.sort();
    return parts.join(' & ');
  };

  // Extrai o ID numérico do RideWithGPS da URL referenciada por ph:linkRoute.
  const tourRouteId = (tourIri) => {
    const bn = tourRouteRef.get(tourIri);
    if (!bn) return null;
    const url = subjectUrl.get(bn);
    if (!url) return null;
    const m = /ridewithgps\.com\/routes\/(\d+)/i.exec(url);
    return m ? m[1] : null;
  };

  tourCatalog = new Map();
  personCatalog = new Map();
  for (const [s, ts] of types) {
    if (ts.has(PH_NS + 'Tour')) {
      tourCatalog.set(s, {
        title:   titles.get(s) || s,
        date:    (dates.get(s) || '').slice(0, 10),
        code:    buildTourCode(s),
        routeId: tourRouteId(s),
      });
    }
    if (ts.has(SCHEMA + 'Person')) {
      personCatalog.set(s, { name: names.get(s) || s });
    }
  }

  const photos = [];
  for (const [s, ts] of types) {
    if (!ts.has(PH_NS + 'Image')) continue;
    const locNode = locOf.get(s);
    const lat = locNode != null ? locLat.get(locNode) : undefined;
    const lng = locNode != null ? locLng.get(locNode) : undefined;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const phash = s.startsWith(PHD_NS + 'image_') ? s.slice((PHD_NS + 'image_').length) : null;
    const tourIri = tours.get(s);
    const t = tourIri ? tourCatalog.get(tourIri) : null;
    const ride = t
      ? { date: t.date, name: t.title, code: t.code || null, tourIri: tourIri || null, routeId: t.routeId || null }
      : null;
    const personName = (iri) => personCatalog.get(iri)?.name || iri.split(/[/#]/).pop();
    const authorIris = [...(authors.get(s) || [])];
    const authorNames = authorIris.map(personName);
    const providerIris = [...(provs.get(s) || [])];
    const providerNames = providerIris.map(personName);
    const datetime = dates.get(s) || null;
    let fov = null;
    const f35 = focals.get(s);
    if (Number.isFinite(f35) && f35 > 0) {
      fov = (2 * Math.atan(36 / (2 * f35)) * 180) / Math.PI;
    }
    // Activity (`ph:Upload`) que gerou esta imagem, se houver — o servidor a
    // adiciona junto do upload, com ip / user-agent / timestamp de envio.
    const upload = uploadByImage.get(s) || null;
    photos.push({
      id: s,
      phash,
      lat, lng,
      alt:       elev.get(s) ?? null,
      bearing:   Number.isFinite(bearings.get(s)) ? bearings.get(s) : null,
      fov,
      orig:      titles.get(s) || (phash ? `image_${phash}` : s),
      datetime,
      ride,
      authors:   authorNames,
      providers: providerNames,
      license:   licenses.get(s) || null,
      upload,    // { startedAt } | null
      file:      resolvePhotoUrl(phash, 'large'),
      thumb:     resolvePhotoUrl(phash, 'thumb'),
      full:      resolvePhotoUrl(phash, 'original'),
    });
  }
  return photos;
}

// Tenta carregar o manifesto `data/data_graphs.ttl` de uma fonte; devolve
// a lista de URLs absolutas dos arquivos a fundir.
const VOID  = 'http://rdfs.org/ns/void#';
const MANIFEST_REL = 'data/data_graphs.ttl';

async function fetchManifest(originBase, originLabel) {
  // Resolve para URL absoluta — `new URL(rel, base)` exige base absoluta,
  // então `./data/data_graphs.ttl` (modo Pi) precisa virar
  // `http://host/.../data/data_graphs.ttl` primeiro.
  const url = new URL(originBase + MANIFEST_REL, location.href).href;
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${originLabel}: HTTP ${res.status}`);
  const text = await res.text();
  const quads = await parseTtlToQuads(text);
  const urls = [];
  for (const q of quads) {
    if (q.predicate.value === VOID + 'dataDump') {
      urls.push(new URL(q.object.value, url).href);
    }
  }
  return { url, urls };
}

// Carrega todos os grafos listados no manifesto e devolve {quads, text}.
// Para modo local, ignora manifesto e usa o TTL do kit direto.
async function loadAllGraphs() {
  if (photoSource === 'local') {
    if (!localKit) throw new Error('sem kit local importado');
    return {
      quads:   await parseTtlToQuads(localKit.ttlText),
      text:    localKit.ttlText,
      origin:  'local',
      sources: ['(kit local)'],
    };
  }
  // Pi e CDN: tenta cada base na ordem; o primeiro manifesto que responder vence.
  const bases = [];
  if (photoSource === 'pi'  || photoSource === 'auto') bases.push({ base: './',              label: 'pi' });
  if (photoSource === 'cdn' || photoSource === 'auto') bases.push({ base: PHOTOS_CDN_BASE,   label: 'cdn' });
  let lastErr = '';
  for (const b of bases) {
    let m;
    try { m = await fetchManifest(b.base, b.label); }
    catch (e) { lastErr = e.message; continue; }
    // Manifesto vivo — baixa cada arquivo listado.
    const allQuads = [];
    const parts    = [];
    for (const u of m.urls) {
      try {
        const r = await fetch(u, { cache: 'no-cache' });
        if (!r.ok) { console.warn(`[manifest] ${u}: ${r.status}`); continue; }
        const t = await r.text();
        parts.push(`# ─── ${u} ───\n${t}`);
        allQuads.push(...await parseTtlToQuads(t));
      } catch (e) { console.warn(`[manifest] ${u}: ${e.message}`); }
    }
    return {
      quads:   allQuads,
      text:    parts.join('\n\n'),
      origin:  b.label,
      sources: m.urls,
    };
  }
  throw new Error(lastErr || 'nenhuma fonte respondeu');
}

async function loadPhotos() {
  if (photosLoaded) return;
  if (photosLoading) { await photosLoading; return; }
  photosLoading = (async () => {
    try {
      const r = await loadAllGraphs();
      lastTtlText  = r.text;
      lastTtlOrigin = `${r.origin} · ${r.sources.length} grafo(s)`;
      const photos = buildModelFromQuads(r.quads);
      buildPhotoMarkers(photos);
      photosLoaded = true;
      updatePhotoSourceStatus(`${photos.length} foto(s), ${r.sources.length} grafo(s).`);
    } catch (err) {
      console.warn('[photos] falha:', err);
      showToast(`Falha ao carregar imagens: ${err.message}`);
      updatePhotoSourceStatus(`Erro: ${err.message}`);
    }
  })();
  await photosLoading;
}

// Dado curto: { rótulo, conteúdo HTML }. Vira <dl>.
function _photoDetailRows(ph) {
  const rows = [];
  if (ph.datetime) {
    const dt = new Date(ph.datetime);
    if (!isNaN(dt)) rows.push(['Quando', escapeHtml(dt.toLocaleString('pt-BR'))]);
  }
  if (ph.ride) {
    // Ex.: "PH 92: Crista do Lauzane…" ou "PH 92 & PH-S 6: O Trem e o Meteoro".
    const label = ph.ride.code && ph.ride.name
      ? `${ph.ride.code}: ${ph.ride.name}`
      : (ph.ride.code || ph.ride.name || ph.ride.date);
    // Se o passeio bate com uma entrada do catálogo (routes está chaveado
    // por tourIri), vira link que abre o modal correspondente na sidebar.
    const html = ph.ride.tourIri
      ? `<a href="#" class="ride-link" data-route-id="${escapeHtml(ph.ride.tourIri)}">${escapeHtml(label)}</a>`
      : escapeHtml(label);
    rows.push(['Passeio', html]);
  }
  const coords =
    `${ph.lat.toFixed(5)}, ${ph.lng.toFixed(5)}` +
    (Number.isFinite(ph.alt) ? ` · ${Math.round(ph.alt)} m` : '') +
    (Number.isFinite(ph.bearing) ? ` · ${Math.round(ph.bearing)}° ${cardinal(ph.bearing)}` : '');
  rows.push(['Coordenadas', escapeHtml(coords)]);
  if (ph.authors && ph.authors.length) {
    rows.push(['Autoria', escapeHtml(ph.authors.join(', '))]);
  }
  if (ph.providers && ph.providers.length) {
    rows.push(['Quem subiu', escapeHtml(ph.providers.join(', '))]);
  }
  if (ph.license) {
    // Texto compacto para CC; fallback pra URL inteira.
    let label = ph.license;
    const m = /licenses\/([a-z-]+)\/(\d+\.\d+)/.exec(ph.license);
    if (m) label = `CC ${m[1].toUpperCase()} ${m[2]}`;
    else if (/publicdomain\/zero\/1\.0/.test(ph.license)) label = 'CC0 1.0';
    rows.push(['Licença', `<a href="${escapeHtml(ph.license)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`]);
  }
  if (ph.upload && ph.upload.startedAt) {
    const dt = new Date(ph.upload.startedAt);
    const when = !isNaN(dt) ? dt.toLocaleString('pt-BR') : ph.upload.startedAt;
    rows.push(['Envio', escapeHtml(when)]);
  }
  if (ph.phash) {
    rows.push(['pHash', `<code>${escapeHtml(ph.phash)}</code>`]);
  }
  return rows;
}

function buildPhotoMarkers(photos) {
  for (const m of photoMarkers) {
    if (map.hasLayer(m)) map.removeLayer(m);
  }
  photoMarkers = [];
  for (const ph of photos) {
    if (!Number.isFinite(ph.lat) || !Number.isFinite(ph.lng)) continue;
    // O `largeUrl` é usado como variante 2x no `image-set` do marker —
    // em telas HiDPI (todos os celulares), o browser baixa essa versão
    // grande SÓ pra renderizar o dot mais nítido. Com dezenas de markers,
    // isso estoura memória em mobile. Quando o toggle de Ajustes está
    // desligado (padrão), passamos `null` e o image-set fica em thumb 1x.
    const useLargeFor2x = settings.images?.useLarge === true;
    const icon = photoDivIcon(
      ph.thumb || ph.file,
      ph.bearing,
      ph.fov,
      '',
      useLargeFor2x ? ph.file : null,
    );
    const m = L.marker([ph.lat, ph.lng], { icon, opacity: photosOpacity });
    m._photo = ph;
    const rows = _photoDetailRows(ph)
      .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${v}</dd>`).join('');
    // Baixar original: usa `download` no <a> — o backend é same-origin então
    // o browser respeita o atributo e abre o save-as direto. O nome do
    // arquivo herda o `orig` (título dcterms) quando disponível.
    const dlName = (ph.orig || (ph.phash ? `image_${ph.phash}` : 'image')).replace(/[\s/]+/g, '_');
    const dlBtn = ph.full
      ? `<a class="photo-dl" href="${escapeHtml(ph.full)}" download="${escapeHtml(dlName)}" target="_blank" rel="noopener">Baixar original ↓</a>`
      : '';
    // Botão de excluir: bate em POST /delete-image/<phash> (backend Pi).
    // Requer phash e fonte same-origin; em CDN/local só mostra "Baixar".
    const delBtn = (ph.phash && (photoSource === 'pi' || photoSource === 'auto'))
      ? `<button type="button" class="photo-del" data-phash="${escapeHtml(ph.phash)}">Excluir ✕</button>`
      : '';
    const actions = [dlBtn, delBtn].filter(Boolean).join('');
    m.bindPopup(
      `<div class="photo-popup">` +
        `<img src="${ph.file}" loading="lazy" alt="${escapeHtml(ph.orig)}" />` +
        `<dl class="photo-details">${rows}</dl>` +
        (actions ? `<div class="photo-actions">${actions}</div>` : '') +
      `</div>`,
      { maxWidth: 440, className: 'photo-popup-wrap', autoPan: false },
    );
    photoMarkers.push(m);
  }
  console.log(`[photos] ${photoMarkers.length} marcador(es)`);
}

async function reloadPhotos() {
  photosLoaded = false;
  photosLoading = null;
  await loadPhotos();
  applyPhotoVisibility();
}

// ─── Fonte (Pi / CDN / Local) ─────────────────────────────────────────────
function setPhotoSource(src) {
  if (!['auto', 'pi', 'cdn', 'local'].includes(src)) return;
  photoSource = src;
  try { localStorage.setItem('phidro:photoSource', src); } catch {}
  settings.photoSource = src;
  saveSettings();
  updatePhotoSourceStatus(`Fonte: ${src}.`);
  reloadPhotos();
}

function updatePhotoSourceStatus(msg) {
  const el = document.getElementById('photos-source-status');
  if (el) el.textContent = `${msg} (origem: ${lastTtlOrigin || photoSource})`;
}

async function importPhotosLocal(file) {
  if (!file) return;
  const name = (file.name || '').toLowerCase();
  if (name.endsWith('.ttl') || file.type === 'text/turtle') {
    lastTtlText = await file.text();
    lastTtlOrigin = `local: ${file.name}`;
    const photos = buildModelFromQuads(await parseTtlToQuads(lastTtlText));
    buildPhotoMarkers(photos);
    photosLoaded = true;
    applyPhotoVisibility();
    updatePhotoSourceStatus(`Importado ${photos.length} foto(s) de ${file.name}.`);
    return;
  }
  if (name.endsWith('.zip') || file.type === 'application/zip') {
    const JSZip = await ensureJSZip();
    const zip = await JSZip.loadAsync(file);
    let ttlEntry = zip.file('update.ttl');
    if (!ttlEntry) {
      for (const entry of Object.values(zip.files)) {
        if (!entry.dir && entry.name.endsWith('.ttl')) { ttlEntry = entry; break; }
      }
    }
    if (!ttlEntry) throw new Error('kit sem .ttl');
    if (localKit) {
      for (const u of localKit.files.values()) try { URL.revokeObjectURL(u); } catch {}
    }
    const files = new Map();
    for (const entry of Object.values(zip.files)) {
      if (entry.dir || !entry.name.startsWith('photos/')) continue;
      files.set(entry.name, URL.createObjectURL(await entry.async('blob')));
    }
    const ttlText = await ttlEntry.async('string');
    localKit = { ttlText, files };
    lastTtlText = ttlText;
    lastTtlOrigin = `local kit: ${file.name}`;
    photoSource = 'local';
    try { localStorage.setItem('phidro:photoSource', 'local'); } catch {}
    const photos = buildModelFromQuads(await parseTtlToQuads(ttlText));
    buildPhotoMarkers(photos);
    photosLoaded = true;
    applyPhotoVisibility();
    updatePhotoSourceStatus(`Importado kit com ${photos.length} foto(s).`);
    return;
  }
  throw new Error('arquivo precisa ser .ttl ou kit .zip');
}

function downloadTtl() {
  if (!lastTtlText) { showToast('Carregue um catálogo primeiro.'); return; }
  const blob = new Blob([lastTtlText], { type: 'text/turtle;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.download = `photos-${stamp}.ttl`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function downloadKit() {
  if (!photoMarkers.length) { showToast('Carregue um catálogo primeiro.'); return; }
  if (!lastTtlText) { showToast('TTL não disponível para o kit.'); return; }
  const JSZip = await ensureJSZip();
  const zip = new JSZip();
  zip.file('update.ttl', lastTtlText);
  const photosFolder = zip.folder('photos');
  let added = 0, missing = 0;
  for (const m of photoMarkers) {
    const ph = m._photo;
    if (!ph.phash) continue;
    const folder = photosFolder.folder(ph.phash);
    for (const [variant, url] of [['large', ph.file], ['thumb', ph.thumb], ['original', ph.full]]) {
      if (!url) { missing++; continue; }
      try {
        const res = await fetch(url);
        if (!res.ok) { missing++; continue; }
        folder.file(`${variant}.jpg`, await res.blob());
        added++;
      } catch { missing++; }
    }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `phidro-kit-${stamp}.zip`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  showToast(`Kit pronto: ${added} arquivo(s)${missing ? `, ${missing} indisponível(is)` : ''}.`);
}

// Visibilidade efetiva: camada ligada E (sem filtro OU foto do pedal filtrado).
function applyPhotoVisibility() {
  for (const m of photoMarkers) {
    const ph = m._photo;
    const matchesRide =
      !photoRideFilter ||
      (ph.ride && ph.ride.date === photoRideFilter.date);
    // Foto com datetime ausente é tratada como "sempre visível" (mesma
    // política que routes sem dateMs), pra não esconder fotos antigas
    // sem metadado por causa do filtro.
    let matchesDate = true;
    if (photoDateWindow && ph.datetime) {
      const t = Date.parse(ph.datetime);
      if (Number.isFinite(t)) {
        matchesDate = t >= photoDateWindow.from && t <= photoDateWindow.to;
      }
    }
    const shouldShow = photosVisible && matchesRide && matchesDate;
    if (shouldShow && !map.hasLayer(m)) m.addTo(map);
    else if (!shouldShow && map.hasLayer(m)) map.removeLayer(m);
  }
  renderPhotoFilterChip();
  relaxPhotoMarkers();
}

function showPhotos() {
  photosVisible = true;
  loadPhotos().then(() => {
    if (!photosVisible) return;
    applyPhotoVisibility();
    if (photoMarkers.length === 0) {
      showToast('Nenhuma imagem carregada (suba via upload_images.html)');
    }
  });
}
function hidePhotos() {
  photosVisible = false;
  applyPhotoVisibility();
}
function setPhotosOpacity(frac) {
  photosOpacity = frac;
  for (const m of photoMarkers) m.setOpacity(frac);
}

// Liga a camada já filtrada para um pedal (usado pelo modal de rota).
function showPhotosForRide(date, label) {
  photoRideFilter = { date, label: label || date };
  photosVisible = true;
  const cb = document.querySelector(
    '.layer-panel .layer-row[data-id="photos"] input[type="checkbox"]',
  );
  if (cb) cb.checked = true;
  loadPhotos().then(() => applyPhotoVisibility());
}
function clearPhotoRideFilter() {
  photoRideFilter = null;
  applyPhotoVisibility();
}

// Chip flutuante mostrando o filtro de pedal ativo (✕ limpa o filtro).
function renderPhotoFilterChip() {
  let chip = document.getElementById('photo-filter-chip');
  if (!photoRideFilter || !photosVisible) {
    if (chip) chip.remove();
    return;
  }
  if (!chip) {
    chip = document.createElement('div');
    chip.id = 'photo-filter-chip';
    chip.className = 'map-chip';
    document.getElementById('map').appendChild(chip);
  }
  const n = ridePhotos(photoRideFilter.date).length;
  chip.innerHTML =
    `<span>Fotos: ${escapeHtml(photoRideFilter.label)} (${n})</span>` +
    `<button type="button" title="Ver todas as imagens">✕</button>`;
  chip.querySelector('button').onclick = clearPhotoRideFilter;
}

// Tira de miniaturas das fotos do pedal, exibida no modal da rota.
function renderRoutePhotos(entry) {
  const box = document.getElementById('route-modal-photos');
  box.innerHTML = '';
  if (!entry.date) return;
  const label = entry.number?.value
    ? `${entry.number.source} ${entry.number.value}`
    : buildLabel(entry);
  // Carrega o catálogo de clipes em paralelo com photos pra renderizar a
  // tira de vídeos junto. Falha silenciosamente se uploads.ttl não tiver
  // ph:Video — apenas o strip de fotos sai.
  loadClipsCatalog().then(() => {
    const cms = rideClips(entry.date, entry.tourIri);
    if (!cms.length) return;
    const head = document.createElement('div');
    head.className = 'route-photos-head';
    const count = document.createElement('span');
    count.textContent = `${cms.length} vídeo${cms.length > 1 ? 's' : ''} deste pedal`;
    head.appendChild(count);
    const strip = document.createElement('div');
    strip.className = 'route-photos-strip';
    for (const { clip, marker } of cms) {
      const wrap = document.createElement('div');
      wrap.className = 'route-clip';
      const img = document.createElement('img');
      img.src = clip.thumb ? CLIPS_DIR + clip.thumb : '';
      img.loading = 'lazy';
      img.alt = clip.iri || 'vídeo';
      img.title = 'Ver no mapa';
      img.addEventListener('click', () => {
        closeRouteModal();
        map.setView(marker.getLatLng(), Math.max(map.getZoom(), 15));
        marker.openPopup();
      });
      wrap.appendChild(img);
      strip.appendChild(wrap);
    }
    box.appendChild(head);
    box.appendChild(strip);
  });
  loadPhotos().then(() => {
    const ms = ridePhotos(entry.date);
    if (ms.length === 0) return;
    const head = document.createElement('div');
    head.className = 'route-photos-head';
    const count = document.createElement('span');
    count.textContent = `${ms.length} imagem${ms.length > 1 ? 'ns' : ''} deste pedal`;
    head.appendChild(count);
    // Botões de download em lote — empacotam todas as fotos do pedal num .zip.
    const dlActions = document.createElement('span');
    dlActions.className = 'route-photos-dl';
    const bigBtn   = document.createElement('button');
    bigBtn.type = 'button'; bigBtn.className = 'linkbtn';
    bigBtn.textContent = 'Baixar originais ↓';
    const largeBtn = document.createElement('button');
    largeBtn.type = 'button'; largeBtn.className = 'linkbtn';
    largeBtn.textContent = 'Baixar grandes ↓';
    bigBtn.addEventListener('click',
      () => bulkDownloadPhotos(ms.map((m) => m._photo), 'original', label, bigBtn));
    largeBtn.addEventListener('click',
      () => bulkDownloadPhotos(ms.map((m) => m._photo), 'large', label, largeBtn));
    dlActions.appendChild(bigBtn);
    dlActions.appendChild(largeBtn);
    head.appendChild(dlActions);
    const strip = document.createElement('div');
    strip.className = 'route-photos-strip';
    for (const m of ms) {
      const img = document.createElement('img');
      img.src = m._photo.file;
      img.loading = 'lazy';
      img.alt = m._photo.orig || '';
      img.title = 'Ver no mapa';
      img.addEventListener('click', () => {
        closeRouteModal();
        showPhotosForRide(entry.date, label);
        map.setView(m.getLatLng(), Math.max(map.getZoom(), 15));
        m.openPopup();
      });
      strip.appendChild(img);
    }
    box.appendChild(head);
    box.appendChild(strip);
  });
}

// Baixa todas as fotos de um pedal num .zip (variant = 'original' | 'large').
// Usa o JSZip que já carregamos pra outros fluxos. Em caso de erro num
// arquivo, segue baixando os outros — o .zip sai com o que conseguiu.
async function bulkDownloadPhotos(photos, variant, label, btn) {
  if (!photos || !photos.length) return;
  const origLabel = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Empacotando…'; }
  try {
    const JSZip = await ensureJSZip();
    const zip = new JSZip();
    let ok = 0, fail = 0;
    for (let i = 0; i < photos.length; i++) {
      const ph = photos[i];
      const url = variant === 'original' ? ph.full : ph.file;
      if (!url) { fail++; continue; }
      if (btn) btn.textContent = `Baixando ${i + 1}/${photos.length}…`;
      try {
        const r = await fetch(url, { cache: 'no-cache' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const blob = await r.blob();
        // Nome no zip: tenta `orig`, cai pro phash, depois pro fim da URL.
        let name = (ph.orig || (ph.phash ? `image_${ph.phash}` : '')) || url.split('/').pop();
        name = name.replace(/[\\/:*?"<>|]+/g, '_');
        // Garante extensão razoável quando `orig` não traz.
        if (!/\.[a-z0-9]{1,5}$/i.test(name)) {
          const ext = (blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
          name = `${name}.${ext}`;
        }
        zip.file(name, blob);
        ok++;
      } catch (e) {
        console.warn(`[bulk-dl] ${url}: ${e.message}`);
        fail++;
      }
    }
    if (!ok) { showToast(`Falha ao baixar (${fail} erros)`); return; }
    if (btn) btn.textContent = 'Compactando…';
    const out = await zip.generateAsync({ type: 'blob' });
    const safe = (label || 'pedal').replace(/[\\/:*?"<>|\s]+/g, '_');
    const fname = `${safe}_${variant}.zip`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(out);
    a.download = fname;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    showToast(`${ok} imagem(ns) compactada(s)${fail ? ` · ${fail} com erro` : ''}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = origLabel; }
  }
}

// ─── Envio de fotos pelo usuário (apenas na sessão) ──────────────────────────
// Botão que abre o seletor de arquivos; lê o GPS do EXIF de cada foto no
// próprio navegador e a coloca no mapa. HEIC (iPhone) é convertido em JPEG
// via heic2any. Nada é salvo no servidor — recarregar a página limpa tudo.
// As bibliotecas exifr/heic2any são carregadas sob demanda para não pesar
// o carregamento normal da página.
const EXIFR_URL = 'https://cdn.jsdelivr.net/npm/exifr@7/dist/full.umd.js';
const HEIC2ANY_URL =
  'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';
const JSZIP_URL =
  'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
// Envio ao acervo agora acontece pela upload_images.html (POST /upload-image
// no Pi). Aqui no app o upload é apenas preview de sessão.
let uploadedMarkers = [];
let uploadedData = [];

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`falha ao carregar ${src}`));
    document.head.appendChild(s);
  });
}
async function ensureExifr() {
  if (!window.exifr) await loadScript(EXIFR_URL);
}
async function ensureHeic2any() {
  if (!window.heic2any) await loadScript(HEIC2ANY_URL);
}
async function ensureJSZip() {
  if (!window.JSZip) await loadScript(JSZIP_URL);
  return window.JSZip;
}
function isHeic(f) {
  return /image\/hei[cf]/i.test(f.type) || /\.(heic|heif)$/i.test(f.name);
}
// Tipo MIME confiável — alguns navegadores deixam f.type vazio para HEIC.
function fileContentType(f) {
  if (f.type) return f.type;
  const ext = (f.name.split('.').pop() || '').toLowerCase();
  return (
    { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
      heic: 'image/heic', heif: 'image/heif' }[ext] || 'application/octet-stream'
  );
}

async function handlePhotoUpload(fileList) {
  const files = [...(fileList || [])];
  if (files.length === 0) return;
  showToast(`Processando ${files.length} imagem(ns)…`);
  try {
    await ensureExifr();
  } catch {
    showToast('Não foi possível carregar o leitor de EXIF.');
    return;
  }
  if (files.some(isHeic)) {
    try {
      await ensureHeic2any();
    } catch {
      showToast('Não foi possível carregar o conversor HEIC.');
    }
  }

  let added = 0;
  let noGps = 0;
  let failed = 0;
  for (const f of files) {
    try {
      const meta = await window.exifr.parse(f, {
        gps: true,
        exif: true,
        ifd0: true,
        translateValues: false,
      });
      const lat = meta?.latitude;
      const lng = meta?.longitude;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        noGps++;
        continue;
      }
      let url;
      if (isHeic(f)) {
        if (!window.heic2any) {
          failed++;
          continue;
        }
        const out = await window.heic2any({
          blob: f,
          toType: 'image/jpeg',
          quality: 0.7,
        });
        url = URL.createObjectURL(Array.isArray(out) ? out[0] : out);
      } else {
        url = URL.createObjectURL(f);
      }
      const cam = cameraFromExif(meta);
      const ride = detectRide(meta?.DateTimeOriginal, lat, lng);
      addUploadedPhoto({
        url,
        file: f,
        orig: f.name,
        ride,
        lat: Math.round(lat * 1e6) / 1e6,
        lng: Math.round(lng * 1e6) / 1e6,
        alt: Number.isFinite(meta?.GPSAltitude)
          ? Math.round(meta.GPSAltitude * 10) / 10
          : null,
        datetime:
          meta?.DateTimeOriginal instanceof Date
            ? meta.DateTimeOriginal.toISOString()
            : null,
        bearing: cam.bearing,
        fov: cam.fov,
      });
      added++;
    } catch (err) {
      console.warn('[upload] falha em', f.name, err);
      failed++;
    }
  }

  if (added > 0) {
    map.fitBounds(L.latLngBounds(uploadedMarkers.map((m) => m.getLatLng())), {
      maxZoom: 15,
      padding: [40, 40],
    });
  }
  renderUploadChip();
  const parts = [`${added} adicionada(s)`];
  if (noGps) parts.push(`${noGps} sem GPS`);
  if (failed) parts.push(`${failed} com erro`);
  showToast(parts.join(' · '));
}

function addUploadedPhoto(p) {
  const icon = photoDivIcon(p.url, p.bearing, p.fov, 'photo-dot-upload', p.url);
  const m = L.marker([p.lat, p.lng], { icon });
  const when = p.datetime ? new Date(p.datetime).toLocaleString('pt-BR') : '';
  const rideText = p.ride
    ? (p.ride.code && p.ride.name
        ? `${p.ride.code}: ${p.ride.name}`
        : (p.ride.code || p.ride.name || p.ride.date))
    : 'Imagem enviada · apenas nesta sessão';
  m.bindPopup(
    `<div class="photo-popup">` +
      `<img src="${p.url}" alt="${escapeHtml(p.orig)}" />` +
      `<div class="photo-ride">${escapeHtml(rideText)}</div>` +
      `<div class="photo-meta">${escapeHtml(p.orig)}` +
      (when ? ` · ${escapeHtml(when)}` : '') +
      (Number.isFinite(p.alt) ? ` · ${p.alt} m` : '') +
      (Number.isFinite(p.bearing)
        ? ` · ${Math.round(p.bearing)}° ${cardinal(p.bearing)}`
        : '') +
      `</div></div>`,
    { maxWidth: 440, className: 'photo-popup-wrap', autoPan: false },
  );
  m.addTo(map);
  uploadedMarkers.push(m);
  uploadedData.push(p);
}

function clearUploadedPhotos() {
  for (const m of uploadedMarkers) map.removeLayer(m);
  for (const p of uploadedData) {
    try {
      URL.revokeObjectURL(p.url);
    } catch {}
  }
  uploadedMarkers = [];
  uploadedData = [];
  renderUploadChip();
}

// Exporta os pontos da sessão como JSON simples — útil pra triagem manual.
// Para entrar no acervo, suba via upload_images.html (POST /upload-image).
function exportUploadedPhotos() {
  if (uploadedData.length === 0) return;
  const payload = {
    generatedAt: new Date().toISOString(),
    count: uploadedData.length,
    photos: uploadedData.map((p) => ({
      file: `photos/${p.orig.replace(/\.[^.]+$/, '')}.jpg`,
      orig: p.orig,
      lat: p.lat,
      lng: p.lng,
      alt: p.alt,
      datetime: p.datetime,
      ride: null,
    })),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'photos-upload.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function renderUploadChip() {
  let chip = document.getElementById('upload-status-chip');
  if (uploadedMarkers.length === 0) {
    if (chip) chip.remove();
    return;
  }
  if (!chip) {
    chip = document.createElement('div');
    chip.id = 'upload-status-chip';
    chip.className = 'map-chip';
    document.getElementById('map').appendChild(chip);
  }
  chip.innerHTML =
    `<span>📷 ${uploadedMarkers.length} imagem(ns) (apenas nesta sessão)</span>` +
    `<button type="button" data-act="export">Exportar</button>` +
    `<button type="button" data-act="clear">Limpar</button>`;
  chip.querySelector('[data-act="export"]').onclick = exportUploadedPhotos;
  chip.querySelector('[data-act="clear"]').onclick = clearUploadedPhotos;
}

// "Enviar imagens" abre o upload_images.html dentro de um iframe modal:
// isola o estado da página (CDN imports, Tom Select, etc.) e devolve um
// uploadModal limpo a cada abertura.
const uploadBtn        = document.getElementById('upload-btn');
const uploadModal      = document.getElementById('upload-modal');
const uploadModalClose = document.getElementById('upload-modal-close');
const uploadIframe     = document.getElementById('upload-iframe');
function openUploadModal() {
  if (!uploadModal) return;
  closeOtherMobileDialogs('upload');
  // Lazy-load: só seta o src na 1ª abertura (depois mantém o estado do form).
  // NB: `iframe.src` (IDL) é truthy mesmo quando o atributo está vazio
  // (devolve a URL da página pai/`about:blank`). Checamos o atributo cru.
  if (!uploadIframe.getAttribute('src')) {
    uploadIframe.src = './upload_images.html';
  }
  uploadModal.hidden = false;
  uploadBtn?.setAttribute('aria-pressed', 'true');
}
function closeUploadModal() {
  if (uploadModal) uploadModal.hidden = true;
  uploadBtn?.setAttribute('aria-pressed', 'false');
  // Pega o manifesto + tiles novos sem dance de hard-refresh.
  reloadPhotos();
}
uploadBtn?.addEventListener('click', openUploadModal);
uploadModalClose?.addEventListener('click', closeUploadModal);
// Clique no overlay (fora do conteúdo) fecha.
uploadModal?.addEventListener('click', (e) => {
  if (e.target === uploadModal) closeUploadModal();
});
// Esc também fecha.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && uploadModal && !uploadModal.hidden) closeUploadModal();
});

// Cadastro/edição de passeio em iframe — o src é remontado a cada abertura
// porque o ?id pode mudar entre invocações (novo vs editar X vs editar Y).
const tourModal      = document.getElementById('tour-modal');
const tourModalClose = document.getElementById('tour-modal-close');
const tourModalTitle = document.getElementById('tour-modal-title');
const tourIframe     = document.getElementById('tour-iframe');
function openTourModal(tourId) {
  if (!tourModal) return;
  closeOtherMobileDialogs('tour');
  if (closeRouteModal && !routeModal?.hidden) closeRouteModal();
  if (tourModalTitle) {
    tourModalTitle.textContent = tourId ? 'Editar passeio' : 'Cadastrar passeio';
  }
  const src = tourId
    ? `./upload_tour.html?id=${encodeURIComponent(tourId)}`
    : './upload_tour.html';
  // Forçar reload mesmo quando o ?id é o mesmo: substitui o src.
  tourIframe.src = src;
  tourModal.hidden = false;
}
function closeTourModal() {
  if (tourModal) tourModal.hidden = true;
  // Libera o iframe (e seu state) — próxima abertura monta limpo.
  if (tourIframe) tourIframe.src = '';
  // Tour pode ter sido criado/editado/deletado → recarrega catálogos.
  // O resumo no route-modal re-fetch'a tours.ttl com no-cache na próxima
  // abertura, então mudanças aparecem sem refresh.
  reloadPhotos();
}
tourModalClose?.addEventListener('click', closeTourModal);
tourModal?.addEventListener('click', (e) => {
  if (e.target === tourModal) closeTourModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && tourModal && !tourModal.hidden) closeTourModal();
});

// Censo em iframe — re-aponta pra censo.html toda vez que abre. Sem isto,
// se o usuário navega de dentro do iframe (ex.: clicando "+ Cadastrar
// passeio", que vai pra upload_tour.html), reabrir o modal mostraria a
// página interna em vez do censo. Re-set explícito é cheap e idempotente.
const censoModal      = document.getElementById('censo-modal');
const censoModalClose = document.getElementById('censo-modal-close');
const censoIframe     = document.getElementById('censo-iframe');
const censoLink       = document.getElementById('censo-link');
const CENSO_URL = './censo.html';
function openCensoModal() {
  if (!censoModal) return;
  closeOtherMobileDialogs('censo');
  // Compara contra o iframe.contentWindow.location.pathname pra detectar
  // navegação interna; senão, mantém pra preservar scroll/sort do censo
  // entre aberturas. Fallback: comparar com getAttribute('src').
  let needsReset = true;
  try {
    const path = censoIframe.contentWindow?.location?.pathname || '';
    needsReset = !path.endsWith('/censo.html');
  } catch (_) {
    // Cross-origin protection — não devia rolar em same-origin, mas seguro.
    needsReset = !censoIframe.getAttribute('src');
  }
  if (needsReset) censoIframe.src = CENSO_URL;
  censoModal.hidden = false;
}
function closeCensoModal() {
  if (censoModal) censoModal.hidden = true;
}
censoLink?.addEventListener('click', (e) => {
  // Modifier keys / middle click → deixa o link funcionar normalmente
  // (abrir em nova aba, etc.).
  if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button === 1) return;
  e.preventDefault();
  openCensoModal();
});
censoModalClose?.addEventListener('click', closeCensoModal);
censoModal?.addEventListener('click', (e) => {
  if (e.target === censoModal) closeCensoModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && censoModal && !censoModal.hidden) closeCensoModal();
});

// ─── Modal de Configurações ───────────────────────────────────────────────
const settingsBtn        = document.getElementById('settings-btn');
const settingsModal      = document.getElementById('settings-modal');
const settingsClose      = document.getElementById('settings-close');
const photosImportBtn    = document.getElementById('photos-import-btn');
const photosImportInput  = document.getElementById('photos-import-input');
const photosExportTtlBtn = document.getElementById('photos-export-ttl-btn');
const photosExportKitBtn = document.getElementById('photos-export-kit-btn');
const photosReloadBtn    = document.getElementById('photos-reload-btn');

// Aplica TODOS os settings vivos (sem reload). Chamado quando algo muda no
// modal ou quando carrega um JSON-LD importado.
function applyPhotoHoverScale() {
  const s = settings.markerLayout?.hoverScale ?? 3.3;
  document.documentElement.style.setProperty('--photo-hover-scale', String(s));
}
function applyAllSettings() {
  applyPhotoAnim();      // liga/desliga animação + tickMs novo
  relaxPhotoMarkers();   // novos floor/ceil/boost pegam efeito agora
  applyPhotoHoverScale();
  applyClipsGhostSettings();
  applyClipMarkerSettings();
  applyAudioLoopSettings();
  applyImagesSettings();
  applyFovConeSettings();
}
// Cone de visada: a opacidade pega efeito via CSS var (live), mas o
// enable/disable e a escala reconstroem o ícone — então recarregamos as
// fotos quando esses dois mudam. Igual ao truque do useLarge.
let _lastFovEnabled = null;
let _lastFovScale = null;
function applyFovConeSettings() {
  const op = Number.isFinite(settings.fovCone?.opacity) ? settings.fovCone.opacity : 0.45;
  document.documentElement.style.setProperty('--photo-cone-opacity', String(op));
  const enabled = settings.fovCone?.enabled !== false;
  const scale = Number.isFinite(settings.fovCone?.sizeScale) ? settings.fovCone.sizeScale : 1;
  const structuralChange = (_lastFovEnabled !== null && _lastFovEnabled !== enabled)
                        || (_lastFovScale   !== null && _lastFovScale   !== scale);
  _lastFovEnabled = enabled;
  _lastFovScale   = scale;
  if (structuralChange
      && typeof reloadPhotos === 'function'
      && typeof photoMarkers !== 'undefined' && photoMarkers.length) {
    reloadPhotos();
  }
}
// `images.useLarge` é lido em tempo de criação dos markers — pra refletir
// uma mudança no toggle, precisamos reconstruir. `reloadPhotos` faz isso.
// Só dispara um reload se o valor REALMENTE mudou desde a última aplicação.
let _lastUseLarge = null;
function applyImagesSettings() {
  const v = settings.images?.useLarge === true;
  if (_lastUseLarge === v) return;
  _lastUseLarge = v;
  if (typeof reloadPhotos === 'function' && typeof photoMarkers !== 'undefined' && photoMarkers.length) {
    reloadPhotos();
  }
}
// Empurra os params do marker de clipe como custom properties no <html>;
// o CSS lê `--clip-marker-size`, `--clip-marker-border`, `--clip-min-scale`,
// `--clip-max-scale` em vez de valores hardcoded.
function applyClipMarkerSettings() {
  const m = settings.clipMarker || {};
  const root = document.documentElement.style;
  if (Number.isFinite(m.baseSizePx)) root.setProperty('--clip-marker-size', `${m.baseSizePx}px`);
  if (Number.isFinite(m.borderPx))   root.setProperty('--clip-marker-border', `${m.borderPx}px`);
  if (Number.isFinite(m.minScale))   root.setProperty('--clip-min-scale', String(m.minScale));
  if (Number.isFinite(m.maxScale))   root.setProperty('--clip-max-scale', String(m.maxScale));
}
applyClipMarkerSettings();
// Reage a mudanças no `settings.clipsGhost.enabled` quando o slider de
// Ajustes muda em tempo real. Se Animação está ligada e o vídeo foi
// desabilitado, para a reprodução; se foi habilitado e Animação está ligada,
// reinicia. (segmentSec / fadeSec pegam efeito no próximo clipe via
// `clipSegmentS()`/`clipFadeS()`.)
function applyClipsGhostSettings() {
  if (typeof settings === 'undefined') return;
  const animOn = settings.spotlight?.enabled;
  const wantClips = settings.clipsGhost?.enabled !== false;
  const isPlaying = clipsGhostVideo && !clipsGhostVideo.paused;
  if (animOn && wantClips && !isPlaying) {
    startClipsGhost();
  } else if (isPlaying && (!animOn || !wantClips)) {
    stopClipsGhost();
  }
  syncLayerCheckbox('clips-ghost', wantClips);
}
// Mantém o checkbox de Camadas em sincronia com o setting (quando o usuário
// muda em Ajustes, o painel reflete; e vice-versa). Não dispara `change`
// pra evitar laço recursivo.
function syncLayerCheckbox(layerId, checked) {
  const row = document.querySelector(`.layer-panel .layer-row[data-id="${CSS.escape(layerId)}"]`);
  const cb = row?.querySelector('input[type="checkbox"]');
  if (cb && cb.checked !== !!checked) cb.checked = !!checked;
}

// ── Audio loop ────────────────────────────────────────────────────────────
// Loop ambiente independente do vídeo: pega o `audio` de cada clipe e toca
// em sequência aleatória com crossfade. Dois `<audio>` elements são tocados
// em paralelo durante o crossfade — A esmaece, B aparece, e na próxima vez
// trocam de papel.
const audioLoopA = new Audio();
const audioLoopB = new Audio();
audioLoopA.preload = 'auto';
audioLoopB.preload = 'auto';
audioLoopA.volume = 0;
audioLoopB.volume = 0;
let audioLoopCurrent = audioLoopA;
let audioLoopNext    = audioLoopB;
let audioLoopActive  = false;
// Mesma ideia do clipsGhostUserOpacity: o teto inicial sai do `defaultPct`
// do `audio-loop` em OVERLAY_LAYERS.
let audioLoopUserVolume = (
  (OVERLAY_LAYERS.find((l) => l.id === 'audio-loop')?.defaultPct ?? 80) / 100
);
function setAudioLoopUserVolume(frac) {
  audioLoopUserVolume = Math.max(0, Math.min(1, frac));
  // Clampa o volume das trilhas em curso pra não estourar o novo teto.
  for (const el of [audioLoopA, audioLoopB]) {
    if (el && !el.paused) el.volume = Math.min(el.volume, audioLoopUserVolume);
  }
}
let audioLoopTimer   = null;
let audioLoopIndex   = -1;
let audioLoopFadeRafs = new WeakMap();   // raf id por elemento

function fadeAudioElement(el, targetVol, durationMs) {
  const prev = audioLoopFadeRafs.get(el);
  if (prev) cancelAnimationFrame(prev);
  const startVol = el.volume;
  const t0 = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - t0) / durationMs);
    el.volume = Math.max(0, Math.min(1, startVol + (targetVol - startVol) * t));
    if (t < 1) audioLoopFadeRafs.set(el, requestAnimationFrame(step));
    else audioLoopFadeRafs.delete(el);
  };
  audioLoopFadeRafs.set(el, requestAnimationFrame(step));
}

function pickNextAudioClipIndex() {
  if (!clipsCatalog || clipsCatalog.length === 0) return -1;
  const candidates = [];
  for (let i = 0; i < clipsCatalog.length; i++) {
    if (clipsCatalog[i].audio && i !== audioLoopIndex) candidates.push(i);
  }
  if (candidates.length === 0) {
    // Só sobrou o atual (ou nenhum) — repete mesmo.
    for (let i = 0; i < clipsCatalog.length; i++) if (clipsCatalog[i].audio) return i;
    return -1;
  }
  return candidates[Math.floor(Math.random() * candidates.length)];
}

async function startAudioLoop() {
  if (audioLoopActive) return;
  if (!settings.audioLoop?.enabled) return;
  await loadClipsCatalog();
  if (!clipsCatalog || clipsCatalog.length === 0) return;
  audioLoopActive = true;
  audioLoopAdvance();
}

function stopAudioLoop() {
  audioLoopActive = false;
  if (audioLoopTimer) { clearTimeout(audioLoopTimer); audioLoopTimer = null; }
  for (const el of [audioLoopA, audioLoopB]) {
    const r = audioLoopFadeRafs.get(el);
    if (r) cancelAnimationFrame(r);
    audioLoopFadeRafs.delete(el);
    try { el.pause(); } catch {}
    el.volume = 0;
  }
}

function audioLoopAdvance() {
  if (!audioLoopActive) return;
  const next = pickNextAudioClipIndex();
  if (next < 0) return;
  audioLoopIndex = next;
  const c = clipsCatalog[next];
  const segS  = Math.max(2, settings.audioLoop?.segmentSec ?? 12);
  const xfS   = Math.max(0.5, Math.min(settings.audioLoop?.crossfadeSec ?? 3, segS / 2));

  // Próxima trilha carrega no elemento "next" e sobe de 0 até 1; current
  // desce simultaneamente. Depois trocamos papel.
  audioLoopNext.src = CLIPS_DIR + c.audio;
  audioLoopNext.currentTime = 0;
  audioLoopNext.volume = 0;
  audioLoopNext.play().catch(() => {});
  fadeAudioElement(audioLoopNext, audioLoopUserVolume, xfS * 1000);
  fadeAudioElement(audioLoopCurrent, 0, xfS * 1000);

  // Swap roles pro próximo ciclo.
  const justStarted = audioLoopNext;
  audioLoopNext = audioLoopCurrent;
  audioLoopCurrent = justStarted;

  // Agenda próxima troca pra `segS - xfS` (assim o crossfade encavala bonito
  // no fim do segmento, não depois).
  audioLoopTimer = setTimeout(audioLoopAdvance, Math.max(1, (segS - xfS)) * 1000);
}

function applyAudioLoopSettings() {
  if (typeof settings === 'undefined') return;
  const want = settings.audioLoop?.enabled === true;
  if (want && !audioLoopActive) {
    // Browsers bloqueiam play() de áudio sem gesto do usuário. No boot
    // (sem cliques ainda) o `audio.play()` rejeita silencioso. Em vez de
    // tentar e falhar, esperamos o primeiro gesto na página e só então
    // iniciamos. Se o usuário trocou o setting via Ajustes (que JÁ é um
    // gesto), o `audioGestureUnlocked` flag pula a espera.
    if (audioGestureUnlocked) startAudioLoop();
    else armAudioLoopGestureUnlock();
  } else if (!want && audioLoopActive) {
    stopAudioLoop();
    disarmAudioLoopGestureUnlock();
  }
  syncLayerCheckbox('audio-loop', want);
}

// Marca uma vez que o usuário interagiu — qualquer pointerdown/keydown
// libera autoplay pelo resto da sessão.
let audioGestureUnlocked = false;
document.addEventListener('pointerdown', () => { audioGestureUnlocked = true; },
  { capture: true, once: true });
document.addEventListener('keydown', () => { audioGestureUnlocked = true; },
  { capture: true, once: true });

let audioLoopGestureHandler = null;
function armAudioLoopGestureUnlock() {
  if (audioLoopGestureHandler) return;
  audioLoopGestureHandler = () => {
    disarmAudioLoopGestureUnlock();
    audioGestureUnlocked = true;
    if (settings.audioLoop?.enabled && !audioLoopActive) startAudioLoop();
  };
  document.addEventListener('pointerdown', audioLoopGestureHandler, { capture: true, once: true });
  document.addEventListener('keydown', audioLoopGestureHandler, { capture: true, once: true });
  document.addEventListener('touchstart', audioLoopGestureHandler, { capture: true, once: true });
}
function disarmAudioLoopGestureUnlock() {
  if (!audioLoopGestureHandler) return;
  document.removeEventListener('pointerdown', audioLoopGestureHandler, true);
  document.removeEventListener('keydown', audioLoopGestureHandler, true);
  document.removeEventListener('touchstart', audioLoopGestureHandler, true);
  audioLoopGestureHandler = null;
}
applyPhotoHoverScale();
// Aplica as configs persistidas no boot — sem isso, sliders/checkboxes do
// painel Camadas ficam dessincronizados do estado real do app, e o loop de
// áudio salvo como `enabled: true` só pegaria efeito após a primeira
// interação manual.
applyClipsGhostSettings();
applyAudioLoopSettings();

// Lê/escreve em settings por caminho "a.b.c".
function getSettingPath(path) {
  return path.split('.').reduce((o, k) => o?.[k], settings);
}
function setSettingPath(path, value) {
  const parts = path.split('.');
  let o = settings;
  for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
  o[parts[parts.length - 1]] = value;
}
function syncSettingsControl(el) {
  const val = getSettingPath(el.dataset.setting);
  if (el.type === 'checkbox') {
    el.checked = !!val;
  } else if (el.type === 'range' || el.type === 'number') {
    el.value = String(val);
    const out = el.parentElement?.querySelector('output');
    if (out) out.textContent = el.value;
  } else {
    el.value = String(val);
  }
}
function wireSettingsControls() {
  if (!settingsModal) return;
  for (const el of settingsModal.querySelectorAll('[data-setting]')) {
    syncSettingsControl(el);
    el.addEventListener('input', () => {
      const path = el.dataset.setting;
      let v;
      if (el.type === 'checkbox') v = el.checked;
      else if (el.type === 'range' || el.type === 'number') v = parseFloat(el.value);
      else v = el.value;
      setSettingPath(path, v);
      const out = el.parentElement?.querySelector('output');
      if (out && el.type === 'range') out.textContent = el.value;
      saveSettings();
      applyAllSettings();
    });
  }
}

function openSettings() {
  if (!settingsModal) return;
  closeOtherMobileDialogs('settings');
  // Radios da fonte de imagens (não usam data-setting porque setPhotoSource
  // faz mais que só mexer no objeto).
  for (const r of settingsModal.querySelectorAll('input[name="photos-source"]')) {
    r.checked = (r.value === photoSource);
  }
  updatePhotoSourceStatus(lastTtlOrigin ? 'OK' : 'sem TTL carregado');
  for (const el of settingsModal.querySelectorAll('[data-setting]')) {
    syncSettingsControl(el);
  }
  settingsModal.hidden = false;
  settingsBtn?.setAttribute('aria-pressed', 'true');
}
function closeSettings() {
  if (settingsModal) settingsModal.hidden = true;
  settingsBtn?.setAttribute('aria-pressed', 'false');
}

settingsBtn?.addEventListener('click', () => {
  if (settingsModal && !settingsModal.hidden) {
    closeSettings();
    return;
  }
  openSettings();
});
settingsClose?.addEventListener('click', closeSettings);
settingsModal?.addEventListener('click', (e) => {
  if (e.target === settingsModal) closeSettings();
});
for (const r of settingsModal?.querySelectorAll('input[name="photos-source"]') || []) {
  r.addEventListener('change', () => setPhotoSource(r.value));
}
photosImportBtn?.addEventListener('click', () => photosImportInput?.click());
photosImportInput?.addEventListener('change', async () => {
  const f = photosImportInput.files && photosImportInput.files[0];
  if (!f) return;
  try { await importPhotosLocal(f); }
  catch (err) { showToast(`Falha no import: ${err.message}`); }
  photosImportInput.value = '';
});
photosExportTtlBtn?.addEventListener('click', downloadTtl);
photosExportKitBtn?.addEventListener('click', () => {
  downloadKit().catch(err => showToast(`Falha no kit: ${err.message}`));
});
photosReloadBtn?.addEventListener('click', () => reloadPhotos());
wireSettingsControls();

// Export / Import dos settings em JSON-LD.
const SETTINGS_JSONLD_CONTEXT = {
  '@vocab': 'https://pedalhidrografi.co/terms/settings#',
  ph:        'https://pedalhidrografi.co/terms#',
};
// Snapshot do estado atual dos controles do painel Camadas (checkbox de
// visibilidade + slider de opacidade) por ID de layer. Fica fora de
// `settings` porque a fonte de verdade é o DOM da Leaflet, não o objeto JS.
function collectLayerStates() {
  const panel = document.querySelector('.layer-panel');
  if (!panel) return null;
  const out = {};
  panel.querySelectorAll('.layer-row').forEach((row) => {
    const id = row.dataset.id;
    if (!id) return;
    const cb = row.querySelector('input[type="checkbox"]');
    const rb = row.querySelector('input[type="radio"]');
    const slider = row.querySelector('input.opacity-slider');
    out[id] = {
      visible: cb ? cb.checked : (rb ? rb.checked : null),
      pct: slider ? Number(slider.value) : null,
    };
  });
  return out;
}
function applyLayerStates(states) {
  if (!states || typeof states !== 'object') return;
  const panel = document.querySelector('.layer-panel');
  if (!panel) return;
  for (const [id, state] of Object.entries(states)) {
    const row = panel.querySelector(`.layer-row[data-id="${CSS.escape(id)}"]`);
    if (!row) continue;
    if (state.visible !== null && state.visible !== undefined) {
      const cb = row.querySelector('input[type="checkbox"]');
      const rb = row.querySelector('input[type="radio"]');
      if (cb) {
        cb.checked = !!state.visible;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (rb && state.visible) {
        rb.checked = true;
        rb.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    if (Number.isFinite(state.pct)) {
      const slider = row.querySelector('input.opacity-slider');
      if (slider) {
        slider.value = String(state.pct);
        slider.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
  }
}
// URL dos layers customizáveis (XYZ + WMS) vive em localStorage —
// preservamos como parte do export pra trazer junto.
function collectCustomLayers() {
  let wms = null;
  try { wms = JSON.parse(localStorage.getItem('phidro:customWms') || 'null'); }
  catch { wms = null; }
  return {
    xyz: localStorage.getItem('phidro:customXyz') || null,
    wms,
  };
}
function applyCustomLayers(cfg) {
  if (!cfg) return;
  if (cfg.xyz) {
    localStorage.setItem('phidro:customXyz', cfg.xyz);
    if (typeof ensureCustomXyz === 'function') ensureCustomXyz(cfg.xyz);
  }
  if (cfg.wms) {
    localStorage.setItem('phidro:customWms', JSON.stringify(cfg.wms));
    if (typeof ensureCustomWms === 'function') ensureCustomWms(cfg.wms);
  }
}

function downloadSettingsJsonLd() {
  const doc = {
    '@context': SETTINGS_JSONLD_CONTEXT,
    '@type': 'AppSettings',
    generatedAt: new Date().toISOString(),
    ...JSON.parse(JSON.stringify(settings)),
    layers: collectLayerStates(),
    customLayers: collectCustomLayers(),
  };
  const blob = new Blob([JSON.stringify(doc, null, 2)],
    { type: 'application/ld+json' });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `phidro-settings-${stamp}.jsonld`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  showToast('Configurações exportadas.');
}
async function importSettingsJsonLd(file) {
  const text = await file.text();
  let doc;
  try { doc = JSON.parse(text); }
  catch { throw new Error('JSON inválido'); }
  // Separa as duas chaves "fora-do-settings" (camadas e custom layers) do
  // resto antes do deep-merge — elas têm fluxos de aplicação próprios.
  const { '@context': _c, '@type': _t, generatedAt: _g,
          layers: layersState, customLayers, ...rest } = doc;
  const merged = _deepMerge(SETTINGS_DEFAULTS, _deepMerge(settings, rest));
  // Cuidado: a fonte de imagens muda via setPhotoSource pra disparar reload.
  const newPhotoSource = merged.photoSource;
  Object.assign(settings, merged);
  saveSettings();
  if (newPhotoSource && newPhotoSource !== photoSource) {
    setPhotoSource(newPhotoSource);
  }
  for (const el of settingsModal?.querySelectorAll('[data-setting]') || []) {
    syncSettingsControl(el);
  }
  applyAllSettings();
  applyCustomLayers(customLayers);
  // Aplica estados das camadas DEPOIS — os controles podem ter sido
  // recriados pela inicialização de camadas customizáveis acima.
  applyLayerStates(layersState);
  showToast('Configurações importadas.');
}
document.getElementById('settings-export-btn')?.addEventListener(
  'click', downloadSettingsJsonLd);
const settingsImportInput = document.getElementById('settings-import-input');
document.getElementById('settings-import-btn')?.addEventListener(
  'click', () => settingsImportInput?.click());
settingsImportInput?.addEventListener('change', async () => {
  const f = settingsImportInput.files && settingsImportInput.files[0];
  if (!f) return;
  try { await importSettingsJsonLd(f); }
  catch (err) { showToast(`Falha no import: ${err.message}`); }
  settingsImportInput.value = '';
});
document.getElementById('settings-reset-btn')?.addEventListener('click', () => {
  if (!confirm('Restaurar todos os parâmetros para os padrões?')) return;
  Object.assign(settings, JSON.parse(JSON.stringify(SETTINGS_DEFAULTS)));
  saveSettings();
  for (const el of settingsModal?.querySelectorAll('[data-setting]') || []) {
    syncSettingsControl(el);
  }
  applyAllSettings();
  showToast('Padrões restaurados.');
});

// ─── Cicloinfra (OSM cycling infrastructure) overlay ─────────────────────────
// Live-queries Overpass for everything that's safe-ish for a bicycle:
//   highway=cycleway                  dedicated bike path
//   highway=path  +  bicycle=yes/designated   shared multi-use path
//   highway=*      +  cycleway[:left|:right|:both]=lane/track/...
//                                     a road that has a bike lane / track
// All in the same accent-cyan, with weight + dash signaling type.
const cycloinfraLayers = [];
let cycloinfraActive = false;
let cycloinfraOpacity = 1;
let cycloinfraDebounce = null;
let cycloinfraFetchSeq = 0;

async function queryCycloinfra(b) {
  const q = `[out:json][timeout:60];
(
  way["highway"="cycleway"](${b.south},${b.west},${b.north},${b.east});
  way["highway"="path"]["bicycle"~"yes|designated"](${b.south},${b.west},${b.north},${b.east});
  way["highway"]["cycleway"~"lane|track|opposite_lane|opposite_track|shared_lane|share_busway"](${b.south},${b.west},${b.north},${b.east});
  way["highway"]["cycleway:left"~"lane|track|opposite_lane|opposite_track|shared_lane|share_busway"](${b.south},${b.west},${b.north},${b.east});
  way["highway"]["cycleway:right"~"lane|track|opposite_lane|opposite_track|shared_lane|share_busway"](${b.south},${b.west},${b.north},${b.east});
  way["highway"]["cycleway:both"~"lane|track|opposite_lane|opposite_track|shared_lane|share_busway"](${b.south},${b.west},${b.north},${b.east});
);
out body;
>;
out skel qt;`;
  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    body: 'data=' + encodeURIComponent(q),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  if (!res.ok) throw new Error(`Overpass ${res.status}`);
  return res.json();
}

function classifyCycloinfra(tags) {
  if (tags.highway === 'cycleway') return 'ciclovia';
  if (tags.highway === 'path') return 'caminho compartilhado';
  if (
    tags.cycleway ||
    tags['cycleway:left'] ||
    tags['cycleway:right'] ||
    tags['cycleway:both']
  ) return 'ciclofaixa';
  return '';
}

function styleForCycloinfra(tags) {
  const kind = classifyCycloinfra(tags);
  // Ciclovia (segregated): solid + thick. Ciclofaixa (painted lane on road):
  // dashed + thinner. Shared path: dotted.
  if (kind === 'ciclovia') {
    return { color: '#00BFA6', weight: 4, opacity: cycloinfraOpacity };
  }
  if (kind === 'caminho compartilhado') {
    return {
      color: '#00BFA6',
      weight: 3,
      opacity: cycloinfraOpacity,
      dashArray: '2 5',
    };
  }
  if (kind === 'ciclofaixa') {
    return {
      color: '#00BFA6',
      weight: 3,
      opacity: cycloinfraOpacity,
      dashArray: '6 4',
    };
  }
  return { color: '#00BFA6', weight: 2, opacity: cycloinfraOpacity };
}

function clearCycloinfraLayers() {
  for (const l of cycloinfraLayers) map.removeLayer(l);
  cycloinfraLayers.length = 0;
}

function renderCycloinfra(data) {
  clearCycloinfraLayers();
  const nodes = new Map();
  for (const el of data.elements || []) {
    if (el.type === 'node') nodes.set(el.id, [el.lat, el.lon]);
  }
  for (const el of data.elements || []) {
    if (el.type !== 'way') continue;
    const latlngs = (el.nodes || []).map((id) => nodes.get(id)).filter(Boolean);
    if (latlngs.length < 2) continue;
    const tags = el.tags || {};
    const layer = L.polyline(latlngs, styleForCycloinfra(tags));
    const parts = [];
    if (tags.name) parts.push(`<strong>${escapeHtml(tags.name)}</strong>`);
    const kind = classifyCycloinfra(tags);
    if (kind) parts.push(`<em>${kind}</em>`);
    if (tags.surface) parts.push(`piso: ${escapeHtml(tags.surface)}`);
    layer.bindTooltip(parts.join(' · ') || 'cicloinfra', {
      sticky: true,
      className: 'osm-tip',
    });
    layer.addTo(map);
    cycloinfraLayers.push(layer);
  }
}

async function refreshCycloinfra() {
  if (!cycloinfraActive) return;
  if (map.getZoom() < OVERPASS_MIN_ZOOM) {
    clearCycloinfraLayers();
    showToast(`Aproxime o mapa (zoom ≥ ${OVERPASS_MIN_ZOOM}) para buscar OSM`);
    return;
  }
  const b = map.getBounds();
  const bbox = {
    south: b.getSouth().toFixed(6),
    west: b.getWest().toFixed(6),
    north: b.getNorth().toFixed(6),
    east: b.getEast().toFixed(6),
  };
  const seq = ++cycloinfraFetchSeq;
  showToast('Buscando cicloinfra OSM…', 1500);
  try {
    const data = await queryCycloinfra(bbox);
    if (seq !== cycloinfraFetchSeq || !cycloinfraActive) return;
    renderCycloinfra(data);
    showToast(`Cicloinfra: ${cycloinfraLayers.length} vias`, 1800);
  } catch (err) {
    if (seq !== cycloinfraFetchSeq) return;
    console.warn('Overpass cicloinfra failed:', err);
    showToast(`Falha cicloinfra: ${err.message}`);
  }
}

function onCycloinfraMoveEnd() {
  clearTimeout(cycloinfraDebounce);
  cycloinfraDebounce = setTimeout(refreshCycloinfra, 700);
}

function showCycloinfra() {
  cycloinfraActive = true;
  map.on('moveend', onCycloinfraMoveEnd);
  refreshCycloinfra();
}
function hideCycloinfra() {
  cycloinfraActive = false;
  map.off('moveend', onCycloinfraMoveEnd);
  clearTimeout(cycloinfraDebounce);
  clearCycloinfraLayers();
}
function setCycloinfraOpacity(frac) {
  cycloinfraOpacity = frac;
  for (const l of cycloinfraLayers) l.setStyle({ opacity: frac });
}

// ─── Custom XYZ / WMS layers ─────────────────────────────────────────────────
let customXyzUrl = localStorage.getItem('phidro:customXyz') || '';
let customXyzLayer = null;
let customWmsConfig = (() => {
  try { return JSON.parse(localStorage.getItem('phidro:customWms') || 'null'); }
  catch { return null; }
})();
let customWmsLayer = null;

function ensureCustomXyz(url) {
  if (!url) return null;
  if (customXyzLayer && customXyzUrl === url) return customXyzLayer;
  if (customXyzLayer && map.hasLayer(customXyzLayer)) map.removeLayer(customXyzLayer);
  customXyzUrl = url;
  customXyzLayer = L.tileLayer(url, {
    maxZoom: 22,
    opacity: 0.8,
    attribution: 'XYZ custom',
  });
  localStorage.setItem('phidro:customXyz', url);
  return customXyzLayer;
}

function showCustomXyz() {
  if (!customXyzUrl) {
    promptCustomXyzUrl();
    if (!customXyzUrl) {
      // user cancelled — uncheck the box again
      const cb = document.querySelector('input[type="checkbox"][data-id="custom-xyz"]');
      if (cb) cb.checked = false;
      return;
    }
  }
  ensureCustomXyz(customXyzUrl);
  if (customXyzLayer && !map.hasLayer(customXyzLayer)) customXyzLayer.addTo(map);
}
function hideCustomXyz() {
  if (customXyzLayer && map.hasLayer(customXyzLayer)) map.removeLayer(customXyzLayer);
}

function promptCustomXyzUrl() {
  const url = prompt(
    'URL do tile XYZ (use {z}/{x}/{y} como placeholders):\n' +
      'Ex: https://server.example.com/tiles/{z}/{x}/{y}.png',
    customXyzUrl,
  );
  if (url == null) return;
  const trimmed = url.trim();
  if (!trimmed) {
    customXyzUrl = '';
    localStorage.removeItem('phidro:customXyz');
    hideCustomXyz();
    return;
  }
  ensureCustomXyz(trimmed);
  if (customXyzLayer && !map.hasLayer(customXyzLayer)) customXyzLayer.addTo(map);
  // Tick the checkbox in case it was unchecked
  const cb = document.querySelector('input[type="checkbox"][data-id="custom-xyz"]');
  if (cb) cb.checked = true;
  showToast(`XYZ custom carregado`);
}

function ensureCustomWms(cfg) {
  if (!cfg || !cfg.service || !cfg.layers) return null;
  const sameAsBefore = customWmsLayer && customWmsConfig &&
    customWmsConfig.service === cfg.service &&
    customWmsConfig.layers === cfg.layers &&
    customWmsConfig.version === cfg.version;
  if (sameAsBefore) return customWmsLayer;
  if (customWmsLayer && map.hasLayer(customWmsLayer)) map.removeLayer(customWmsLayer);
  customWmsConfig = cfg;
  customWmsLayer = L.tileLayer.wms(cfg.service, {
    layers: cfg.layers,
    format: 'image/png',
    transparent: true,
    version: cfg.version || '1.3.0',
    opacity: 0.8,
    maxZoom: 22,
    attribution: 'WMS custom',
  });
  localStorage.setItem('phidro:customWms', JSON.stringify(cfg));
  return customWmsLayer;
}

function showCustomWms() {
  if (!customWmsConfig) {
    promptCustomWmsConfig();
    if (!customWmsConfig) {
      const cb = document.querySelector('input[type="checkbox"][data-id="custom-wms"]');
      if (cb) cb.checked = false;
      return;
    }
  }
  ensureCustomWms(customWmsConfig);
  if (customWmsLayer && !map.hasLayer(customWmsLayer)) customWmsLayer.addTo(map);
}
function hideCustomWms() {
  if (customWmsLayer && map.hasLayer(customWmsLayer)) map.removeLayer(customWmsLayer);
}

function promptCustomWmsConfig() {
  const service = prompt(
    'URL do servidor WMS:\nEx: https://example.com/geoserver/wms',
    customWmsConfig?.service || '',
  );
  if (service == null) return;
  const s = service.trim();
  if (!s) {
    customWmsConfig = null;
    localStorage.removeItem('phidro:customWms');
    hideCustomWms();
    return;
  }
  const layers = prompt(
    'Nome da camada WMS (use vírgula para múltiplas):\nEx: workspace:layerName',
    customWmsConfig?.layers || '',
  );
  if (layers == null) return;
  const l = layers.trim();
  if (!l) return;
  ensureCustomWms({ service: s, layers: l, version: customWmsConfig?.version || '1.3.0' });
  if (customWmsLayer && !map.hasLayer(customWmsLayer)) customWmsLayer.addTo(map);
  const cb = document.querySelector('input[type="checkbox"][data-id="custom-wms"]');
  if (cb) cb.checked = true;
  showToast(`WMS custom carregado`);
}

// "Where am I" control (leaflet-locatecontrol). Adds the small target icon
// in the top-left of the map AND wires the topbar "📍 Localização" button
// to trigger it programmatically — same control instance, two affordances.
let locateControl = null;
if (L.control.locate) {
  locateControl = L.control.locate({
    position: 'topleft',
    setView: 'untilPan',
    flyTo: true,
    cacheLocation: true,
    drawCircle: true,
    showPopup: false,
    keepCurrentZoomLevel: false,
    locateOptions: { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
    strings: {
      title: 'Mostrar minha localização',
      metersUnit: 'm',
      feetUnit: 'ft',
      popup: 'Você está a até {distance} {unit} deste ponto',
      outsideMapBoundsMsg: 'Fora dos limites do mapa',
    },
  }).addTo(map);
}
const locateBtn = document.getElementById('locate-btn');
locateBtn?.addEventListener('click', () => {
  if (!locateControl) {
    alert('Geolocalização não disponível neste navegador.');
    return;
  }
  // Toggle behavior: tap once to start tracking, tap again to stop.
  if (locateControl._active) locateControl.stop();
  else locateControl.start();
});

const layerPanel = L.control({ position: 'topright' });
layerPanel.onAdd = function () {
  const div = L.DomUtil.create('div', 'leaflet-bar layer-panel');
  div.innerHTML =
    `<div class="layer-section-title">Base</div>` +
    BASE_LAYERS.map((l) => `
      <div class="layer-row" data-id="${l.id}">
        <label>
          <input type="radio" name="base" data-id="${l.id}" ${l.defaultActive ? 'checked' : ''} />
          <span>${l.label}</span>
        </label>
        <input type="range" class="opacity-slider" data-id="${l.id}" min="0" max="100" value="${l.defaultPct}" />
        <span class="opacity-value" data-id="${l.id}">${l.defaultPct}%</span>
      </div>`).join('') +
    `<div class="layer-section-title">Sobreposições</div>` +
    OVERLAY_LAYERS.map((l) => `
      <div class="layer-row" data-id="${l.id}">
        <label>
          <input type="checkbox" data-id="${l.id}" ${l.defaultVisible ? 'checked' : ''} />
          <span>${l.label}${l.editable ? ` <a href="#" class="layer-edit-link" data-id="${l.id}" title="Editar URL">✎</a>` : ''}</span>
        </label>
        <input type="range" class="opacity-slider" data-id="${l.id}" min="0" max="100" value="${l.defaultPct}" />
        <span class="opacity-value" data-id="${l.id}">${l.defaultPct}%</span>
      </div>`).join('');

  L.DomEvent.disableClickPropagation(div);
  L.DomEvent.disableScrollPropagation(div);

  // Base radios: switch which layer is active (mutually exclusive).
  div.querySelectorAll('input[name="base"]').forEach((input) => {
    input.addEventListener('change', () => {
      for (const b of BASE_LAYERS) {
        if (input.dataset.id === b.id) {
          if (!map.hasLayer(b.layer)) b.layer.addTo(map);
        } else if (map.hasLayer(b.layer)) {
          map.removeLayer(b.layer);
        }
      }
    });
  });

  // Overlay checkboxes: toggle visibility. Custom show/hide if the entry
  // exposes them (used by the routes pseudo-layer); otherwise default to
  // adding/removing the underlying tile layer.
  div.querySelectorAll('.layer-row input[type="checkbox"]').forEach((input) => {
    input.addEventListener('change', () => {
      const o = OVERLAY_LAYERS.find((x) => x.id === input.dataset.id);
      if (!o) return;
      if (o.show && o.hide) {
        if (input.checked) o.show(); else o.hide();
      } else if (o.layer) {
        if (input.checked) o.layer.addTo(map);
        else if (map.hasLayer(o.layer)) map.removeLayer(o.layer);
      }
    });
  });

  // Opacity sliders for both base and overlay layers.
  const ALL_LAYERS = [...BASE_LAYERS, ...OVERLAY_LAYERS];
  div.querySelectorAll('input.opacity-slider').forEach((input) => {
    input.addEventListener('input', () => {
      const l = ALL_LAYERS.find((x) => x.id === input.dataset.id);
      if (!l) return;
      const pct = Number(input.value);
      if (l.setOpacity) l.setOpacity(pct / 100);
      else if (l.layer && l.layer.setOpacity) l.layer.setOpacity(pct / 100);
      div.querySelector(`.opacity-value[data-id="${l.id}"]`).textContent = `${pct}%`;
    });
  });

  // Edit ✎ link on custom layers — opens a prompt to set/change the URL.
  div.querySelectorAll('.layer-edit-link').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const o = OVERLAY_LAYERS.find((x) => x.id === link.dataset.id);
      if (o && o.edit) o.edit();
    });
  });

  return div;
};
layerPanel.addTo(map);
// A camada "Fotos geo" vem ligada por padrão (defaultVisible: true) — o
// checkbox só reflete o estado, então a ativamos explicitamente aqui.
showPhotos();

// ─── State ───────────────────────────────────────────────────────────────────
const routesList = document.getElementById('routes-list');
const routesStatus = document.getElementById('routes-status');
const dateFilter = document.getElementById('date-filter');
const rangeFrom = document.getElementById('range-from');
const rangeTo = document.getElementById('range-to');
const rangeFromValue = document.getElementById('range-from-value');
const rangeToValue = document.getElementById('range-to-value');
const dateReset = document.getElementById('date-reset');

// tourIri → { entry, layer, casing, badge, listEl, bounds, dateMs, visible }
// Vários passeios podem compartilhar uma rota do RWGPS (entry.id), mas cada
// um é um evento próprio — chaveamos por tourIri pra preservar essa identidade.
const routes = new Map();
let dateMin = null;
let dateMax = null;

// ─── Layer panel toggle (header button) ──────────────────────────────────────
const layersBtn = document.getElementById('layers-btn');
const LAYERS_HIDDEN_KEY = 'phidro:layersHidden';
const LAYERS_AUTO_HIDE_AREA_FRAC = 0.2; // se o painel cobriria >20% da tela, oculta no boot
function applyLayersVisibility(hidden) {
  document.body.classList.toggle('layers-hidden', hidden);
  if (layersBtn) layersBtn.setAttribute('aria-pressed', String(!hidden));
}
function defaultLayersHiddenByArea() {
  const el = document.querySelector('.layer-panel');
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;
  const panelArea = rect.width * rect.height;
  const viewportArea = window.innerWidth * window.innerHeight;
  return panelArea > LAYERS_AUTO_HIDE_AREA_FRAC * viewportArea;
}
{
  const persisted = localStorage.getItem(LAYERS_HIDDEN_KEY);
  const shouldHide = persisted !== null
    ? persisted === '1'
    : defaultLayersHiddenByArea();
  applyLayersVisibility(shouldHide);
}
layersBtn?.addEventListener('click', () => {
  const nowHidden = !document.body.classList.contains('layers-hidden');
  if (!nowHidden) closeOtherMobileDialogs('layers');
  applyLayersVisibility(nowHidden);
  try { localStorage.setItem(LAYERS_HIDDEN_KEY, nowHidden ? '1' : '0'); } catch {}
});

// ─── Header toggle (hide/show topbar) ────────────────────────────────────────
const headerToggle = document.getElementById('header-toggle');
const HEADER_HIDDEN_KEY = 'phidro:headerHidden';
// Park the toggle in Leaflet's top-left control column, above the zoom +/−.
const leafletTopLeft = document.querySelector('.leaflet-top.leaflet-left');
if (headerToggle && leafletTopLeft) {
  leafletTopLeft.insertBefore(headerToggle, leafletTopLeft.firstChild);
  L.DomEvent.disableClickPropagation(headerToggle);
  L.DomEvent.disableScrollPropagation(headerToggle);
}
function applyHeaderVisibility(hidden) {
  document.body.classList.toggle('header-hidden', hidden);
  if (headerToggle) {
    headerToggle.textContent = hidden ? '☰▼' : '☰▲';
    headerToggle.setAttribute('aria-pressed', String(hidden));
    headerToggle.setAttribute('aria-label', hidden ? 'Mostrar cabeçalho' : 'Ocultar cabeçalho');
    headerToggle.setAttribute('title', hidden ? 'Mostrar cabeçalho' : 'Ocultar cabeçalho');
  }
}
applyHeaderVisibility(localStorage.getItem(HEADER_HIDDEN_KEY) === '1');
headerToggle?.addEventListener('click', () => {
  const nowHidden = !document.body.classList.contains('header-hidden');
  applyHeaderVisibility(nowHidden);
  try { localStorage.setItem(HEADER_HIDDEN_KEY, nowHidden ? '1' : '0'); } catch {}
});

// ─── Sidebar toggle (mobile drawer + desktop hide) ───────────────────────────
// Two distinct states so behavior matches each viewport:
//   .sidebar-open   — explicit "show now" on mobile (drawer slide-in).
//   .sidebar-hidden — explicit "hide" on desktop (map gets full width).
const menuBtn = document.getElementById('menu-btn');
const SIDEBAR_HIDDEN_KEY = 'phidro:sidebarHidden';
const isMobileViewport = () => window.matchMedia('(max-width: 760px)').matches;

// No mobile, cada diálogo (Camadas, Rotas, Enviar, Ajustes, Ajuda) é um
// bottom-sheet — e só um pode ficar aberto por vez. Antes de abrir um,
// pedimos pros outros se recolherem. (No desktop é no-op, pra não atrapalhar
// quem quer ver dois painéis lado a lado.)
function closeOtherMobileDialogs(except) {
  if (!isMobileViewport()) return;
  if (except !== 'sidebar' && document.body.classList.contains('sidebar-open')) {
    document.body.classList.remove('sidebar-open');
    if (typeof updateMenuBtnPressed === 'function') updateMenuBtnPressed();
  }
  if (except !== 'layers' && !document.body.classList.contains('layers-hidden')) {
    // applyLayersVisibility só altera DOM/aria — não persiste no localStorage.
    applyLayersVisibility(true);
  }
  if (except !== 'help' && helpModal && !helpModal.hidden) {
    helpModal.hidden = true;
    helpBtn?.setAttribute('aria-pressed', 'false');
  }
  if (except !== 'settings' && settingsModal && !settingsModal.hidden) {
    settingsModal.hidden = true;
    settingsBtn?.setAttribute('aria-pressed', 'false');
  }
  if (except !== 'upload' && uploadModal && !uploadModal.hidden) {
    uploadModal.hidden = true;
    uploadBtn?.setAttribute('aria-pressed', 'false');
  }
  if (except !== 'tour' && tourModal && !tourModal.hidden) {
    tourModal.hidden = true;
    if (tourIframe) tourIframe.src = '';
  }
  if (except !== 'censo' && censoModal && !censoModal.hidden) {
    censoModal.hidden = true;
  }
}

// Boot defaults para a sidebar no desktop:
//   - Se existir preferência persistida, ela manda (1 = oculta, 0 = visível).
//   - Sem preferência: oculta automaticamente quando a viewport for pequena
//     demais — não cabem ~4 rotas verticalmente OU a tela não tem largura pra
//     pelo menos 4× a sidebar (320px cada).
// No mobile, ignoramos `.sidebar-hidden` (que `display:none`-aria a sidebar
// e quebraria o drawer); o drawer começa fechado por outros meios.
const SIDEBAR_AUTO_HIDE_MIN_HEIGHT = 400;   // ~50px/rota × 4 + cabeçalho
const SIDEBAR_AUTO_HIDE_MIN_WIDTH  = 320 * 4; // 4× largura da sidebar
function defaultDesktopSidebarHidden() {
  return (
    window.innerHeight < SIDEBAR_AUTO_HIDE_MIN_HEIGHT ||
    window.innerWidth  < SIDEBAR_AUTO_HIDE_MIN_WIDTH
  );
}
if (!isMobileViewport()) {
  const persisted = localStorage.getItem(SIDEBAR_HIDDEN_KEY);
  const shouldHide = persisted !== null ? persisted === '1' : defaultDesktopSidebarHidden();
  if (shouldHide) {
    document.body.classList.add('sidebar-hidden');
    // O grid muda pra coluna única — o container do mapa cresce. Leaflet
    // cacheia o tamanho na hora de inicializar, então sem `invalidateSize()`
    // a área onde a sidebar ficaria não pede tiles até o usuário panejar.
    setTimeout(() => map.invalidateSize(), 0);
  }
}
updateMenuBtnPressed();

menuBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (isMobileViewport()) {
    const willOpen = !document.body.classList.contains('sidebar-open');
    if (willOpen) closeOtherMobileDialogs('sidebar');
    document.body.classList.toggle('sidebar-open');
  } else {
    const nowHidden = !document.body.classList.contains('sidebar-hidden');
    document.body.classList.toggle('sidebar-hidden', nowHidden);
    try { localStorage.setItem(SIDEBAR_HIDDEN_KEY, nowHidden ? '1' : '0'); } catch {}
    // Trigger a Leaflet reflow so the map fills the new width cleanly.
    setTimeout(() => map.invalidateSize(), 220);
  }
  updateMenuBtnPressed();
});

// Tap outside the drawer closes it (mobile only).
document.addEventListener('click', (e) => {
  if (!isMobileViewport()) return;
  if (!document.body.classList.contains('sidebar-open')) return;
  if (e.target.closest('#sidebar') || e.target.closest('#menu-btn')) return;
  document.body.classList.remove('sidebar-open');
  updateMenuBtnPressed();
});

// Transição mobile → desktop (ex.: usuário gira pra landscape e a viewport
// cruza 760px): mantém a sidebar oculta. Sem isto, o CSS desktop volta a
// mostrá-la porque `.sidebar-hidden` não foi aplicado no boot mobile.
let _wasMobileViewport = isMobileViewport();
window.addEventListener('resize', () => {
  const nowMobile = isMobileViewport();
  if (_wasMobileViewport && !nowMobile) {
    document.body.classList.add('sidebar-hidden');
    document.body.classList.remove('sidebar-open');
    setTimeout(() => map.invalidateSize(), 0);
  }
  _wasMobileViewport = nowMobile;
  updateMenuBtnPressed();
});

function updateMenuBtnPressed() {
  if (!menuBtn) return;
  const visible = isMobileViewport()
    ? document.body.classList.contains('sidebar-open')
    : !document.body.classList.contains('sidebar-hidden');
  menuBtn.setAttribute('aria-pressed', String(visible));
}

// ─── PWA: register service worker ────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  // Don't block boot — register after the page settles.
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => {
      console.warn('[sw] registration failed:', err);
    });
  });
}

// ─── Boot ────────────────────────────────────────────────────────────────────
boot()
  .catch((err) => {
    console.error(err);
    routesStatus.classList.add('error');
    routesStatus.textContent = `Failed: ${err.message}`;
  })
  .finally(() => {
    // After the page is ready, decode any #st=... shared route from the URL.
    tryLoadFromShareHash().catch((err) =>
      console.warn('[share] hash load failed:', err),
    );
  });

async function boot() {
  routesStatus.textContent = 'Loading routes.json…';
  let data;
  try {
    const res = await fetch(ROUTES_JSON_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    throw new Error(
      `Could not load ${ROUTES_JSON_URL} (${err.message}). ` +
        `Run \`python scripts/build-routes.py\` to generate it.`,
    );
  }

  const all = Array.isArray(data?.routes) ? data.routes : [];
  if (all.length === 0) throw new Error('routes.json contains no routes');

  // Sort by Data descending; rows without a date sink to the bottom.
  all.sort((a, b) => (b.dateMs ?? -Infinity) - (a.dateMs ?? -Infinity));

  const allBounds = L.latLngBounds([]);
  let drawn = 0;

  for (const entry of all) {
    const key = entry.tourIri || entry.id;
    const li = addRouteToSidebar(entry);
    if (!entry.latlngs || entry.latlngs.length === 0) {
      li.classList.add('failed');
      li.title = entry.error || 'No track data';
      routes.set(key, { entry, listEl: li, dateMs: entry.dateMs ?? null, visible: false });
      continue;
    }

    const numberLabel = formatNumbers(entry);

    // Dark casing + white stroke for readability on top of OSM/hydrography.
    const casing = L.polyline(entry.latlngs, {
      color: '#1a1a1a',
      weight: 3.5,
      opacity: 0.55,
      lineCap: 'round',
      lineJoin: 'round',
    });
    const layer = L.polyline(entry.latlngs, {
      color: '#ffffff',
      weight: 1.75,
      opacity: 1,
      lineCap: 'round',
      lineJoin: 'round',
    });

    const nums = entryNumbers(entry);
    const popupHtml =
      `<strong>${escapeHtml(buildLabel(entry))}</strong><br>` +
      (nums.length ? `${formatNumbersHtml(entry)}<br>` : '') +
      `Route ${entry.id}` +
      (entry.igPost ? `<br><a href="#" class="popup-open-modal" data-route-id="${escapeHtml(key)}">Open IG post</a>` : '');
    layer.bindPopup(popupHtml);
    layer.on('click', () => openRouteModal(key));
    layer.on('popupopen', () => wireUpPopupLinks());

    // Plain-text number overlay (no background) at the route's midpoint.
    let badge = null;
    if (nums.length) {
      const mid = entry.latlngs[Math.floor(entry.latlngs.length / 2)];
      const iconH = 18 * nums.length;
      badge = L.marker(mid, {
        icon: L.divIcon({
          className: 'route-number-icon',
          html: `<span class="route-number-text">${formatNumbersHtml(entry)}</span>`,
          iconSize: [60, iconH],
          iconAnchor: [30, iconH / 2],
        }),
        interactive: true,
        keyboard: false,
      });
      badge.on('click', () => openRouteModal(key));
    }

    casing.addTo(map);
    layer.addTo(map);
    if (badge) badge.addTo(map);
    allBounds.extend(layer.getBounds());

    // POIs from the GPX (entry.pois) are kept on the entry but NOT rendered
    // on the always-visible map — they appear only when the user enters edit
    // mode for this route via the modal's "Editar este traçado" button.

    routes.set(key, {
      entry,
      layer,
      casing,
      badge,
      listEl: li,
      bounds: layer.getBounds(),
      dateMs: entry.dateMs ?? null,
      visible: true,
    });
    drawn++;
  }

  // Default view stays at São Paulo (set above) — don't auto-fit to all routes.
  // Click a sidebar entry to zoom to a specific route.
  setupDateFilter(all);
  // Status oculto no sucesso — só aparece pra "Loading…" e mensagens de erro.
  routesStatus.classList.remove('error');
  routesStatus.textContent = '';
  routesStatus.hidden = true;
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────
function addRouteToSidebar(entry) {
  const key = entry.tourIri || entry.id;
  const li = document.createElement('li');
  li.dataset.routeId = key;
  const numbersHtml = formatNumbersHtml(entry);
  li.innerHTML = `
    <span class="route-number sidebar-badge">${numbersHtml || '·'}</span>
    <div>
      <strong>${escapeHtml(buildLabel(entry))}</strong>
    </div>
  `;
  li.addEventListener('click', () => openRouteModal(key));
  li.addEventListener('mouseenter', () => onRouteRowHover(entry, li, true));
  li.addEventListener('mouseleave', () => onRouteRowHover(entry, li, false));
  routesList.appendChild(li);
  return li;
}

// ─── Sidebar hover preview (highlight on map + floating stats tooltip) ───────
const routeTooltip = document.getElementById('route-tooltip');

function onRouteRowHover(entry, li, hovering) {
  const r = routes.get(entry.tourIri || entry.id);
  if (!r || drawingMode) {
    if (!hovering) hideRouteTooltip();
    return;
  }
  if (hovering) {
    highlightRoute(r);
    showRouteTooltip(entry, li);
  } else {
    unhighlightRoute(r);
    hideRouteTooltip();
  }
}

function highlightRoute(r) {
  if (!r.layer) return;
  // Remember original style once so repeated hovers don't drift.
  if (!r._hoverOrig) {
    r._hoverOrig = {
      color: r.layer.options.color || '#ffffff',
      weight: r.layer.options.weight || 3.5,
    };
  }
  r.layer.setStyle({ color: '#ffb547', weight: 6 });
  if (r.layer.bringToFront) r.layer.bringToFront();
}
function unhighlightRoute(r) {
  if (r.layer && r._hoverOrig) {
    r.layer.setStyle(r._hoverOrig);
  }
}

function showRouteTooltip(entry, li) {
  if (!routeTooltip) return;
  const stats = entry.stats;
  const numberLabel = formatNumbers(entry);
  const km =
    stats?.distMeters != null
      ? `${(stats.distMeters / 1000).toFixed(1).replace('.', ',')} km`
      : '';
  const asc = stats?.ascentMeters != null ? `↑${stats.ascentMeters} m` : '';
  const desc = stats?.descentMeters != null ? `↓${stats.descentMeters} m` : '';
  const statsLine = [km, asc, desc].filter(Boolean).join(' · ');
  const metaLine = [entry.date, numberLabel].filter(Boolean).join(' · ');
  routeTooltip.innerHTML =
    `<strong>${escapeHtml(entry.name || `Route ${entry.id}`)}</strong>` +
    (metaLine ? `<div class="rt-meta">${escapeHtml(metaLine)}</div>` : '') +
    (statsLine ? `<div class="rt-stats">${statsLine}</div>` : '');

  // Position to the LEFT of the sidebar item (sidebar sits on the right edge),
  // vertically centered on the row.
  const rect = li.getBoundingClientRect();
  routeTooltip.style.right = `${Math.max(8, window.innerWidth - rect.left + 8)}px`;
  routeTooltip.style.top = `${rect.top + rect.height / 2}px`;
  routeTooltip.style.left = 'auto';
  routeTooltip.hidden = false;
}
function hideRouteTooltip() {
  if (routeTooltip) routeTooltip.hidden = true;
}

function buildLabel(entry) {
  const date = entry.date || '';
  const name = entry.name || '';
  return [date, name].filter(Boolean).join(' — ') || `Route ${entry.id}`;
}

// Códigos de série atribuídos ao passeio. `formatNumbers` devolve uma string
// junta com ` · ` (contextos de texto puro como nome de arquivo); a variante
// `_Html` escapa cada código e usa `<br>` por padrão, pra empilhar verticalmente
// em badges/popups quando o tour pertence a mais de uma série. Cai pra
// `entry.number` quando o backend ainda não emite `numbers`.
function entryNumbers(entry) {
  return Array.isArray(entry.numbers) && entry.numbers.length
    ? entry.numbers
    : (entry.number?.value ? [entry.number] : []);
}
function formatNumbers(entry) {
  return entryNumbers(entry).map((n) => `${n.source} ${n.value}`).join(' · ');
}
function formatNumbersHtml(entry, sep = '<br>') {
  return entryNumbers(entry)
    .map((n) => escapeHtml(`${n.source} ${n.value}`))
    .join(sep);
}

function focusRoute(id) {
  const r = routes.get(id);
  if (!r || !r.bounds) return;
  document.querySelectorAll('#routes-list li.active').forEach((el) => el.classList.remove('active'));
  r.listEl.classList.add('active');
  map.fitBounds(r.bounds, { padding: [40, 40] });
}

// ─── Date filter ─────────────────────────────────────────────────────────────
function setupDateFilter(entries) {
  const datedMs = entries.map((e) => e.dateMs).filter((d) => Number.isFinite(d));
  if (datedMs.length === 0) return;

  dateMin = Math.min(...datedMs);
  dateMax = Math.max(...datedMs);
  if (dateMin === dateMax) {
    // Pad to a 1-day window so the slider has motion.
    dateMax = dateMin + DAY_MS;
  }

  for (const input of [rangeFrom, rangeTo]) {
    input.min = String(dateMin);
    input.max = String(dateMax);
    input.step = String(DAY_MS);
  }
  rangeFrom.value = String(dateMin);
  rangeTo.value = String(dateMax);

  rangeFrom.addEventListener('input', onRangeChange);
  rangeTo.addEventListener('input', onRangeChange);
  dateReset.addEventListener('click', () => {
    rangeFrom.value = String(dateMin);
    rangeTo.value = String(dateMax);
    onRangeChange();
  });

  // Clicar nos rótulos `from`/`to` abre um date-picker nativo. Mantemos um
  // <input type="date"> oculto por par só pra invocar `showPicker()`; o span
  // continua sendo o que o usuário lê.
  const fromPicker = makeHiddenDatePicker(dateMin, dateMax, (ms) => {
    rangeFrom.value = String(Math.max(dateMin, Math.min(ms, Number(rangeTo.value))));
    onRangeChange();
  });
  const toPicker = makeHiddenDatePicker(dateMin, dateMax, (ms) => {
    rangeTo.value = String(Math.max(Number(rangeFrom.value), Math.min(ms, dateMax)));
    onRangeChange();
  });
  dateFilter.appendChild(fromPicker);
  dateFilter.appendChild(toPicker);
  rangeFromValue.classList.add('clickable-date');
  rangeFromValue.setAttribute('role', 'button');
  rangeFromValue.setAttribute('tabindex', '0');
  rangeToValue.classList.add('clickable-date');
  rangeToValue.setAttribute('role', 'button');
  rangeToValue.setAttribute('tabindex', '0');
  const triggerPicker = (picker, currentMs) => {
    picker.value = toIsoDate(currentMs);
    if (typeof picker.showPicker === 'function') picker.showPicker();
    else picker.focus();   // fallback navegadores antigos: o input fica focável
  };
  rangeFromValue.addEventListener('click', () =>
    triggerPicker(fromPicker, Number(rangeFrom.value)));
  rangeToValue.addEventListener('click', () =>
    triggerPicker(toPicker, Number(rangeTo.value)));

  dateFilter.hidden = false;
  applyDateWindow(dateMin, dateMax);
}

function makeHiddenDatePicker(minMs, maxMs, onPicked) {
  const el = document.createElement('input');
  el.type = 'date';
  el.className = 'date-picker-hidden';
  el.min = toIsoDate(minMs);
  el.max = toIsoDate(maxMs);
  el.addEventListener('change', () => {
    if (!el.value) return;
    const ms = fromIsoDate(el.value);
    if (Number.isFinite(ms)) onPicked(ms);
  });
  return el;
}
// Date <-> "YYYY-MM-DD" em horário local — o input type=date trabalha em
// strings ISO sem timezone, então não usamos toISOString() (que é UTC e
// causaria off-by-one no fuso de SP).
function toIsoDate(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function fromIsoDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

function onRangeChange() {
  let from = Number(rangeFrom.value);
  let to = Number(rangeTo.value);
  if (from > to) {
    // Push the inactive thumb out of the way.
    if (document.activeElement === rangeFrom) {
      to = from;
      rangeTo.value = String(to);
    } else {
      from = to;
      rangeFrom.value = String(from);
    }
  }
  applyDateWindow(from, to);
}

function applyDateWindow(from, to) {
  rangeFromValue.textContent = formatDay(from);
  rangeToValue.textContent = formatDay(to);

  let visible = 0;
  for (const r of routes.values()) {
    // Undated routes (often older imports without a Data column entry — many
    // BP/BT/S-only rides) can't be placed on the timeline, so always show
    // them rather than silently hiding them.
    const inRange =
      r.dateMs == null ? true : r.dateMs >= from && r.dateMs <= to + DAY_MS - 1;
    setRouteVisible(r, inRange);
    if (inRange) visible++;
  }

  // Propaga a mesma janela pras fotos. `to + DAY_MS - 1` inclui o dia
  // inteiro do limite superior (mesma convenção das rotas).
  photoDateWindow = { from, to: to + DAY_MS - 1 };
  applyPhotoVisibility();

}

// ─── Loaded-routes pseudo-layer (visibility + opacity from layer panel) ──────
// Per-route on-map-ness is the AND of two booleans:
//   r.visible            — set by the date filter
//   routesGloballyVisible — set by the master checkbox in the layer panel
// Opacity is scaled by routesOpacityPct (0..100) over baseline values.
const ROUTE_OPACITY_BASE = { casing: 0.55, layer: 1.0, badge: 1.0 };
let routesGloballyVisible = true;
let routesOpacityPct = 100;

function setRouteVisible(r, visible) {
  if (r.visible === visible) return;
  r.visible = visible;
  r.listEl.classList.toggle('hidden-by-filter', !visible);
  applyRouteOnMap(r);
}

function applyRouteOnMap(r) {
  const onMap = r.visible && routesGloballyVisible;
  const add = (l) => l && !map.hasLayer(l) && l.addTo(map);
  const drop = (l) => l && map.hasLayer(l) && map.removeLayer(l);
  if (onMap) {
    add(r.casing); add(r.layer); add(r.badge);
  } else {
    drop(r.casing); drop(r.layer); drop(r.badge);
  }
}

function setRoutesGloballyVisible(visible) {
  routesGloballyVisible = visible;
  for (const r of routes.values()) applyRouteOnMap(r);
}

function applyRoutesOpacity(pct) {
  routesOpacityPct = pct;
  const f = pct / 100;
  for (const r of routes.values()) {
    if (r.casing) r.casing.setStyle({ opacity: ROUTE_OPACITY_BASE.casing * f });
    if (r.layer) r.layer.setStyle({ opacity: ROUTE_OPACITY_BASE.layer * f });
    if (r.badge) r.badge.setOpacity(ROUTE_OPACITY_BASE.badge * f);
  }
}

function formatDay(ms) {
  const d = new Date(ms);
  // ISO yyyy-mm-dd, but localized — use toLocaleDateString for friendliness.
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
}

// ─── Route detail modal (with human-friendly summary + edit) ────────────────
const routeModal = document.getElementById('route-modal');
const routeModalTitle = document.getElementById('route-modal-title');
const routeModalMeta = document.getElementById('route-modal-meta');
const routeModalSummary = document.getElementById('route-modal-ig');  // legacy id, repurposed
const routeModalClose = document.getElementById('route-modal-close');

routeModalClose.addEventListener('click', closeRouteModal);
routeModal.addEventListener('click', (e) => {
  if (e.target === routeModal) closeRouteModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !routeModal.hidden) closeRouteModal();
});

// Extrai o curtoID do passeio (sufixo após `phd:tour_` ou IRI completa).
function _tourIdFromIri(iri) {
  if (!iri) return null;
  const PHD = 'https://pedalhidrografi.co/data/';
  const PFX_SHORT = 'phd:tour_';
  const PFX_LONG  = PHD + 'tour_';
  if (iri.startsWith(PFX_SHORT)) return iri.slice(PFX_SHORT.length);
  if (iri.startsWith(PFX_LONG))  return iri.slice(PFX_LONG.length);
  return null;
}

// Constrói uma view legível do passeio: lê tours.ttl, resolve o IRI alvo e
// seus blank nodes (route reference, energy values) e dependentes (associações
// → série+edição), mapeia pessoas/séries pra nomes via declarações no próprio
// arquivo e devolve HTML pronto pra render no modal.
async function _renderTourSummary(tourId) {
  const PH    = 'https://pedalhidrografi.co/terms#';
  const PHD   = 'https://pedalhidrografi.co/data/';
  const SCHEMA = 'https://schema.org/';
  const DCT   = 'http://purl.org/dc/terms/';
  const RDFT  = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
  const PROV  = 'http://www.w3.org/ns/prov#';
  const PAV   = 'http://purl.org/pav/';
  const QUDT  = 'http://qudt.org/schema/qudt/';

  let Parser;
  try {
    Parser = await ensureN3();
  } catch (e) {
    return `<p class="muted">Parser N3 indisponível: ${escapeHtml(e.message)}.</p>`;
  }
  let text;
  try {
    const res = await fetch('./data/tours.ttl', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (e) {
    return `<p class="muted">tours.ttl indisponível: ${escapeHtml(e.message)}.</p>`;
  }

  const tourIri = `${PHD}tour_${tourId}`;
  const subjBy = new Map();  // subject IRI/bnode-id → array of quads
  const types = new Map();   // subject → Set of types
  const labels = new Map();  // subject → human label (name/title/code)
  try {
    for (const q of new Parser().parse(text)) {
      const s = q.subject.value, p = q.predicate.value, o = q.object.value;
      if (!subjBy.has(s)) subjBy.set(s, []);
      subjBy.get(s).push(q);
      if (p === RDFT) {
        if (!types.has(s)) types.set(s, new Set());
        types.get(s).add(o);
      } else if (p === SCHEMA + 'alternateName' || p === SCHEMA + 'name'
                 || p === DCT + 'title') {
        if (!labels.has(s)) labels.set(s, o);
      }
    }
  } catch (e) {
    return `<p class="muted">Parser falhou: ${escapeHtml(e.message)}.</p>`;
  }
  const own = subjBy.get(tourIri) || [];
  if (!own.length) {
    return `<p class="muted">Passeio <code>phd:tour_${escapeHtml(tourId)}</code> não encontrado.</p>`;
  }

  function nameOf(iri) {
    if (!iri) return null;
    if (labels.has(iri)) return labels.get(iri);
    // Fallback: parte após o último separador.
    return iri.replace(/^.*[#/]/, '');
  }

  // Coleta valores agrupados por predicado.
  const get = (pred, kind = 'lit') => {
    const out = [];
    for (const q of own) {
      if (q.predicate.value !== pred) continue;
      if (kind === 'iri' && q.object.termType !== 'NamedNode') continue;
      if (kind === 'lit' && q.object.termType !== 'Literal') continue;
      if (kind === 'bn'  && q.object.termType !== 'BlankNode') continue;
      out.push(q.object.value);
    }
    return out;
  };
  const first = (pred, kind = 'lit') => get(pred, kind)[0] || null;
  const bnodeProps = (bn) => {
    const m = new Map();
    for (const q of subjBy.get(bn) || []) m.set(q.predicate.value, q.object.value);
    return m;
  };

  const title       = first(DCT + 'title');
  const date        = first(DCT + 'date');
  const description = first(DCT + 'description');
  const instagram   = first(PH + 'linkInstagram');
  const announce    = first(SCHEMA + 'image', 'iri') || first(SCHEMA + 'image');
  const attendees   = first(PH + 'countAttendee');
  const newcomers   = first(PH + 'countNewcomer');
  const departed    = first(PH + 'departedAt');
  const arrived     = first(PH + 'arrivedAt');
  const moving      = first(PH + 'movingDuration');
  const hadBonde    = first(PH + 'hadBonde');
  const hadRain     = first(PH + 'hadRain');
  const incidents   = get(PH + 'hadIncident');

  // Série + edição via ph:inSeriesEdition → resolve associações.
  const seriesPairs = [];
  for (const assocIri of get(PH + 'inSeriesEdition', 'iri')) {
    const m = bnodeProps(assocIri);
    const evIri = m.get(PH + 'inEventSeries');
    const seq   = m.get(PH + 'sequenceInSeries');
    if (evIri && seq) {
      seriesPairs.push({
        code: evIri.replace(/^.*[#/]/, ''),
        title: nameOf(evIri),
        n: seq,
      });
    }
  }

  // Rota via blank node ph:linkRoute.
  let route = null;
  const routeBn = first(PH + 'linkRoute', 'bn');
  if (routeBn) {
    const m = bnodeProps(routeBn);
    route = {
      url: m.get(SCHEMA + 'url'),
      provider: m.get(SCHEMA + 'provider'),
    };
  }

  // Energia estimada via blank node ph:energyEstimate (qudt:QuantityValue).
  function readQuantity(pred) {
    const bn = first(pred, 'bn');
    if (!bn) return null;
    const m = bnodeProps(bn);
    const num = m.get(QUDT + 'numericValue');
    const cls = m.get(PH + 'intensityClassification');
    return num ? { value: num, class: cls } : null;
  }
  const energyEst  = readQuantity(PH + 'energyEstimate');
  const energyMeas = readQuantity(PH + 'measuredEnergy');

  // Pessoas (autoras + provedores + participantes + iniciantes).
  // Os dois últimos são listados nominalmente APENAS quando o toggle de
  // privacidade `attendees.list` está ligado em Ajustes. Os triples vivem
  // no TTL independentemente — só a renderização é controlada.
  const authors   = get(PROV + 'wasAttributedTo', 'iri').map(nameOf);
  const providers = get(PAV  + 'providedBy',      'iri').map(nameOf);
  const organizers= get(SCHEMA + 'organizer',     'iri').map(nameOf);
  const showAttendeeList = settings.attendees?.list === true;
  const attendeeList = showAttendeeList ? get(SCHEMA + 'attendee', 'iri').map(nameOf) : [];
  const newcomerList = showAttendeeList ? get(PH + 'hasNewcomer', 'iri').map(nameOf) : [];

  // Helpers de formatação.
  function fmtDate(s) {
    if (!s) return '—';
    // "2024-09-09T20:00:00-03:00" → "09/09/2024 20:00"
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (m) return `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}`;
    return s;
  }
  function fmtDuration(s) {
    if (!s) return '—';
    const m = s.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
    if (!m) return s;
    const h = parseInt(m[1] || '0', 10);
    const mn = parseInt(m[2] || '0', 10);
    const sc = parseInt(m[3] || '0', 10);
    const parts = [];
    if (h) parts.push(`${h}h`);
    if (mn) parts.push(`${mn}min`);
    if (sc && !h) parts.push(`${sc}s`);
    return parts.join(' ') || '0min';
  }
  function row(label, html) {
    return `<dt>${escapeHtml(label)}</dt><dd>${html}</dd>`;
  }

  // Monta o HTML.
  const rows = [];
  if (title) rows.push(row('Título', escapeHtml(title)));
  if (date)  rows.push(row('Quando', escapeHtml(fmtDate(date))));
  if (seriesPairs.length) {
    rows.push(row('Série', seriesPairs.map(s =>
      `<strong>${escapeHtml(s.code)}</strong> ${escapeHtml(s.n)}` +
      (s.title && s.title !== s.code ? ` — ${escapeHtml(s.title)}` : '')
    ).join(' · ')));
  }
  if (organizers.length) rows.push(row('Organização', organizers.map(escapeHtml).join(', ')));
  if (route?.url) {
    const provName = route.provider ? route.provider.replace(/^.*[#/]/, '') : '';
    rows.push(row('Rota',
      `<a href="${escapeHtml(route.url)}" target="_blank" rel="noopener">${escapeHtml(route.url)}</a>` +
      (provName ? ` <span class="muted">(${escapeHtml(provName)})</span>` : '')));
  }
  if (instagram) rows.push(row('Instagram',
    `<a href="${escapeHtml(instagram)}" target="_blank" rel="noopener">${escapeHtml(instagram)}</a>`));
  if (authors.length)   rows.push(row('Autoras',  authors.map(escapeHtml).join(', ')));
  if (providers.length) rows.push(row('Quem subiu', providers.map(escapeHtml).join(', ')));
  if (attendeeList.length) rows.push(row('Participantes', attendeeList.map(escapeHtml).join(', ')));
  if (newcomerList.length) rows.push(row('Iniciantes',    newcomerList.map(escapeHtml).join(', ')));

  // Métricas — só mostra se tiver pelo menos um valor.
  const metricsParts = [];
  if (attendees)  metricsParts.push(`${escapeHtml(attendees)} participantes`);
  if (newcomers)  metricsParts.push(`${escapeHtml(newcomers)} iniciantes`);
  if (energyEst)  metricsParts.push(`~${escapeHtml(energyEst.value)} kJ${energyEst.class ? ` <span class="muted">(${escapeHtml(energyEst.class)})</span>` : ''}`);
  if (metricsParts.length) rows.push(row('Métricas', metricsParts.join(' · ')));

  const realParts = [];
  if (departed) realParts.push(`Partiu ${escapeHtml(fmtDate(departed))}`);
  if (arrived)  realParts.push(`Chegou ${escapeHtml(fmtDate(arrived))}`);
  if (moving)   realParts.push(`Movimento ${escapeHtml(fmtDuration(moving))}`);
  if (energyMeas) realParts.push(`${escapeHtml(energyMeas.value)} kJ medidos`);
  if (hadBonde === 'true') realParts.push('🚇 bonde');
  if (hadRain  === 'true') realParts.push('🌧️ choveu');
  if (realParts.length) rows.push(row('Métricas reais', realParts.join(' · ')));

  if (incidents.length) {
    rows.push(row('Incidentes',
      `<ul class="tour-incidents">${incidents.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`));
  }
  if (description) {
    rows.push(row('Narrativa', `<div class="tour-narrative">${escapeHtml(description).replace(/\n/g, '<br>')}</div>`));
  }

  // Hero do anúncio. URL pode vir como `file:///app/tour_assets/<id>/...`
  // (caminho server-side de scripts antigos) — remapeamos pro path web
  // servido pelo backend (`/tour_assets/...`). URLs http(s) passam direto.
  let announceUrl = announce || null;
  if (announceUrl && announceUrl.startsWith('file:///app/tour_assets/')) {
    announceUrl = './' + announceUrl.slice('file:///app/'.length);
  }
  const heroHtml = announceUrl
    ? `<a class="tour-announce-hero" href="${escapeHtml(announceUrl)}" ` +
      `target="_blank" rel="noopener" title="Abrir imagem em tamanho real">` +
      `<img src="${escapeHtml(announceUrl)}" alt="anúncio" ` +
      `onerror="this.parentElement.style.display='none'"></a>`
    : '';

  return heroHtml + `<dl class="tour-summary">${rows.join('')}</dl>`;
}

function openRouteModal(id) {
  const r = routes.get(id);
  if (!r) return;
  focusRoute(id);

  const entry = r.entry;
  const numberLabel = formatNumbers(entry);
  const tourId = _tourIdFromIri(entry.tourIri);

  routeModalTitle.textContent = buildLabel(entry);

  const metaParts = [];
  if (numberLabel) metaParts.push(`<strong>${escapeHtml(numberLabel)}</strong>`);
  if (entry.date) metaParts.push(escapeHtml(entry.date));
  metaParts.push(
    `<a href="https://ridewithgps.com/routes/${entry.id}" target="_blank" rel="noopener">Open on RideWithGPS ↗</a>`,
  );
  if (Array.isArray(entry.latlngs) && entry.latlngs.length >= 2) {
    metaParts.push(
      `<button type="button" class="linkbtn edit-route-btn">Editar este traçado ✎</button>`,
    );
  }
  if (tourId) {
    metaParts.push(
      `<button type="button" class="linkbtn edit-tour-btn">Editar passeio ✎</button>`,
    );
  }
  routeModalMeta.innerHTML = metaParts.join(' · ');
  routeModalMeta.querySelector('.edit-route-btn')?.addEventListener('click', () => {
    closeRouteModal();
    editEntryInDrawingTool(entry);
  });
  routeModalMeta.querySelector('.edit-tour-btn')?.addEventListener('click', () => {
    openTourModal(tourId);
  });

  // Resumo do passeio: view legível a partir de tours.ttl. Sem tour vinculado,
  // mostra placeholder.
  if (tourId) {
    routeModalSummary.innerHTML = `<p class="muted">carregando…</p>`;
    const reqId = tourId;
    _renderTourSummary(tourId).then((html) => {
      // Evita corrida se o usuário trocou de modal antes da resposta.
      if (_tourIdFromIri(routes.get(id)?.entry?.tourIri) !== reqId) return;
      routeModalSummary.innerHTML = html;
    });
  } else {
    routeModalSummary.innerHTML =
      `<p class="muted">Sem Tour vinculado a esta rota — provavelmente importação legada.</p>`;
  }

  renderRoutePhotos(entry);
  routeModal.hidden = false;
}

function closeRouteModal() {
  routeModal.hidden = true;
  routeModalSummary.innerHTML = '';
  document.getElementById('route-modal-photos').innerHTML = '';
}


// Popup links (rendered in Leaflet popup) need delegation since they're
// detached from the document until popupopen.
function wireUpPopupLinks() {
  document.querySelectorAll('.popup-open-modal').forEach((a) => {
    if (a.dataset.wired) return;
    a.dataset.wired = '1';
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const id = a.dataset.routeId;
      if (id) openRouteModal(id);
    });
  });
}

// ─── Utils ─── (moved to lib/utils.js — imported at the top of this file)

// ─── GPX drawing tool ────────────────────────────────────────────────────────
// Each click is a USER WAYPOINT. Between consecutive waypoints we render a
// path; when the "Rotear via OSM" toggle is on, that path is fetched from the
// OSRM public demo (cycling profile) so the line follows real streets.
// Otherwise the path is a straight segment.
//
// Drag a waypoint to move it — the two segments touching it get re-fetched.
// Undo/Redo walk a snapshot history (waypoint positions + cached paths).
// Save → assembles the full path into a GPX file and downloads it.

const traceBtn = document.getElementById('trace-btn');
const traceControls = document.getElementById('trace-controls');
const traceUndo = document.getElementById('trace-undo');
const traceRedo = document.getElementById('trace-redo');
const traceSave = document.getElementById('trace-save');
const traceCount = document.getElementById('trace-count');   // ausente desde a remoção do label "# pontos"

// The floating panel sits inside the map container, so without this Leaflet
// would treat clicks on its buttons as map clicks and add trackpoints.
L.DomEvent.disableClickPropagation(traceControls);
L.DomEvent.disableScrollPropagation(traceControls);
const traceRoutingMode = document.getElementById('trace-routing-mode');
const traceMetrics = document.getElementById('trace-metrics');

// ─── Physics + simulation parameters ─────────────────────────────────────────
// Per-segment forces:
//   F_roll = Crr × m × g
//   F_aero = 0.5 × ρ × CdA × v²
//   F_grav = m × g × sin(θ)              (θ from elevation/length)
// Rider holds constant power on flat/uphill → solve cubic for v.
// On descent, rider coasts and brakes, capturing ε of the gravity assist as
// extra speed beyond the flat-equivalent: v = v_flat + ε·(v_coast − v_flat).
const G = 9.81;
// Stored as fractions in the params object; surfaced as % in the UI.
const PCT_PARAMS = new Set(['epsilon', 'efficiency', 'slopeFlatThreshold']);
const DEFAULT_PARAMS = {
  mass: 75,                 // kg (rider + bike)
  crr: 0.008,
  cda: 0.5,                 // m² — typical upright tourist
  rho: 1.225,               // kg/m³
  // Three-tier power profile, chosen by gradient (see slopeFlatThreshold).
  powerAscent: 100,         // W when slope > +threshold
  powerFlat: 50,            // W when |slope| ≤ threshold
  powerDescent: 10,         // W when slope < −threshold
  epsilon: 0.10,            // 0..1 — fraction of descent gravity converted to speed
  efficiency: 0.90,         // 0..1 — moving time / total time
  slopeFlatThreshold: 0.01, // 0..1 — ±1% boundary for flat vs. ascent/descent
  // Fonte de elevação: FABDEM (Range fetch de tiles 1°×1°) por padrão; cai
  // pra Open-Meteo se desligado ou se a célula vier nodata/404.
  useFabdem: true,
  // Roteamento "menor energia" (FABDEM + Dijkstra assimétrico):
  energyAlpha: 0.008,       // peso da distância no custo
  energyBeta: 1,            // peso do desnível positivo
  energyEta: 0.2,           // fração do ganho de descida recuperada (0..1)
  energySearchMarginPct: 20, // % de margem em torno da bbox dos endpoints
};

function powerFor(gradient, p) {
  if (gradient > p.slopeFlatThreshold) return p.powerAscent;
  if (gradient < -p.slopeFlatThreshold) return p.powerDescent;
  return p.powerFlat;
}
let params = loadParams();

function loadParams() {
  try {
    const raw = localStorage.getItem('phidro:params:v1');
    if (!raw) return { ...DEFAULT_PARAMS };
    return { ...DEFAULT_PARAMS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_PARAMS };
  }
}
function saveParams() {
  try { localStorage.setItem('phidro:params:v1', JSON.stringify(params)); } catch {}
}

let drawingMode = false;
let defaultSaveName = ''; // pre-populated by GPX import / route-modal edit
let layersWasVisible = false; // remembers panel state across drawing sessions
// Each trackpoint is a user waypoint.
//   pathFromPrev: [[lat,lng], ...] inclusive of both endpoints.
//                 null for the first waypoint.
let trackpoints = [];
let history = [[]];          // snapshots of [{ lat, lng, pathFromPrev }, ...]
let historyIndex = 0;
let draftPolyline = null;
let draftCasing = null;
let pointIdCounter = 0;
// 'straight' | 'cycling' | 'foot' — controls how new segments are computed.
// 'straight' just connects waypoints with a line (the absolute shortest distance).
let routingMode = 'straight';
let pendingRouteSeq = 0;     // increments per OSRM call; lets us discard stale results

traceBtn.addEventListener('click', () => {
  if (!drawingMode) enterDrawingMode();
  else exitDrawingMode();
});
traceSave.addEventListener('click', () => saveAndExit());
traceUndo.addEventListener('click', undo);
traceRedo.addEventListener('click', redo);
traceRoutingMode.addEventListener('change', () => {
  routingMode = traceRoutingMode.value || 'straight';
});

document.addEventListener('keydown', (e) => {
  // Defer to whatever modal is open instead of acting on the drawing tool.
  if (!paramsModal.hidden) {
    if (e.key === 'Escape') paramsModal.hidden = true;
    return;
  }
  const saveModalOpen = document.getElementById('save-modal') && !document.getElementById('save-modal').hidden;
  if (saveModalOpen) return; // its own keydown listener handles Enter / Esc
  if (!drawingMode) return;
  const isMod = e.metaKey || e.ctrlKey;
  if (isMod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
  } else if (e.key === 'Escape') {
    exitDrawingMode();
  }
});

function enterDrawingMode() {
  drawingMode = true;
  document.body.classList.add('drawing');

  for (const r of routes.values()) {
    if (r.casing) r.casing.setStyle({ opacity: 0.15 });
    if (r.layer) {
      r.layer.setStyle({ opacity: 0.25 });
      r.layer.unbindPopup();
      r.layer.off('click');
    }
    if (r.badge) {
      r.badge.setOpacity(0.3);
      r.badge.off('click');
    }
  }

  trackpoints = [];
  history = [[]];
  historyIndex = 0;
  if (draftPolyline) { map.removeLayer(draftPolyline); draftPolyline = null; }
  if (draftCasing)   { map.removeLayer(draftCasing);   draftCasing = null; }

  routingMode = traceRoutingMode.value || 'straight';
  map.on('click', onMapClickInDrawing);
  // Map's default double-click-to-zoom would compete with our "dbl-click line
  // to add a waypoint" gesture, so suspend it for the duration of drawing.
  map.doubleClickZoom.disable();
  // Tuck the layer panel away while drawing so it can't crowd the trace
  // controls. Remember its prior state to restore on exit.
  layersWasVisible = !document.body.classList.contains('layers-hidden');
  if (layersWasVisible) {
    document.body.classList.add('layers-hidden');
    if (layersBtn) layersBtn.setAttribute('aria-pressed', 'false');
  }
  traceBtn.textContent = '✕🗺︎ Cancelar';
  traceBtn.setAttribute('aria-label', 'Cancelar');
  traceBtn.setAttribute('title', 'Cancelar (Esc)');
  traceBtn.setAttribute('aria-pressed', 'true');
  traceControls.hidden = false;
  updateTraceControls();
  updateMetrics();
}

function exitDrawingMode() {
  drawingMode = false;
  document.body.classList.remove('drawing');

  for (const t of trackpoints) map.removeLayer(t.marker);
  trackpoints = [];
  if (draftPolyline) { map.removeLayer(draftPolyline); draftPolyline = null; }
  if (draftCasing)   { map.removeLayer(draftCasing);   draftCasing = null; }
  history = [[]];
  historyIndex = 0;

  for (const [key, r] of routes) {
    const entry = r.entry;
    const numsHtml = formatNumbersHtml(entry);
    if (r.layer) {
      const popupHtml =
        `<strong>${escapeHtml(buildLabel(entry))}</strong><br>` +
        (numsHtml ? `${numsHtml}<br>` : '') +
        `Route ${entry.id}` +
        (entry.igPost
          ? `<br><a href="#" class="popup-open-modal" data-route-id="${escapeHtml(key)}">Open IG post</a>`
          : '');
      r.layer.bindPopup(popupHtml);
      r.layer.on('click', () => openRouteModal(key));
    }
    if (r.badge) r.badge.on('click', () => openRouteModal(key));
  }
  // Restore the route opacity to whatever the layer-panel slider says.
  applyRoutesOpacity(routesOpacityPct);

  map.off('click', onMapClickInDrawing);
  map.doubleClickZoom.enable();
  // Restore the layer panel if drawing mode had hidden it.
  if (layersWasVisible) {
    document.body.classList.remove('layers-hidden');
    if (layersBtn) layersBtn.setAttribute('aria-pressed', 'true');
    layersWasVisible = false;
  }
  traceBtn.textContent = '＋🗺︎ Traçar';
  traceBtn.setAttribute('aria-label', 'Traçar GPX');
  traceBtn.setAttribute('title', 'Traçar GPX');
  traceBtn.removeAttribute('aria-pressed');
  traceControls.hidden = true;
  defaultSaveName = '';
}

async function onMapClickInDrawing(e) {
  const tp = createTrackpoint(e.latlng);
  trackpoints.push(tp);

  // Initial straight path from the previous waypoint (if any).
  if (trackpoints.length > 1) {
    const prev = trackpoints[trackpoints.length - 2];
    tp.pathFromPrev = straightPath(prev.marker.getLatLng(), tp.marker.getLatLng());
  }
  redrawAndMetrics();
  updateTraceControls();

  if (routingMode !== 'straight' && trackpoints.length > 1) {
    const idx = trackpoints.length - 1;
    await refetchPath(idx);
    redrawAndMetrics();
  }
  pushHistory();
}

// Initial state for the new trackpoint can be passed in (used by snapshot
// restore, GPX import, and edit-from-route flows) so the marker is built with
// the right icon up front instead of via a follow-up setIcon call.
function createTrackpoint(latlng, init = {}) {
  const id = ++pointIdCounter;
  const isPoi = !!init.isPoi;
  const sym = init.sym || 'Flag, Blue';
  const name = init.name || '';
  const marker = L.marker(latlng, {
    icon: tpIcon(isPoi, sym),
    draggable: true,
    keyboard: false,
    zIndexOffset: 1000,
  });
  marker._tpId = id;
  marker.on('drag', () => redrawAndMetrics());
  marker.on('dragend', () => onMarkerDragEnd(id));
  marker.on('click', () => openTpPopup(id));
  marker.addTo(map);
  if (name) {
    marker.bindTooltip(name, {
      permanent: true,
      direction: 'right',
      offset: [10, 0],
      className: 'tp-label',
    });
  }
  return { id, marker, pathFromPrev: null, name, isPoi, sym };
}

// Map of POI sym/type values → short Portuguese label rendered as plain text
// next to each POI marker. Covers both Garmin's vocabulary (used by the
// drawing tool) and RWGPS's lowercase types (used by the build script when
// exporting from RWGPS GPX wpts).
const POI_LABEL = {
  // Garmin-style
  'Flag, Blue':     'ponto',
  'Flag, Red':      'ponto',
  'Flag, Green':    'ponto',
  'Pin, Yellow':    'ponto',
  'Pin, Red':       'ponto',
  'Summit':         'pico',
  'Restaurant':     'comida',
  'Drinking Water': 'água',
  'Restroom':       'banheiro',
  'Picnic Area':    'piquenique',
  'Trail Head':     'trilha',
  'Information':    'vista',
  'Bridge':         'ponte',
  'Tunnel':         'túnel',
  'Crossing':       'travessia',
  // RWGPS-style (lowercase) — fallback if sym wasn't translated.
  'water':          'água',
  'summit':         'pico',
  'viewpoint':      'vista',
  'overlook':       'vista',
  'food':           'comida',
  'restroom':       'banheiro',
  'picnic':         'piquenique',
  'parking':        'estac.',
  'bike_shop':      'bike',
  'bike_parking':   'bike',
  'camping':        'camping',
  'lodging':        'hotel',
  'monument':       'monum.',
  'photo':          'foto',
  'shopping':       'loja',
  'transit':        'metrô',
  'first_aid':      'soc.',
  'caution':        'atenção',
  'crossing':       'travessia',
  'generic':        'POI',
  'Dot':            'POI',
};
function symLabel(sym) {
  return POI_LABEL[sym] || POI_LABEL[String(sym || '').toLowerCase()] || 'POI';
}

// RideWithGPS exports always set <sym>Dot</sym> — the actual semantic lives
// in <type> (water / summit / overlook / generic / etc.). Translate that to a
// Garmin-recognized <sym> name so:
//   1) the in-editor icon picks the right emoji, and
//   2) re-saving the GPX produces a sym Garmin Edge devices render natively.
const RWGPS_TYPE_TO_GARMIN_SYM = {
  water:        'Drinking Water',
  food:         'Restaurant',
  restroom:     'Restroom',
  picnic:       'Picnic Area',
  summit:       'Summit',
  overlook:     'Information',
  viewpoint:    'Information',
  parking:      'Pin, Yellow',
  bike_shop:    'Pin, Yellow',
  bike_parking: 'Pin, Yellow',
  camping:      'Pin, Yellow',
  lodging:      'Pin, Yellow',
  monument:     'Pin, Red',
  photo:        'Information',
  shopping:     'Pin, Yellow',
  transit:      'Tunnel',
  first_aid:    'Pin, Red',
  caution:      'Crossing',
  crossing:     'Crossing',
  generic:      'Flag, Blue',
};
function rwgpsToGarminSym(poi) {
  const t = String(poi.type || '').trim().toLowerCase();
  if (t && RWGPS_TYPE_TO_GARMIN_SYM[t]) return RWGPS_TYPE_TO_GARMIN_SYM[t];
  // Garmin-style sym already? Use it. RWGPS's "Dot" alone has no semantic, so
  // fall back to a generic flag in that case.
  if (poi.sym && poi.sym !== 'Dot') return poi.sym;
  return 'Flag, Blue';
}

// Garmin-friendly symbol vocabulary. These names render as native icons on
// Edge cycling computers when present in the GPX <sym> element.
const GARMIN_SYMS = [
  ['Flag, Blue',     'Bandeira azul'],
  ['Flag, Red',      'Bandeira vermelha'],
  ['Flag, Green',    'Bandeira verde'],
  ['Pin, Yellow',    'Pino amarelo'],
  ['Pin, Red',       'Pino vermelho'],
  ['Summit',         'Mirante / pico'],
  ['Restaurant',     'Restaurante'],
  ['Drinking Water', 'Água'],
  ['Restroom',       'Banheiro'],
  ['Picnic Area',    'Piquenique'],
  ['Trail Head',     'Início de trilha'],
  ['Information',    'Informação'],
  ['Bridge',         'Ponte'],
  ['Tunnel',         'Túnel'],
  ['Crossing',       'Travessia'],
];

function tpIcon(isPoi, sym) {
  if (isPoi) {
    return L.divIcon({
      className: 'trackpoint-marker poi',
      html: `<span class="poi-label">(${symLabel(sym)})</span>`,
      iconSize: [90, 16],
      iconAnchor: [45, 8],
    });
  }
  return L.divIcon({
    className: 'trackpoint-marker',
    html: '<div class="trackpoint-dot"></div>',
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

function refreshMarker(tp) {
  tp.marker.setIcon(tpIcon(tp.isPoi, tp.sym));
  // Show the name as a permanent tooltip — handy for POIs especially.
  if (tp.name) {
    if (!tp.marker.getTooltip()) {
      tp.marker.bindTooltip(tp.name, {
        permanent: true,
        direction: 'right',
        offset: [10, 0],
        className: 'tp-label',
      });
    } else {
      tp.marker.setTooltipContent(tp.name);
    }
  } else if (tp.marker.getTooltip()) {
    tp.marker.unbindTooltip();
  }
}

function openTpPopup(id) {
  const tp = trackpoints.find((t) => t.id === id);
  if (!tp) return;

  const root = document.createElement('div');
  root.className = 'tp-popup-body';
  root.innerHTML = `
    <label class="tp-row">
      <span>Nome</span>
      <input type="text" class="tp-name" placeholder="ex.: Mirante do Pacaembu" />
    </label>
    <label class="tp-row tp-checkbox">
      <input type="checkbox" class="tp-poi" />
      <span>POI Garmin (vira &lt;wpt&gt; no GPX)</span>
    </label>
    <label class="tp-row tp-sym-row">
      <span>Símbolo</span>
      <select class="tp-sym"></select>
    </label>
    <div class="tp-actions">
      <button type="button" class="tp-delete">Remover ponto</button>
    </div>
  `;

  const nameInput = root.querySelector('.tp-name');
  const poiCheck = root.querySelector('.tp-poi');
  const symSelect = root.querySelector('.tp-sym');
  const symRow = root.querySelector('.tp-sym-row');
  const deleteBtn = root.querySelector('.tp-delete');

  for (const [code, label] of GARMIN_SYMS) {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = `${label} (${code})`;
    symSelect.appendChild(opt);
  }

  nameInput.value = tp.name || '';
  poiCheck.checked = !!tp.isPoi;
  symSelect.value = tp.sym || 'Flag, Blue';
  symRow.style.display = tp.isPoi ? '' : 'none';

  nameInput.addEventListener('input', () => {
    tp.name = nameInput.value;
    refreshMarker(tp);
  });
  nameInput.addEventListener('change', pushHistory);
  poiCheck.addEventListener('change', () => {
    tp.isPoi = poiCheck.checked;
    symRow.style.display = tp.isPoi ? '' : 'none';
    refreshMarker(tp);
    pushHistory();
  });
  symSelect.addEventListener('change', () => {
    tp.sym = symSelect.value;
    refreshMarker(tp);
    pushHistory();
  });
  deleteBtn.addEventListener('click', () => {
    map.closePopup();
    removeTrackpoint(id);
  });

  L.popup({ closeButton: true, autoClose: false, className: 'tp-popup' })
    .setLatLng(tp.marker.getLatLng())
    .setContent(root)
    .openOn(map);
}

async function removeTrackpoint(id) {
  const idx = trackpoints.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const tp = trackpoints[idx];
  map.removeLayer(tp.marker);
  trackpoints.splice(idx, 1);

  // The trackpoint that used to come *after* the removed one needs a fresh
  // pathFromPrev (or null if it just became the first point).
  if (idx < trackpoints.length) {
    const next = trackpoints[idx];
    if (idx === 0) {
      next.pathFromPrev = null;
    } else {
      const prev = trackpoints[idx - 1];
      next.pathFromPrev = straightPath(prev.marker.getLatLng(), next.marker.getLatLng());
    }
  }
  redrawAndMetrics();
  updateTraceControls();
  if (routingMode !== 'straight' && idx > 0 && idx < trackpoints.length) {
    await refetchPath(idx);
    redrawAndMetrics();
  }
  pushHistory();
}

async function onMarkerDragEnd(id) {
  const idx = trackpoints.findIndex((t) => t.id === id);
  if (idx === -1) return;

  // Always update incoming/outgoing straight fallback first so the line snaps
  // to the new waypoint position immediately.
  if (idx > 0) {
    trackpoints[idx].pathFromPrev = straightPath(
      trackpoints[idx - 1].marker.getLatLng(),
      trackpoints[idx].marker.getLatLng(),
    );
  }
  if (idx < trackpoints.length - 1) {
    trackpoints[idx + 1].pathFromPrev = straightPath(
      trackpoints[idx].marker.getLatLng(),
      trackpoints[idx + 1].marker.getLatLng(),
    );
  }
  redrawAndMetrics();

  if (routingMode !== 'straight') {
    if (idx > 0) await refetchPath(idx);
    if (idx < trackpoints.length - 1) await refetchPath(idx + 1);
    redrawAndMetrics();
  }
  pushHistory();
}

function straightPath(fromLatLng, toLatLng) {
  return [
    [fromLatLng.lat, fromLatLng.lng],
    [toLatLng.lat, toLatLng.lng],
  ];
}

// Re-fetch the routed path arriving at trackpoints[idx] from trackpoints[idx-1].
// Falls back to a straight line on any failure.
async function refetchPath(idx) {
  const tp = trackpoints[idx];
  const prev = trackpoints[idx - 1];
  if (!tp || !prev) return;

  const seq = ++pendingRouteSeq;
  const tpId = tp.id;
  try {
    let path;
    if (routingMode === 'energy' || routingMode === 'energy_road') {
      const subMode = routingMode === 'energy_road' ? 'road' : 'free';
      path = await energyRoute(prev.marker.getLatLng(), tp.marker.getLatLng(), subMode);
    } else {
      path = await osrmRoute(
        prev.marker.getLatLng(),
        tp.marker.getLatLng(),
        routingMode === 'foot' ? 'foot' : 'cycling',
      );
    }
    const stillExists = trackpoints.find((t) => t.id === tpId);
    if (!stillExists || seq !== pendingRouteSeq) return;
    stillExists.pathFromPrev = path;
  } catch (err) {
    console.warn(`Route failed (mode=${routingMode}, idx=${idx}):`, err.message);
    // Keep the straight fallback that was already set.
  }
}

// ─── Roteamento por menor energia (FABDEM + Dijkstra) ────────────────────
// Limite duro do segmento — fora dele o custo do DEM cresce demais e a
// experiência azeda. Acima desta distância cai pra reta.
const ENERGY_MAX_SEGMENT_KM = 2;

let _energyWorker = null;
function getEnergyWorker() {
  if (!_energyWorker) {
    _energyWorker = new Worker('./lib/energy-worker.js');
  }
  return _energyWorker;
}

function runEnergyWorker(payload) {
  const w = getEnergyWorker();
  return new Promise((resolve, reject) => {
    const onmsg = (ev) => {
      const m = ev.data;
      if (m.kind === 'progress') return;
      w.removeEventListener('message', onmsg);
      if (m.kind === 'error') reject(new Error(m.message));
      else resolve(m);
    };
    w.addEventListener('message', onmsg);
    w.postMessage({ kind: 'run', ...payload });
  });
}

// Costura tiles 1°×1° em um Float32Array sobre uma bbox dada. Cells fora
// da cobertura → NaN/mask=0. Devolve { height, mask, H, W }.
async function loadFabdemMosaic(bb) {
  const A = FABDEM_ARCSEC;
  const W = Math.round((bb.east  - bb.west)  / A);
  const H = Math.round((bb.north - bb.south) / A);
  const height = new Float32Array(W * H);
  const mask   = new Uint8Array(W * H);
  height.fill(NaN);

  const eps = 1e-9;
  const latLo = Math.floor(bb.south);
  const latHi = Math.floor(bb.north - eps);
  const lonLo = Math.floor(bb.west);
  const lonHi = Math.floor(bb.east  - eps);

  for (let lat = latLo; lat <= latHi; lat++) {
    for (let lon = lonLo; lon <= lonHi; lon++) {
      const t = await openFabdemTile(lat, lon);
      if (!t) continue;
      const interWest  = Math.max(bb.west,  lon);
      const interEast  = Math.min(bb.east,  lon + 1);
      const interSouth = Math.max(bb.south, lat);
      const interNorth = Math.min(bb.north, lat + 1);
      if (interEast <= interWest || interNorth <= interSouth) continue;
      const [oX, oY] = t.origin;
      const [rX, rY] = t.resolution;
      const wnd = [
        Math.round((interWest  - oX) / rX),
        Math.round((interNorth - oY) / rY),
        Math.round((interEast  - oX) / rX),
        Math.round((interSouth - oY) / rY),
      ];
      const raster = await t.image.readRasters({ window: wnd, interleave: true });
      const rW = wnd[2] - wnd[0];
      const rH = wnd[3] - wnd[1];
      const colOffset = Math.round((interWest - bb.west)    / A);
      const rowOffset = Math.round((bb.north  - interNorth) / A);
      for (let r = 0; r < rH; r++) {
        const mr = rowOffset + r;
        if (mr < 0 || mr >= H) continue;
        for (let c = 0; c < rW; c++) {
          const mc = colOffset + c;
          if (mc < 0 || mc >= W) continue;
          const v = raster[r * rW + c];
          if (Number.isFinite(v) && (t.nodata == null || v !== t.nodata)) {
            const idx = mr * W + mc;
            height[idx] = v;
            mask[idx]   = 1;
          }
        }
      }
    }
  }
  return { height, mask, H, W };
}

// Overpass: ways com highway=* na bbox. Devolve { nodes: Map<id, [lat,lng]>,
// ways: [{ nodes: [id1, id2, …] }] }.
async function fetchOsmRoadsForBbox(bb) {
  const q = `[out:json][timeout:30];
way["highway"](${bb.south},${bb.west},${bb.north},${bb.east});
out body;
>;
out skel qt;`;
  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    body: 'data=' + encodeURIComponent(q),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  if (!res.ok) throw new Error(`Overpass ${res.status}`);
  const data = await res.json();
  const nodes = new Map();
  const ways  = [];
  for (const el of data.elements || []) {
    if (el.type === 'node') nodes.set(el.id, [el.lat, el.lon]);
    else if (el.type === 'way' && Array.isArray(el.nodes)) ways.push({ nodes: el.nodes });
  }
  return { nodes, ways };
}

// Bresenham: pinta (r0,c0)→(r1,c1) na máscara.
function rasterizeLineToMask(mask, W, H, r0, c0, r1, c1) {
  let r = r0, c = c0;
  const dr = Math.abs(r1 - r0), dc = Math.abs(c1 - c0);
  const sr = r0 < r1 ? 1 : -1;
  const sc = c0 < c1 ? 1 : -1;
  let err = dc - dr;
  while (true) {
    if (r >= 0 && r < H && c >= 0 && c < W) mask[r * W + c] = 1;
    if (r === r1 && c === c1) break;
    const e2 = err * 2;
    if (e2 > -dr) { err -= dr; c += sc; }
    if (e2 <  dc) { err += dc; r += sr; }
  }
}

// Constrói a máscara binária do viário (1-célula de largura ≈ 30 m, a
// resolução do FABDEM). Sem dilatação — o caminho fica preso aos eixos
// das vias. O carimbo 3×3 ao redor de seed/goal acontece DEPOIS, em
// energyRoute(), pra garantir que a origem/destino estejam acessíveis
// mesmo que o clique fique a 1 célula do nó OSM mais próximo.
function rasterizeRoads(osm, bb, H, W, A) {
  const mask = new Uint8Array(W * H);
  for (const w of osm.ways) {
    let prev = null;
    for (const id of w.nodes) {
      const ll = osm.nodes.get(id);
      if (!ll) { prev = null; continue; }
      const r = Math.round((bb.north - ll[0]) / A);
      const c = Math.round((ll[1] - bb.west) / A);
      if (prev) rasterizeLineToMask(mask, W, H, prev[0], prev[1], r, c);
      prev = [r, c];
    }
  }
  return mask;
}

// `mode` = 'free' (qualquer célula do DEM) | 'road' (restringe ao viário OSM)
async function energyRoute(fromLatLng, toLatLng, mode = 'free') {
  const distKm = fromLatLng.distanceTo(toLatLng) / 1000;
  if (distKm > ENERGY_MAX_SEGMENT_KM) {
    showToast(`Segmento ${distKm.toFixed(2)} km > ${ENERGY_MAX_SEGMENT_KM} km — usando reta`);
    return straightPath(fromLatLng, toLatLng);
  }

  const margin = Math.max(0, params.energySearchMarginPct / 100);
  let west  = Math.min(fromLatLng.lng, toLatLng.lng);
  let east  = Math.max(fromLatLng.lng, toLatLng.lng);
  let south = Math.min(fromLatLng.lat, toLatLng.lat);
  let north = Math.max(fromLatLng.lat, toLatLng.lat);
  const padLng = Math.max((east  - west)  * margin, 1e-4);
  const padLat = Math.max((north - south) * margin, 1e-4);
  west  -= padLng; east  += padLng;
  south -= padLat; north += padLat;

  const A = FABDEM_ARCSEC;
  const bb = {
    west:  Math.floor(west  / A) * A,
    east:  Math.ceil (east  / A) * A,
    south: Math.floor(south / A) * A,
    north: Math.ceil (north / A) * A,
  };

  await ensureGeoTIFF();
  const dem = await loadFabdemMosaic(bb);
  if (!dem.W || !dem.H) {
    console.warn('[energy] DEM vazio — fallback pra reta');
    return straightPath(fromLatLng, toLatLng);
  }

  // OSM road network (paralelo ao DEM, mesmo bbox).
  let networkMask = null;
  if (mode === 'road') {
    try {
      const osm = await fetchOsmRoadsForBbox(bb);
      if (!osm.ways.length) {
        showToast('Sem viário OSM no bbox — caindo para menor energia livre.');
      } else {
        networkMask = rasterizeRoads(osm, bb, dem.H, dem.W, A);
      }
    } catch (e) {
      console.warn('[energy_road] Overpass falhou:', e.message);
      showToast(`Overpass falhou (${e.message}) — caindo para menor energia livre.`);
    }
  }

  const midLat = (bb.south + bb.north) / 2;
  const EARTH_R = 6378137;
  const dy = A * Math.PI / 180 * EARTH_R;
  const dx = dy * Math.cos(midLat * Math.PI / 180);

  const seedR = Math.max(0, Math.min(dem.H - 1, Math.round((bb.north - fromLatLng.lat) / A)));
  const seedC = Math.max(0, Math.min(dem.W - 1, Math.round((fromLatLng.lng - bb.west) / A)));
  const goalR = Math.max(0, Math.min(dem.H - 1, Math.round((bb.north - toLatLng.lat)   / A)));
  const goalC = Math.max(0, Math.min(dem.W - 1, Math.round((toLatLng.lng - bb.west)    / A)));

  // Garante que seed/goal estão sempre na máscara de viário — senão
  // Dijkstra nunca sai da origem. Pintamos um carimbo 3×3 ao redor de cada.
  if (networkMask) {
    for (const [pr, pc] of [[seedR, seedC], [goalR, goalC]]) {
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = pr + dr, cc = pc + dc;
        if (rr >= 0 && rr < dem.H && cc >= 0 && cc < dem.W) networkMask[rr * dem.W + cc] = 1;
      }
    }
  }

  try {
    const res = await runEnergyWorker({
      height: dem.height, mask: dem.mask,
      networkMask,
      H: dem.H, W: dem.W, dx, dy,
      seedR, seedC, goalR, goalC,
      mode: 'from',
      alpha: params.energyAlpha,
      beta:  params.energyBeta,
      eta:   params.energyEta,
    });
    if (!res.path || !res.path.length) {
      console.warn('[energy] sem caminho — fallback pra reta');
      return straightPath(fromLatLng, toLatLng);
    }
    return Array.from(res.path, (i) => {
      const r = (i / dem.W) | 0;
      const c = i - r * dem.W;
      return [bb.north - (r + 0.5) * A, bb.west + (c + 0.5) * A];
    });
  } catch (e) {
    console.warn('[energy] worker falhou:', e.message);
    return straightPath(fromLatLng, toLatLng);
  }
}

async function osrmRoute(fromLatLng, toLatLng, profile = 'cycling') {
  const url =
    `https://router.project-osrm.org/route/v1/${profile}/` +
    `${fromLatLng.lng},${fromLatLng.lat};${toLatLng.lng},${toLatLng.lat}` +
    `?overview=full&geometries=geojson`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.code !== 'Ok' || !data.routes?.[0]) throw new Error(`OSRM ${data.code || 'no route'}`);
  return data.routes[0].geometry.coordinates.map(([lng, lat]) => [lat, lng]);
}

// Build the visual polyline from current marker positions + cached paths.
// During a drag the dragged waypoint's marker has moved, so the segment(s)
// touching it will look slightly off (the path interior is from the old
// position) — that gets corrected by refetch/straight-path on dragend.
function assembleLatLngs() {
  const latlngs = [];
  for (let i = 0; i < trackpoints.length; i++) {
    const tp = trackpoints[i];
    const wp = tp.marker.getLatLng();
    if (i === 0) {
      latlngs.push(wp);
    } else {
      const path = tp.pathFromPrev;
      if (path && path.length >= 2) {
        for (let j = 1; j < path.length - 1; j++) {
          latlngs.push(L.latLng(path[j][0], path[j][1]));
        }
      }
      latlngs.push(wp);
    }
  }
  return latlngs;
}

function redrawAndMetrics() {
  updateDraftPolyline();
  updateMetrics();
  scheduleElevationFetch();
}

function updateDraftPolyline() {
  const latlngs = assembleLatLngs();
  if (latlngs.length === 0) {
    if (draftPolyline) { map.removeLayer(draftPolyline); draftPolyline = null; }
    if (draftCasing)   { map.removeLayer(draftCasing);   draftCasing = null; }
    return;
  }
  // White line over a dark casing so the trace stays readable on top of any
  // base layer — same scheme as the rendered sidebar routes, for visual
  // consistency between the in-progress draft and the saved result.
  if (!draftPolyline) {
    draftCasing = L.polyline(latlngs, {
      color: '#1a1a1a',
      weight: 7,
      opacity: 0.55,
      lineCap: 'round',
      lineJoin: 'round',
    }).addTo(map);
    draftPolyline = L.polyline(latlngs, {
      color: '#ffffff',
      weight: 3.5,
      opacity: 1,
      lineCap: 'round',
      lineJoin: 'round',
    }).addTo(map);
    // Double-clicking on the line inserts a new waypoint between the two
    // user waypoints whose segment was clicked. Bound on both casing and
    // top stroke since either may capture the event.
    draftPolyline.on('dblclick', onLineDblClick);
    draftCasing.on('dblclick', onLineDblClick);
  } else {
    if (draftCasing) draftCasing.setLatLngs(latlngs);
    draftPolyline.setLatLngs(latlngs);
  }
}

// ─── Double-click on the draft line → insert intermediate POI waypoint ──────
function onLineDblClick(e) {
  L.DomEvent.stop(e);
  if (!drawingMode || trackpoints.length < 2) return;
  const idx = findInsertIndex(e.latlng);
  insertWaypointAt(idx, e.latlng);
}

// Find the index where a new waypoint should be inserted: between the two
// consecutive user waypoints whose great-circle segment is closest to the
// click location. Uses a simple flat-Earth approximation — fine at the
// scales the editor works at.
function findInsertIndex(latlng) {
  let bestIdx = trackpoints.length;
  let bestDist = Infinity;
  for (let i = 0; i < trackpoints.length - 1; i++) {
    const a = trackpoints[i].marker.getLatLng();
    const b = trackpoints[i + 1].marker.getLatLng();
    const d = pointToSegmentDistance(latlng, a, b);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i + 1;
    }
  }
  return bestIdx;
}

function pointToSegmentDistance(p, a, b) {
  const dx = b.lng - a.lng;
  const dy = b.lat - a.lat;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const ddx = p.lng - a.lng, ddy = p.lat - a.lat;
    return Math.sqrt(ddx * ddx + ddy * ddy);
  }
  const t = Math.max(
    0,
    Math.min(1, ((p.lng - a.lng) * dx + (p.lat - a.lat) * dy) / lenSq),
  );
  const cx = a.lng + t * dx;
  const cy = a.lat + t * dy;
  return Math.hypot(p.lng - cx, p.lat - cy);
}

async function insertWaypointAt(idx, latlng) {
  // Plain trackpoint by default — same as a click-to-add. The user can
  // toggle the POI flag in the marker popup if they want.
  const tp = createTrackpoint(latlng);
  trackpoints.splice(idx, 0, tp);

  // Wire pathFromPrev for the inserted waypoint, then rebuild the next one's
  // path (since its previous waypoint is now the inserted one, not its old
  // neighbor).
  if (idx > 0) {
    tp.pathFromPrev = straightPath(
      trackpoints[idx - 1].marker.getLatLng(),
      tp.marker.getLatLng(),
    );
  } else {
    tp.pathFromPrev = null;
  }
  if (idx + 1 < trackpoints.length) {
    const next = trackpoints[idx + 1];
    next.pathFromPrev = straightPath(
      tp.marker.getLatLng(),
      next.marker.getLatLng(),
    );
  }
  redrawAndMetrics();
  updateTraceControls();

  if (routingMode !== 'straight') {
    if (idx > 0) await refetchPath(idx);
    if (idx + 1 < trackpoints.length) await refetchPath(idx + 1);
    redrawAndMetrics();
  }
  pushHistory();
}

function totalDistanceMeters() {
  const latlngs = assembleLatLngs();
  let total = 0;
  for (let i = 1; i < latlngs.length; i++) {
    total += latlngs[i - 1].distanceTo(latlngs[i]); // Leaflet's haversine
  }
  return total;
}

// ─── FABDEM (1°×1° COG tiles hospedadas em telhas.pedalhidrografi.co) ────────
// Range-fetch só dos strips que cobrem cada ponto/bbox. geotiff.js é
// carregado sob demanda do CDN; window.GeoTIFF expõe a API.
const FABDEM_BASE_URL = 'https://telhas.pedalhidrografi.co/fabdem/';
const FABDEM_TILE_DEG = 1;
const FABDEM_ARCSEC   = 1 / 3600;            // ~30 m no equador
const GEOTIFF_URL     = 'https://cdn.jsdelivr.net/npm/geotiff@3.0.5/dist-browser/geotiff.js';

let _geoTiffPromise = null;
async function ensureGeoTIFF() {
  if (!_geoTiffPromise) {
    _geoTiffPromise = (async () => {
      if (!window.GeoTIFF) await loadScript(GEOTIFF_URL);
      return window.GeoTIFF;
    })();
  }
  return _geoTiffPromise;
}

// Convenção do bucket: SW corner, hemisfério antes dos dígitos.
//   lat=-24, lon=-47  →  S24W047_FABDEM_V1-2.tif
function fabdemTileName(lat, lon) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  const la = String(Math.abs(lat)).padStart(2, '0');
  const lo = String(Math.abs(lon)).padStart(3, '0');
  return `${ns}${la}${ew}${lo}_FABDEM_V1-2.tif`;
}

// Cache de tiles abertos. Cada entrada guarda só o IFD (geotiff.js
// adia o fetch de pixels até readRasters).
const _fabdemTileCache = new Map();   // "SXX[E|W]XXX" → { image, origin, resolution, nodata } | null
async function openFabdemTile(latLo, lonLo) {
  const key = `${latLo}_${lonLo}`;
  if (_fabdemTileCache.has(key)) return _fabdemTileCache.get(key);
  const url = FABDEM_BASE_URL + fabdemTileName(latLo, lonLo);
  try {
    const GeoTIFF = await ensureGeoTIFF();
    const tiff   = await GeoTIFF.fromUrl(url);
    const image  = await tiff.getImage();
    const origin = image.getOrigin();
    const resolution = image.getResolution();
    const nodataRaw = image.fileDirectory.getValue
      ? image.fileDirectory.getValue('GDAL_NODATA')
      : image.fileDirectory.GDAL_NODATA;
    const nodata = nodataRaw ? parseFloat(nodataRaw) : null;
    const entry = { image, origin, resolution, nodata };
    _fabdemTileCache.set(key, entry);
    return entry;
  } catch (e) {
    console.info(`[fabdem] tile (${latLo},${lonLo}) indisponível: ${e.message}`);
    _fabdemTileCache.set(key, null);    // negative cache: don't keep retrying
    return null;
  }
}

// Sample elevation (meters) at lat/lng. Returns null when the tile is
// missing or the cell is nodata. Batched callers should prefer
// `sampleFabdemBatch` to reuse a single window per tile.
async function sampleFabdemAt(lat, lng) {
  const latLo = Math.floor(lat);
  const lonLo = Math.floor(lng);
  const t = await openFabdemTile(latLo, lonLo);
  if (!t) return null;
  const [oX, oY] = t.origin;
  const [rX, rY] = t.resolution;   // rX > 0, rY < 0
  const col = Math.round((lng - oX) / rX);
  const row = Math.round((lat - oY) / rY);
  try {
    const ras = await t.image.readRasters({
      window: [col, row, col + 1, row + 1],
      interleave: true,
    });
    const v = ras[0];
    if (!Number.isFinite(v)) return null;
    if (t.nodata != null && v === t.nodata) return null;
    return v;
  } catch (e) {
    console.warn(`[fabdem] sample ${lat},${lng} falhou: ${e.message}`);
    return null;
  }
}

// Sample many points efficiently: groups by tile and reads one bounding
// window per tile, then indexes each point into the buffer. ~1 HTTP
// range request per tile instead of one per point.
async function sampleFabdemBatch(points /* [[lat, lng], …] */) {
  if (!points.length) return [];
  // Bucket points by their tile.
  const groups = new Map();   // "latLo_lonLo" → { latLo, lonLo, idxs: [origIdx,…] }
  points.forEach(([lat, lng], i) => {
    const latLo = Math.floor(lat);
    const lonLo = Math.floor(lng);
    const k = `${latLo}_${lonLo}`;
    if (!groups.has(k)) groups.set(k, { latLo, lonLo, idxs: [] });
    groups.get(k).idxs.push(i);
  });
  const out = new Array(points.length).fill(null);
  for (const { latLo, lonLo, idxs } of groups.values()) {
    const t = await openFabdemTile(latLo, lonLo);
    if (!t) continue;
    const [oX, oY] = t.origin;
    const [rX, rY] = t.resolution;
    // Bounding pixel window for this group.
    let cMin = Infinity, cMax = -Infinity, rMin = Infinity, rMax = -Infinity;
    const cells = idxs.map(i => {
      const [lat, lng] = points[i];
      const c = Math.round((lng - oX) / rX);
      const r = Math.round((lat - oY) / rY);
      if (c < cMin) cMin = c; if (c > cMax) cMax = c;
      if (r < rMin) rMin = r; if (r > rMax) rMax = r;
      return [i, r, c];
    });
    try {
      const wndW = cMax - cMin + 1;
      const wndH = rMax - rMin + 1;
      const ras = await t.image.readRasters({
        window: [cMin, rMin, cMax + 1, rMax + 1],
        interleave: true,
      });
      for (const [i, r, c] of cells) {
        const v = ras[(r - rMin) * wndW + (c - cMin)];
        if (Number.isFinite(v) && (t.nodata == null || v !== t.nodata)) {
          out[i] = v;
        }
      }
    } catch (e) {
      console.warn(`[fabdem] read window (${latLo},${lonLo}) falhou: ${e.message}`);
    }
  }
  return out;
}

// ─── Elevation (FABDEM por padrão; Open-Meteo como fallback) ─────────────────
// Cached by ~1m-rounded lat,lon so dragging/undo doesn't refetch the same
// point. Up to 100 coords per HTTP call; debounced 400ms after user activity.
const elevationCache = new Map();
let elevationDebounceTimer = null;
let elevationFetchSeq = 0;

function elevKey(lat, lng) {
  return `${lat.toFixed(5)},${lng.toFixed(5)}`;
}

function pathLatLngArray() {
  return assembleLatLngs().map((ll) => [ll.lat, ll.lng]);
}

function scheduleElevationFetch() {
  clearTimeout(elevationDebounceTimer);
  elevationDebounceTimer = setTimeout(async () => {
    const path = pathLatLngArray();
    if (path.length === 0) return;
    const seq = ++elevationFetchSeq;
    await fetchMissingElevations(path, seq);
    if (seq === elevationFetchSeq) updateMetrics();
  }, 400);
}

async function fetchMissingElevations(path, seq) {
  // Collect unique cache keys we don't have.
  const seen = new Set();
  const missing = [];
  for (const [lat, lng] of path) {
    const k = elevKey(lat, lng);
    if (elevationCache.has(k) || seen.has(k)) continue;
    seen.add(k);
    missing.push([lat, lng]);
  }
  if (missing.length === 0) return;

  // Tenta FABDEM primeiro (quando ativo); o que vier null tenta Open-Meteo.
  let stillMissing = missing;
  if (params.useFabdem) {
    try {
      const elevs = await sampleFabdemBatch(missing);
      if (seq !== elevationFetchSeq) return;
      const remaining = [];
      missing.forEach(([la, lo], i) => {
        const e = elevs[i];
        if (Number.isFinite(e)) elevationCache.set(elevKey(la, lo), e);
        else remaining.push([la, lo]);
      });
      stillMissing = remaining;
    } catch (err) {
      console.warn('FABDEM elevation fetch failed:', err.message);
    }
  }
  if (stillMissing.length === 0) return;

  // Open-Meteo (fallback): 1 chamada a cada 100 coords.
  const BATCH = 100;
  for (let i = 0; i < stillMissing.length; i += BATCH) {
    if (seq !== elevationFetchSeq) return;
    const batch = stillMissing.slice(i, i + BATCH);
    const lats = batch.map(([la]) => la.toFixed(5)).join(',');
    const lons = batch.map(([, lo]) => lo.toFixed(5)).join(',');
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lons}`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const elevs = Array.isArray(data.elevation) ? data.elevation : [];
      batch.forEach(([la, lo], j) => {
        const e = elevs[j];
        if (Number.isFinite(e)) elevationCache.set(elevKey(la, lo), e);
      });
    } catch (err) {
      console.warn('Open-Meteo elevation fetch failed:', err.message);
      return;
    }
  }
}

function elevationForPath(path) {
  // Returns { gainMeters, lossMeters, missing } where missing is the count of
  // points without a cached elevation.
  let gain = 0;
  let loss = 0;
  let missing = 0;
  let prev = null;
  for (const [lat, lng] of path) {
    const e = elevationCache.get(elevKey(lat, lng));
    if (!Number.isFinite(e)) {
      missing++;
      continue;
    }
    if (prev != null) {
      const d = e - prev;
      if (d > 0) gain += d;
      else loss += -d;
    }
    prev = e;
  }
  return { gain, loss, missing };
}

// ─── Speed simulation ────────────────────────────────────────────────────────
// Solve  a·v³ + b·v + c = 0  for the positive real root, where
//   a = ½·ρ·CdA   b = m·g·(Crr + sin θ)   c = −P
// On flat/uphill this gives the rider's equilibrium speed. Newton from a
// sensible starting point converges in ~10 iterations.
function solveSpeedAtGradient(power, gradient, p) {
  const a = 0.5 * p.rho * p.cda;
  const b = p.mass * G * (p.crr + gradient);
  const c = -power;
  let v = 5;
  for (let i = 0; i < 60; i++) {
    const f = a * v * v * v + b * v + c;
    const fp = 3 * a * v * v + b;
    if (!Number.isFinite(fp) || Math.abs(fp) < 1e-12) break;
    const dv = f / fp;
    v -= dv;
    if (v < 0.1) v = 0.1;
    if (Math.abs(dv) < 1e-7) break;
  }
  return Math.max(0.5, v);
}

function segmentSpeed(gradient, p) {
  const power = powerFor(gradient, p);
  // Flat / uphill / gentle descent: rider holds the power for that terrain
  // category, solve cubic for equilibrium speed.
  if (gradient >= -p.slopeFlatThreshold) {
    return solveSpeedAtGradient(power, gradient, p);
  }
  // True descent (slope < −threshold): the rider would naturally exceed flat
  // speed. ε controls how much of that excess they actually let happen.
  const vFlat = solveSpeedAtGradient(p.powerFlat, 0, p);
  const vCoast = solveSpeedAtGradient(p.powerDescent, gradient, p);
  if (vCoast <= vFlat) return vFlat;
  return vFlat + p.epsilon * (vCoast - vFlat);
}

// Walk the assembled path one Δh at a time, summing distance, time, and
// per-segment work. Returns null if there's no path yet.
function simulateRide(p) {
  const latlngs = assembleLatLngs();
  if (latlngs.length < 2) return null;

  let totalDist = 0;
  let totalTime = 0;
  let workRoll = 0;
  let workAero = 0;
  let workGravUp = 0;     // strictly positive climbing
  let workGravDown = 0;   // strictly negative (energy returned by gravity, scaled by ε)
  let workRider = 0;      // energy actually expended by the rider
  let elevMissing = 0;
  let totalAscentM = 0;
  let totalDescentM = 0;
  // Time-in-zone breakdown for the tooltip.
  let tAscent = 0, tFlat = 0, tDescent = 0;

  for (let i = 1; i < latlngs.length; i++) {
    const a = latlngs[i - 1];
    const b = latlngs[i];
    const seg = a.distanceTo(b);
    if (seg < 0.5) continue;

    const eA = elevationCache.get(elevKey(a.lat, a.lng));
    const eB = elevationCache.get(elevKey(b.lat, b.lng));
    let dh = 0;
    if (Number.isFinite(eA) && Number.isFinite(eB)) dh = eB - eA;
    else elevMissing++;
    const gradient = dh / seg;

    const v = segmentSpeed(gradient, p);
    const t = seg / v;
    const power = powerFor(gradient, p);

    totalDist += seg;
    totalTime += t;
    workRoll += p.crr * p.mass * G * seg;
    workAero += 0.5 * p.rho * p.cda * v * v * seg;
    workRider += power * t;

    if (dh > 0) {
      workGravUp += p.mass * G * dh;
      totalAscentM += dh;
    } else if (dh < 0) {
      workGravDown += p.epsilon * p.mass * G * dh;
      totalDescentM += -dh;
    }

    if (gradient > p.slopeFlatThreshold) tAscent += t;
    else if (gradient < -p.slopeFlatThreshold) tDescent += t;
    else tFlat += t;
  }

  return {
    distMeters: totalDist,
    timeSec: totalTime,
    avgSpeedMps: totalDist / Math.max(1, totalTime),
    workRollJ: workRoll,
    workAeroJ: workAero,
    workGravUpJ: workGravUp,
    workGravDownJ: workGravDown,
    workRiderJ: workRider,
    timeAscentSec: tAscent,
    timeFlatSec: tFlat,
    timeDescentSec: tDescent,
    ascentM: totalAscentM,
    descentM: totalDescentM,
    elevMissing,
  };
}

function updateMetrics() {
  const sim = simulateRide(params);
  const fmt = (n, d = 1) => n.toFixed(d).replace('.', ',');

  if (!sim) {
    traceMetrics.textContent = `0,00 km · 0,0 kJ`;
    traceMetrics.title = '';
    return;
  }

  const km = sim.distMeters / 1000;
  const avgKmh = (sim.avgSpeedMps * 3600) / 1000;
  const totalKJ = sim.workRiderJ / 1000;
  const wRollKJ = sim.workRollJ / 1000;
  const wAeroKJ = sim.workAeroJ / 1000;
  const wGravUpKJ = sim.workGravUpJ / 1000;
  const wGravDownKJ = sim.workGravDownJ / 1000; // negative
  const movingTimeSec = sim.timeSec;
  const totalTimeSec = movingTimeSec / Math.max(0.01, params.efficiency);
  const haveAllElev = sim.elevMissing === 0;
  const elevHint = haveAllElev ? '' : ' · ↑ carregando';
  const ascDesc = haveAllElev
    ? `↑${sim.ascentM.toFixed(0)} m ↓${sim.descentM.toFixed(0)} m`
    : `↑${sim.ascentM.toFixed(0)}… ↓${sim.descentM.toFixed(0)}…`;
  const thrPct = (params.slopeFlatThreshold * 100).toFixed(1).replace('.', ',');
  const effPct = (params.efficiency * 100).toFixed(0);

  traceMetrics.textContent =
    `${fmt(km, 2)} km · ${ascDesc} · ${formatHMS(movingTimeSec)} mov · ${formatHMS(totalTimeSec)} tot · ${fmt(totalKJ)} kJ${elevHint}`;
  traceMetrics.title =
    `Simulação por segmento.\n` +
    `  Distância:        ${fmt(km, 2)} km\n` +
    `  Subida acumulada: ${sim.ascentM.toFixed(0)} m\n` +
    `  Descida acumulada:${sim.descentM.toFixed(0)} m\n` +
    `  Vel. média (mov): ${fmt(avgKmh)} km/h\n` +
    `\n` +
    `Tempo:\n` +
    `  Movimento:        ${formatHMS(movingTimeSec)}\n` +
    `  Total (efic. ${effPct}%): ${formatHMS(totalTimeSec)}\n` +
    `\n` +
    `Tempo de movimento por terreno (limiar de ±${thrPct}%):\n` +
    `  Subida (${params.powerAscent} W):   ${formatHMS(sim.timeAscentSec)}\n` +
    `  Plano  (${params.powerFlat} W):    ${formatHMS(sim.timeFlatSec)}\n` +
    `  Descida (${params.powerDescent} W): ${formatHMS(sim.timeDescentSec)}\n` +
    `\n` +
    `Trabalho mecânico (kJ):\n` +
    `  Rolamento (Crr=${params.crr}, m=${params.mass} kg):       ${fmt(wRollKJ)}\n` +
    `  Aero      (CdA=${params.cda} m², ρ=${params.rho}):       ${fmt(wAeroKJ)}\n` +
    `  Subida    (m·g·Δh+):                                       ${fmt(wGravUpKJ)}\n` +
    `  Descida   (ε=${(params.epsilon * 100).toFixed(0)}% × m·g·Δh−):                       ${fmt(wGravDownKJ)}\n` +
    `  ────────────────────────────────────\n` +
    `  Energia gasta pelo ciclista:                              ${fmt(totalKJ)} kJ\n` +
    `\n` +
    `Mecânica bruta na roda. Energia metabólica ≈ 4× isto (eficiência humana ~25%).` +
    (sim.elevMissing > 0 ? `\n\n${sim.elevMissing} ponto(s) ainda sem elevação.` : '');
}

// formatHMS() now imported from lib/utils.js

// ─── Params modal ────────────────────────────────────────────────────────────
const paramsBtn = document.getElementById('params-btn');
const paramsModal = document.getElementById('params-modal');
const paramsClose = document.getElementById('params-close');
const paramsReset = document.getElementById('params-reset');
const PARAM_INPUTS = {
  mass:               document.getElementById('param-mass'),
  crr:                document.getElementById('param-crr'),
  cda:                document.getElementById('param-cda'),
  rho:                document.getElementById('param-rho'),
  powerAscent:        document.getElementById('param-power-ascent'),
  powerFlat:          document.getElementById('param-power-flat'),
  powerDescent:       document.getElementById('param-power-descent'),
  epsilon:            document.getElementById('param-epsilon'),
  efficiency:         document.getElementById('param-efficiency'),
  slopeFlatThreshold: document.getElementById('param-slope-threshold'),
  // FABDEM + energy-routing
  energyAlpha:        document.getElementById('param-energy-alpha'),
  energyBeta:         document.getElementById('param-energy-beta'),
  energyEta:          document.getElementById('param-energy-eta'),
  energySearchMarginPct: document.getElementById('param-energy-margin'),
};
const PARAM_CHECKBOXES = {
  useFabdem: document.getElementById('param-use-fabdem'),
};

paramsBtn.addEventListener('click', () => {
  fillParamInputs();
  paramsModal.hidden = false;
});
paramsClose.addEventListener('click', () => (paramsModal.hidden = true));
paramsModal.addEventListener('click', (e) => {
  if (e.target === paramsModal) paramsModal.hidden = true;
});
paramsReset.addEventListener('click', () => {
  params = { ...DEFAULT_PARAMS };
  saveParams();
  fillParamInputs();
  updateMetrics();
});
for (const [key, input] of Object.entries(PARAM_INPUTS)) {
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    if (!Number.isFinite(v)) return;
    params[key] = PCT_PARAMS.has(key) ? Math.max(0, Math.min(1, v / 100)) : v;
    saveParams();
    updateMetrics();
  });
}
for (const [key, input] of Object.entries(PARAM_CHECKBOXES)) {
  input.addEventListener('change', () => {
    params[key] = !!input.checked;
    saveParams();
    updateMetrics();
  });
}

function fillParamInputs() {
  PARAM_INPUTS.mass.value = params.mass;
  PARAM_INPUTS.crr.value = params.crr;
  PARAM_INPUTS.cda.value = params.cda;
  PARAM_INPUTS.rho.value = params.rho;
  PARAM_INPUTS.powerAscent.value = params.powerAscent;
  PARAM_INPUTS.powerFlat.value = params.powerFlat;
  PARAM_INPUTS.powerDescent.value = params.powerDescent;
  PARAM_INPUTS.epsilon.value = (params.epsilon * 100).toFixed(0);
  PARAM_INPUTS.efficiency.value = (params.efficiency * 100).toFixed(0);
  PARAM_INPUTS.slopeFlatThreshold.value = (params.slopeFlatThreshold * 100).toFixed(1);
  PARAM_INPUTS.energyAlpha.value           = params.energyAlpha;
  PARAM_INPUTS.energyBeta.value            = params.energyBeta;
  PARAM_INPUTS.energyEta.value             = params.energyEta;
  PARAM_INPUTS.energySearchMarginPct.value = params.energySearchMarginPct;
  PARAM_CHECKBOXES.useFabdem.checked       = params.useFabdem !== false;
}

// ─── Params serialization (JSON-LD with QUDT + schema.org) ───────────────────
// Each parameter is exported as a qudt:Quantity node with a quantityKind and
// unit IRI from the QUDT vocabulary. This makes the file genuine RDF (any
// JSON-LD processor will turn it into RDF triples) while staying valid JSON
// — so old plain-JSON files still load via the same import path.
//
// References:
//   QUDT      https://qudt.org/  (Quantities, Units, Dimensions, and Types)
//   JSON-LD   https://www.w3.org/TR/json-ld11/
//   schema.org for the surrounding provenance metadata.
const QUDT_PROFILE = {
  mass:               { iri: 'totalMass',                      kind: 'kind:Mass',                 unit: 'unit:KiloGM' },
  crr:                { iri: 'rollingResistanceCoefficient',   kind: 'kind:DimensionlessRatio',   unit: 'unit:UNITLESS' },
  cda:                { iri: 'dragArea',                       kind: 'kind:Area',                 unit: 'unit:M2' },
  rho:                { iri: 'airDensity',                     kind: 'kind:MassDensity',          unit: 'unit:KiloGM-PER-M3' },
  powerAscent:        { iri: 'powerAscent',                    kind: 'kind:Power',                unit: 'unit:W' },
  powerFlat:          { iri: 'powerFlat',                      kind: 'kind:Power',                unit: 'unit:W' },
  powerDescent:       { iri: 'powerDescent',                   kind: 'kind:Power',                unit: 'unit:W' },
  epsilon:            { iri: 'descentEnergyRecoveryFraction',  kind: 'kind:DimensionlessRatio',   unit: 'unit:UNITLESS' },
  efficiency:         { iri: 'movingEfficiency',               kind: 'kind:DimensionlessRatio',   unit: 'unit:UNITLESS' },
  slopeFlatThreshold: { iri: 'slopeFlatThreshold',             kind: 'kind:DimensionlessRatio',   unit: 'unit:UNITLESS' },
};

function paramsToJsonLd(p) {
  const doc = {
    '@context': {
      '@vocab':       'https://pedalhidrografi.co/vocab/sim#',
      qudt:           'http://qudt.org/schema/qudt/',
      unit:           'http://qudt.org/vocab/unit/',
      kind:           'http://qudt.org/vocab/quantitykind/',
      schema:         'https://schema.org/',
      xsd:            'http://www.w3.org/2001/XMLSchema#',
      Quantity:       'qudt:Quantity',
      value:          { '@id': 'qudt:value',             '@type': 'xsd:double' },
      unit:           { '@id': 'qudt:unit',              '@type': '@id' },
      quantityKind:   { '@id': 'qudt:hasQuantityKind',   '@type': '@id' },
    },
    '@type': 'CyclingSimulationParameters',
    'schema:dateCreated': new Date().toISOString(),
    'schema:creator': 'Cláudio · ajudante bicigeoenergético sampa',
  };
  for (const [key, prof] of Object.entries(QUDT_PROFILE)) {
    doc[prof.iri] = {
      '@type': 'Quantity',
      quantityKind: prof.kind,
      unit: prof.unit,
      value: p[key],
    };
  }
  return doc;
}

// Accept either a JSON-LD doc (detected by `@context`) or our older plain JSON.
function paramsFromAnyJson(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('JSON inválido');
  if (obj['@context']) {
    const out = { ...DEFAULT_PARAMS };
    for (const [key, prof] of Object.entries(QUDT_PROFILE)) {
      const node = obj[prof.iri];
      if (node && typeof node === 'object' && typeof node.value === 'number') {
        out[key] = node.value;
      }
    }
    return out;
  }
  return { ...DEFAULT_PARAMS, ...obj };
}

const paramsExport = document.getElementById('params-export');
const paramsLoad = document.getElementById('params-load');
const paramsImport = document.getElementById('params-import');

paramsExport.addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(paramsToJsonLd(params), null, 2)], {
    type: 'application/ld+json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `parametros-${new Date().toISOString().slice(0, 10)}.jsonld`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

paramsLoad.addEventListener('click', () => paramsImport.click());

paramsImport.addEventListener('change', () => {
  const file = paramsImport.files?.[0];
  paramsImport.value = ''; // allow re-loading the same file
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      params = paramsFromAnyJson(JSON.parse(reader.result));
      saveParams();
      fillParamInputs();
      updateMetrics();
    } catch (err) {
      alert(`Não foi possível carregar os parâmetros: ${err.message}`);
    }
  };
  reader.readAsText(file);
});


function snapshot() {
  return trackpoints.map((t) => ({
    lat: t.marker.getLatLng().lat,
    lng: t.marker.getLatLng().lng,
    // Clone the path so future mutations don't bleed into history.
    path: t.pathFromPrev ? t.pathFromPrev.map((p) => [p[0], p[1]]) : null,
    name: t.name || '',
    isPoi: !!t.isPoi,
    sym: t.sym || 'Flag, Blue',
  }));
}

function pushHistory() {
  history = history.slice(0, historyIndex + 1);
  history.push(snapshot());
  historyIndex = history.length - 1;
  updateTraceControls();
}

function undo() {
  if (historyIndex <= 0) return;
  historyIndex--;
  restoreSnapshot(history[historyIndex]);
}

function redo() {
  if (historyIndex >= history.length - 1) return;
  historyIndex++;
  restoreSnapshot(history[historyIndex]);
}

function restoreSnapshot(snap) {
  for (const t of trackpoints) map.removeLayer(t.marker);
  trackpoints = [];
  pendingRouteSeq++; // invalidate any in-flight OSRM calls
  for (const s of snap) {
    const tp = createTrackpoint(L.latLng(s.lat, s.lng), {
      name: s.name || '',
      isPoi: !!s.isPoi,
      sym: s.sym || 'Flag, Blue',
    });
    tp.pathFromPrev = s.path ? s.path.map((p) => [p[0], p[1]]) : null;
    trackpoints.push(tp);
  }
  redrawAndMetrics();
  updateTraceControls();
}

function updateTraceControls() {
  traceUndo.disabled = historyIndex <= 0;
  traceRedo.disabled = historyIndex >= history.length - 1;
  if (traceCount) {
    const n = trackpoints.length;
    traceCount.textContent = `${n} ponto${n === 1 ? '' : 's'}`;
  }
}

// Opens the save-name modal; the modal's confirm button does the actual save.
function saveAndExit() {
  if (trackpoints.length < 2) {
    alert('Adicione pelo menos 2 pontos antes de salvar o GPX.');
    return;
  }
  openSaveModal();
}

function performSave(name) {
  const latlngs = assembleLatLngs().map((ll) => [ll.lat, ll.lng]);
  const pois = trackpoints
    .filter((t) => t.isPoi)
    .map((t) => {
      const ll = t.marker.getLatLng();
      return {
        lat: ll.lat,
        lon: ll.lng,
        name: t.name || 'POI',
        sym: t.sym || 'Flag, Blue',
      };
    });
  // Snapshot of the user's editable waypoints (lat/lng + name/POI/sym),
  // independent from the routed track. Embedded in extensions so re-editing
  // round-trips cleanly without inflating the visible marker count.
  const userWaypoints = trackpoints.map((t) => {
    const ll = t.marker.getLatLng();
    return {
      lat: ll.lat,
      lng: ll.lng,
      name: t.name || '',
      isPoi: !!t.isPoi,
      sym: t.sym || 'Flag, Blue',
    };
  });
  const ts = new Date();
  const gpx = buildGpx(latlngs, name, pois, {
    paramsJsonLd: paramsToJsonLd(params),
    userWaypoints,
    routingMode,
  });
  const blob = new Blob([gpx], { type: 'application/gpx+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filenameFromName(name, ts);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  exitDrawingMode();
}

function filenameFromName(name, ts) {
  const slug = (name || 'tracado')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'tracado';
  return `${slug}-${ts.toISOString().slice(0, 10)}.gpx`;
}

// Custom XML namespace for our GPX extensions block. Other tools (Garmin,
// Strava, RWGPS) will silently ignore unknown namespaces per the GPX spec.
const PHIDRO_NS = 'https://pedalhidrografi.co/ns/gpx/1.0';

// ─── Sharable-URL state (gzipped JSON in the hash fragment) ──────────────────
// Encodes the current trackpoints + routing mode into a tiny URL that, when
// opened, repopulates the editor with the same draft. Hash fragment so it
// stays client-side (no server logs, no CDN caching).
const SHARE_STATE_VERSION = 1;

function snapshotForShare(name) {
  return {
    v: SHARE_STATE_VERSION,
    rm: routingMode,
    n: name || '',
    wp: trackpoints.map((t) => {
      const ll = t.marker.getLatLng();
      const lat = +ll.lat.toFixed(5);
      const lng = +ll.lng.toFixed(5);
      const out = [lat, lng];
      // Append name/POI/sym only if non-default to keep the payload small.
      if (t.name || t.isPoi) {
        out.push(t.name || '');
        out.push(t.isPoi ? 1 : 0);
        if (t.isPoi && t.sym && t.sym !== 'Flag, Blue') out.push(t.sym);
      }
      return out;
    }),
  };
}

async function gzipB64Url(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = '';
  // String.fromCharCode in chunks to avoid call-stack overflow on large arrays.
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function gzipB64UrlDecode(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

async function buildShareUrl(name) {
  const state = snapshotForShare(name);
  const json = JSON.stringify(state);
  const compressed = await gzipB64Url(json);
  const base = location.href.split('#')[0];
  return `${base}#st=${compressed}`;
}

async function tryLoadFromShareHash() {
  if (!('CompressionStream' in window)) return false;
  const hashParams = new URLSearchParams(location.hash.replace(/^#/, ''));
  const encoded = hashParams.get('st');
  if (!encoded) return false;

  try {
    const json = await gzipB64UrlDecode(encoded);
    const state = JSON.parse(json);
    if (!state || !Array.isArray(state.wp) || state.wp.length === 0) return false;

    if (!drawingMode) enterDrawingMode();
    for (const t of trackpoints) map.removeLayer(t.marker);
    trackpoints = [];
    pendingRouteSeq++;

    if (state.rm && ['straight', 'cycling', 'foot', 'energy', 'energy_road'].includes(state.rm)) {
      routingMode = state.rm;
      traceRoutingMode.value = state.rm;
    }

    for (let i = 0; i < state.wp.length; i++) {
      const wp = state.wp[i];
      const [lat, lng, name = '', isPoi = 0, sym] = wp;
      const tp = createTrackpoint(L.latLng(lat, lng), {
        name: name || '',
        isPoi: !!isPoi,
        sym: sym || (isPoi ? 'Flag, Blue' : 'Flag, Blue'),
      });
      if (i > 0) {
        tp.pathFromPrev = straightPath(
          trackpoints[i - 1].marker.getLatLng(),
          tp.marker.getLatLng(),
        );
      }
      trackpoints.push(tp);
    }

    if (state.n) defaultSaveName = state.n;
    // Strip the #st=… so a later page reload doesn't clobber edits with the
    // original shared route. The state lives in localStorage / drawing
    // session memory now; the URL has done its job.
    history.replaceState(null, '', location.pathname + location.search);
    redrawAndMetrics();
    updateTraceControls();

    const bounds = L.latLngBounds(trackpoints.map((t) => t.marker.getLatLng()));
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40] });

    if (routingMode !== 'straight') {
      // Up to 4 OSRM requests in flight at once — keeps within the public
      // demo's rate limit while cutting end-to-end load by ~4× on long routes.
      const indices = Array.from({ length: trackpoints.length - 1 }, (_, i) => i + 1);
      await mapConcurrent(indices, 4, refetchPath);
      redrawAndMetrics();
    }
    pushHistory();

    showToast(`Link compartilhado carregado · ${trackpoints.length} pontos`);
    return true;
  } catch (err) {
    console.warn('Share hash decode failed:', err);
    showToast(`Link inválido: ${err.message}`);
    return false;
  }
}

function buildGpx(latlngs, name, pois = [], extras = {}) {
  const isoNow = new Date().toISOString();
  const wpts = pois
    .map(
      (p) =>
        `  <wpt lat="${p.lat}" lon="${p.lon}">\n` +
        `    <name>${escapeXml(p.name)}</name>\n` +
        `    <sym>${escapeXml(p.sym)}</sym>\n` +
        `    <type>POI</type>\n` +
        `  </wpt>`,
    )
    .join('\n');
  // Inclui <ele> quando a elevação está no cache (FABDEM ou Open-Meteo).
  const trkpts = latlngs.map(([lat, lon]) => {
    const e = elevationCache.get(elevKey(lat, lon));
    if (Number.isFinite(e)) {
      return `      <trkpt lat="${lat}" lon="${lon}"><ele>${e.toFixed(2)}</ele></trkpt>`;
    }
    return `      <trkpt lat="${lat}" lon="${lon}"/>`;
  }).join('\n');

  // Embed our JSON-LD params + user waypoint snapshot as CDATA in extensions.
  let extensions = '';
  if (extras.paramsJsonLd || extras.userWaypoints) {
    const parts = [];
    if (extras.paramsJsonLd) {
      parts.push(
        `      <phidro:params>${cdata(JSON.stringify(extras.paramsJsonLd))}</phidro:params>`,
      );
    }
    if (extras.userWaypoints) {
      parts.push(
        `      <phidro:userWaypoints>${cdata(JSON.stringify(extras.userWaypoints))}</phidro:userWaypoints>`,
      );
    }
    if (extras.routingMode) {
      parts.push(`      <phidro:routingMode>${escapeXml(extras.routingMode)}</phidro:routingMode>`);
    }
    extensions =
      `  <extensions>\n` +
      `    <phidro:meta>\n` +
      parts.join('\n') + '\n' +
      `    </phidro:meta>\n` +
      `  </extensions>\n`;
  }

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<gpx version="1.1" creator="pedalhidrografico"\n` +
    `     xmlns="http://www.topografix.com/GPX/1/1"\n` +
    `     xmlns:phidro="${PHIDRO_NS}">\n` +
    `  <metadata><name>${escapeXml(name)}</name><time>${isoNow}</time></metadata>\n` +
    (wpts ? wpts + '\n' : '') +
    extensions +
    `  <trk>\n` +
    `    <name>${escapeXml(name)}</name>\n` +
    `    <trkseg>\n${trkpts}\n    </trkseg>\n` +
    `  </trk>\n` +
    `</gpx>\n`
  );
}

function cdata(s) {
  // CDATA cannot contain "]]>". JSON values shouldn't, but split defensively.
  return `<![CDATA[${String(s).replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

// ─── Save GPX modal ──────────────────────────────────────────────────────────
const saveModal = document.getElementById('save-modal');
const saveClose = document.getElementById('save-close');
const saveCancel = document.getElementById('save-cancel');
const saveConfirm = document.getElementById('save-confirm');
const saveNameInput = document.getElementById('save-name');
const saveFilenamePreview = document.getElementById('save-filename-preview');

function openSaveModal() {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  saveNameInput.value = defaultSaveName || `Traçado ${stamp}`;
  updateFilenamePreview();
  saveModal.hidden = false;
  setTimeout(() => {
    saveNameInput.focus();
    saveNameInput.select();
  }, 0);
}
function closeSaveModal() { saveModal.hidden = true; }

saveClose.addEventListener('click', closeSaveModal);
saveCancel.addEventListener('click', closeSaveModal);
saveModal.addEventListener('click', (e) => {
  if (e.target === saveModal) closeSaveModal();
});
saveNameInput.addEventListener('input', updateFilenamePreview);
saveNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); doSave(); }
  if (e.key === 'Escape') closeSaveModal();
});
saveConfirm.addEventListener('click', doSave);

// "Copiar link" / "QR" — encode current trackpoints into a sharable URL.
const saveCopyLink = document.getElementById('save-copy-link');
const saveQrBtn = document.getElementById('save-qr');

async function currentShareUrl() {
  if (!('CompressionStream' in window)) {
    alert('Seu navegador não suporta o link compartilhável (precisa de CompressionStream).');
    return null;
  }
  if (trackpoints.length < 2) {
    alert('Adicione pelo menos 2 pontos antes de gerar o link.');
    return null;
  }
  return buildShareUrl(saveNameInput.value.trim());
}

saveCopyLink?.addEventListener('click', async () => {
  if (!('CompressionStream' in window)) {
    alert('Seu navegador não suporta o link compartilhável (precisa de CompressionStream).');
    return;
  }
  if (trackpoints.length < 2) {
    alert('Adicione pelo menos 2 pontos antes de gerar o link.');
    return;
  }
  try {
    const url = await currentShareUrl();
    if (!url) return;
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(url);
      showToast(`Link copiado · ${url.length} caracteres`);
    } else {
      // Fallback: prompt window with the URL pre-selected for manual copy.
      window.prompt('Copie o link:', url);
    }
  } catch (err) {
    alert(`Falha ao gerar link: ${err.message}`);
  }
});

// ─── QR-code modal ───────────────────────────────────────────────────────────
const qrModal = document.getElementById('qr-modal');
const qrClose = document.getElementById('qr-close');
const qrImage = document.getElementById('qr-image');
const qrWarning = document.getElementById('qr-warning');
const qrUrlInput = document.getElementById('qr-url');
const qrCopyBtn = document.getElementById('qr-copy');
const qrDownloadSvgBtn = document.getElementById('qr-download-svg');
const qrDownloadPngBtn = document.getElementById('qr-download-png');

let qrCurrentSvg = null;
let qrCurrentUrl = '';

saveQrBtn?.addEventListener('click', async () => {
  if (typeof qrcode === 'undefined') {
    alert('Biblioteca de QR não carregou — verifique conexão.');
    return;
  }
  const url = await currentShareUrl();
  if (!url) return;
  showQrModal(url);
});

qrClose?.addEventListener('click', () => (qrModal.hidden = true));
qrModal?.addEventListener('click', (e) => {
  if (e.target === qrModal) qrModal.hidden = true;
});
qrCopyBtn?.addEventListener('click', async () => {
  if (!qrCurrentUrl) return;
  try {
    await navigator.clipboard.writeText(qrCurrentUrl);
    showToast('URL copiada');
  } catch {
    window.prompt('Copie o URL:', qrCurrentUrl);
  }
});
qrDownloadSvgBtn?.addEventListener('click', () => {
  if (!qrCurrentSvg) return;
  downloadBlob(
    new Blob([qrCurrentSvg], { type: 'image/svg+xml' }),
    `qr-${qrFilenameSlug()}.svg`,
  );
});
qrDownloadPngBtn?.addEventListener('click', () => {
  if (!qrCurrentSvg) return;
  svgToPngBlob(qrCurrentSvg, 1024).then((blob) => {
    downloadBlob(blob, `qr-${qrFilenameSlug()}.png`);
  });
});

function showQrModal(url) {
  qrCurrentUrl = url;
  qrUrlInput.value = url;

  // Pick error correction by URL length: shorter URLs can afford H (more
  // robust to camera blur), longer ones need L just to fit.
  let ec = 'H';
  if (url.length > 350) ec = 'Q';
  if (url.length > 700) ec = 'M';
  if (url.length > 1100) ec = 'L';

  // typeNumber=0 → auto-pick smallest version that fits.
  const qr = qrcode(0, ec);
  qr.addData(url);
  qr.make();

  // 4-px cells with 4-cell quiet zone, scalable so the SVG fills the box.
  qrCurrentSvg = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
  qrImage.innerHTML = qrCurrentSvg;

  if (url.length > 1500) {
    qrWarning.textContent =
      `URL longa (${url.length} chars) — o QR fica denso e pode falhar ao escanear. Considere reduzir o número de waypoints.`;
    qrWarning.hidden = false;
  } else {
    qrWarning.hidden = true;
  }

  qrModal.hidden = false;
}

function qrFilenameSlug() {
  const name = (saveNameInput.value || 'rota').trim();
  return name
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    .slice(0, 50) || 'rota';
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// SVG string → PNG blob via Canvas. Used for the "Baixar PNG" button so the
// QR can be pasted into apps that don't render SVG (some chat clients, IG).
function svgToPngBlob(svgString, size) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, size, size);
      ctx.drawImage(img, 0, 0, size, size);
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('PNG conversion failed'));
      }, 'image/png');
    };
    img.onerror = () => reject(new Error('SVG load failed'));
    // Embed the SVG via data URL — base64 encode to handle UTF-8 safely.
    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgString)));
  });
}

function updateFilenamePreview() {
  saveFilenamePreview.textContent = filenameFromName(saveNameInput.value, new Date());
}
function doSave() {
  const name = (saveNameInput.value || '').trim() || `Traçado ${new Date().toISOString().slice(0,16).replace('T',' ')}`;
  closeSaveModal();
  performSave(name);
}

// ─── Instructions modal ──────────────────────────────────────────────────────
const helpBtn = document.getElementById('help-btn');
const helpModal = document.getElementById('help-modal');
const helpClose = document.getElementById('help-close');
function setHelpOpen(open) {
  if (!helpModal) return;
  helpModal.hidden = !open;
  helpBtn?.setAttribute('aria-pressed', String(open));
}
helpBtn?.addEventListener('click', () => {
  if (helpModal && !helpModal.hidden) {
    setHelpOpen(false);
    return;
  }
  closeOtherMobileDialogs('help');
  setHelpOpen(true);
});
helpClose?.addEventListener('click', () => setHelpOpen(false));
helpModal?.addEventListener('click', (e) => {
  if (e.target === helpModal) setHelpOpen(false);
});

// ─── Edit GPX (load a .gpx into the drawing tool) ────────────────────────────
const editGpxBtn = document.getElementById('edit-gpx-btn');
const editGpxInput = document.getElementById('edit-gpx-input');

editGpxBtn.addEventListener('click', () => editGpxInput.click());
editGpxInput.addEventListener('change', () => {
  const file = editGpxInput.files?.[0];
  editGpxInput.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => loadGpxIntoEditor(String(reader.result));
  reader.readAsText(file);
});

// Pull a sidebar route's polyline straight into the drawing tool so the
// user can edit it without round-tripping through a file. The route's
// stored latlngs are already downsampled to ≤400 points by the build
// script; we further sample them down to ≤MAX_EDIT_WAYPOINTS so the user
// gets a manageable number of draggable handles.
const MAX_EDIT_WAYPOINTS = 100;
async function editEntryInDrawingTool(entry) {
  if (!entry || !Array.isArray(entry.latlngs) || entry.latlngs.length < 2) {
    alert('Este traçado não tem pontos suficientes para editar.');
    return;
  }

  if (!drawingMode) enterDrawingMode();
  for (const t of trackpoints) map.removeLayer(t.marker);
  trackpoints = [];
  pendingRouteSeq++;

  let sampled = entry.latlngs;
  if (entry.latlngs.length > MAX_EDIT_WAYPOINTS) {
    sampled = [];
    const stride = (entry.latlngs.length - 1) / (MAX_EDIT_WAYPOINTS - 1);
    for (let i = 0; i < MAX_EDIT_WAYPOINTS; i++) {
      sampled.push(entry.latlngs[Math.round(i * stride)]);
    }
  }

  // Build the editable list as { lat, lng, name, isPoi, sym }.
  const editable = sampled.map(([lat, lng]) => ({
    lat, lng, name: '', isPoi: false, sym: 'Flag, Blue',
  }));

  // Splice in the route's POIs at the cheapest insertion point so each
  // ends up between the two waypoints it sits closest to on the path.
  for (const poi of entry.pois || []) {
    const wp = {
      lat: poi.lat,
      lng: poi.lng,
      name: poi.name || '',
      isPoi: true,
      sym: rwgpsToGarminSym(poi),
    };
    let bestIdx = editable.length; // default: append at end
    let bestCost = Infinity;
    for (let i = 0; i < editable.length - 1; i++) {
      const a = editable[i], b = editable[i + 1];
      const cost =
        haversine(a.lat, a.lng, wp.lat, wp.lng) +
        haversine(wp.lat, wp.lng, b.lat, b.lng) -
        haversine(a.lat, a.lng, b.lat, b.lng);
      if (cost < bestCost) {
        bestCost = cost;
        bestIdx = i + 1;
      }
    }
    editable.splice(bestIdx, 0, wp);
  }

  for (let i = 0; i < editable.length; i++) {
    const wp = editable[i];
    const tp = createTrackpoint(L.latLng(wp.lat, wp.lng), {
      name: wp.name,
      isPoi: wp.isPoi,
      sym: wp.sym,
    });
    if (i > 0) {
      tp.pathFromPrev = straightPath(
        trackpoints[i - 1].marker.getLatLng(),
        tp.marker.getLatLng(),
      );
    }
    trackpoints.push(tp);
  }
  redrawAndMetrics();
  updateTraceControls();

  const bounds = L.latLngBounds(trackpoints.map((t) => t.marker.getLatLng()));
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40] });

  // Pre-fill the save name with the route's display label.
  defaultSaveName = (
    [entry.date, entry.name].filter(Boolean).join(' — ') || `Route ${entry.id}`
  );
  pushHistory();

  const poiCount = (entry.pois || []).length;
  const poiTag = poiCount
    ? ` (${poiCount} POI${poiCount === 1 ? '' : 's'})`
    : ' · sem POIs no routes.json — rode `python scripts/build-routes.py`';
  showToast(
    `Editando "${entry.name || entry.date || `Route ${entry.id}`}" ` +
      `· ${trackpoints.length} pontos${poiTag}`,
  );
}

// Distance between two lat/lng pairs in meters (haversine, no Leaflet dep).
// haversine() now imported from lib/utils.js

async function loadGpxIntoEditor(gpxText) {
  let doc;
  try {
    doc = new DOMParser().parseFromString(gpxText, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('XML inválido');
  } catch (err) {
    alert(`Não foi possível ler o GPX: ${err.message}`);
    return;
  }

  // 0) Default save name from <metadata><name> if present.
  const metaName = doc.querySelector('metadata > name')?.textContent;
  if (metaName) defaultSaveName = metaName.trim();

  // 1) Extensions (our own format) — restores user waypoints + params
  //    cleanly when the file came from this app.
  const metaEls = doc.getElementsByTagNameNS(PHIDRO_NS, 'meta');
  let savedUserWaypoints = null;
  let savedRoutingMode = null;
  let appliedParams = false;
  if (metaEls.length > 0) {
    const meta = metaEls[0];
    const wpEl = meta.getElementsByTagNameNS(PHIDRO_NS, 'userWaypoints')[0];
    const paramsEl = meta.getElementsByTagNameNS(PHIDRO_NS, 'params')[0];
    const rmEl = meta.getElementsByTagNameNS(PHIDRO_NS, 'routingMode')[0];
    try {
      if (wpEl) savedUserWaypoints = JSON.parse(wpEl.textContent || 'null');
    } catch (e) { console.warn('userWaypoints parse failed:', e); }
    try {
      if (paramsEl) {
        const obj = JSON.parse(paramsEl.textContent || 'null');
        if (obj) {
          params = paramsFromAnyJson(obj);
          saveParams();
          fillParamInputs();
          appliedParams = true;
        }
      }
    } catch (e) { console.warn('embedded params parse failed:', e); }
    if (rmEl) savedRoutingMode = (rmEl.textContent || '').trim();
  }

  // 2) Either restore the user waypoints verbatim, or fall back to sampling
  //    the trkpt list (capped) for third-party GPX files.
  let waypointsToCreate;
  if (savedUserWaypoints && Array.isArray(savedUserWaypoints) && savedUserWaypoints.length > 0) {
    waypointsToCreate = savedUserWaypoints;
  } else {
    const coords = [];
    for (const tag of ['trkpt', 'rtept']) {
      const els = doc.getElementsByTagName(tag);
      for (const p of els) {
        const lat = parseFloat(p.getAttribute('lat'));
        const lng = parseFloat(p.getAttribute('lon'));
        if (Number.isFinite(lat) && Number.isFinite(lng)) coords.push([lat, lng]);
      }
      if (coords.length > 0) break;
    }
    const MAX = 100;
    let sampled = coords;
    if (coords.length > MAX) {
      sampled = [];
      const stride = (coords.length - 1) / (MAX - 1);
      for (let i = 0; i < MAX; i++) sampled.push(coords[Math.round(i * stride)]);
    }
    waypointsToCreate = sampled.map(([lat, lng]) => ({
      lat, lng, name: '', isPoi: false, sym: 'Flag, Blue',
    }));

    // Promote any <wpt> to a POI on the nearest waypoint.
    const wpts = doc.getElementsByTagName('wpt');
    for (const w of wpts) {
      const wlat = parseFloat(w.getAttribute('lat'));
      const wlng = parseFloat(w.getAttribute('lon'));
      if (!Number.isFinite(wlat) || !Number.isFinite(wlng)) continue;
      const nm = w.getElementsByTagName('name')[0]?.textContent || 'POI';
      const sm = w.getElementsByTagName('sym')[0]?.textContent || 'Flag, Blue';
      let bestIdx = -1, bestD = Infinity;
      for (let i = 0; i < waypointsToCreate.length; i++) {
        const wp = waypointsToCreate[i];
        const d = (wp.lat - wlat) ** 2 + (wp.lng - wlng) ** 2;
        if (d < bestD) { bestD = d; bestIdx = i; }
      }
      if (bestIdx >= 0 && bestD < 1e-4) { // ~10m
        waypointsToCreate[bestIdx].isPoi = true;
        waypointsToCreate[bestIdx].name = nm;
        waypointsToCreate[bestIdx].sym = sm;
      } else {
        waypointsToCreate.push({ lat: wlat, lng: wlng, name: nm, isPoi: true, sym: sm });
      }
    }
  }

  if (waypointsToCreate.length === 0) {
    alert('Não encontrei pontos no arquivo GPX.');
    return;
  }

  // 3) Enter drawing mode and instantiate the loaded waypoints.
  if (!drawingMode) enterDrawingMode();
  // Wipe any existing draft from the freshly entered drawing session.
  for (const t of trackpoints) map.removeLayer(t.marker);
  trackpoints = [];

  if (savedRoutingMode && ['straight', 'cycling', 'foot', 'energy', 'energy_road'].includes(savedRoutingMode)) {
    routingMode = savedRoutingMode;
    traceRoutingMode.value = savedRoutingMode;
  }

  for (let i = 0; i < waypointsToCreate.length; i++) {
    const wp = waypointsToCreate[i];
    const tp = createTrackpoint(L.latLng(wp.lat, wp.lng), {
      name: wp.name || '',
      isPoi: !!wp.isPoi,
      sym: wp.sym || 'Flag, Blue',
    });
    if (i > 0) {
      tp.pathFromPrev = straightPath(
        trackpoints[i - 1].marker.getLatLng(),
        tp.marker.getLatLng(),
      );
    }
    trackpoints.push(tp);
  }
  redrawAndMetrics();
  updateTraceControls();

  const bounds = L.latLngBounds(trackpoints.map((t) => t.marker.getLatLng()));
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40] });

  // Re-route in the background if the loaded mode wants OSRM.
  if (routingMode !== 'straight') {
    const indices = Array.from({ length: trackpoints.length - 1 }, (_, i) => i + 1);
    await mapConcurrent(indices, 4, refetchPath);
    redrawAndMetrics();
  }
  pushHistory();

  const bits = [`${trackpoints.length} pontos`];
  if (appliedParams) bits.push('parâmetros aplicados');
  if (savedUserWaypoints) bits.push('waypoints originais restaurados');
  showToast(`GPX carregado · ${bits.join(' · ')}`);
}
