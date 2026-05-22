// Pedal Hidrográfico — "Rotas" page (standalone)
//
// Reads the pre-baked public/routes.json (produced by `npm run build:routes`),
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

// ─── Map ─────────────────────────────────────────────────────────────────────
const map = L.map('map', { zoomControl: true }).setView(SP, 12);

const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);

// Esri World Imagery — free, CORS-friendly. Note y/x order in the URL.
const satellite = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  {
    maxZoom: 19,
    attribution:
      'Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community',
  },
);

const rmsampa = L.tileLayer('https://telhas.pedalhidrografi.co/rmsampa-v2/{z}/{x}/{y}.png', {
  maxZoom: 19,
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
    label: 'Rotas (planilha)',
    defaultVisible: true,
    defaultPct: 100,
    show: () => setRoutesGloballyVisible(true),
    hide: () => setRoutesGloballyVisible(false),
    setOpacity: (frac) => applyRoutesOpacity(frac * 100),
  },
  // Live OSM hydrography + ridges via Overpass. Re-queries on pan/zoom.
  {
    id: 'osm-overpass',
    label: 'Mapa de morros e águas OSM',
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
  // Fotos geotaggeadas (raw_imgs → public/photos.json). Pequenos círculos
  // que abrem o thumbnail num popup ao clicar.
  {
    id: 'photos',
    label: 'Fotos geo',
    defaultVisible: false,
    defaultPct: 100,
    show: () => showPhotos(),
    hide: () => hidePhotos(),
    setOpacity: (frac) => setPhotosOpacity(frac),
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

// ─── Fotos geotag­geadas (raw_imgs → public/photos.json) ─────────────────────
// Cada foto com GPS no EXIF vira um pequeno círculo no mapa; clicar abre um
// popup com o thumbnail. photos.json é carregado preguiçosamente na primeira
// vez que a camada é ligada.
// Manifesto de fotos: primeiro o acervo servido pelo backend em /fotos/
// (mesma origem que o app), com queda para o photos.json local.
const PHOTOS_REMOTE_URL = '/fotos/photos.jsonld';
const PHOTOS_LOCAL_URL = 'photos.json';
let photoMarkers = [];
let photosLoaded = false;
let photosLoading = null;
let photosVisible = false;
let photosOpacity = 1;
// Quando setado ({date, label}), só as fotos daquele pedal ficam visíveis.
let photoRideFilter = null;

// Marcadores de foto de um pedal específico (data ISO AAAA-MM-DD).
function ridePhotos(date) {
  return photoMarkers.filter(
    (m) => m._photo.ride && m._photo.ride.date === date,
  );
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
function photoDivIcon(thumbUrl, bearing, fov, extraClass) {
  const dotClass = 'photo-dot' + (extraClass ? ' ' + extraClass : '');
  const dot = `<div class="${dotClass}" style="background-image:url('${thumbUrl}')"></div>`;
  if (!Number.isFinite(bearing)) {
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
  return L.divIcon({
    className: 'photo-dot-wrap',
    html:
      `<div class="photo-aim" style="width:${SZ}px;height:${SZ}px">` +
      `<svg width="${SZ}" height="${SZ}" viewBox="0 0 ${SZ} ${SZ}">` +
      `<path d="${conePath(C, C, 50, bearing, f)}" class="photo-cone"/>` +
      `</svg>${dot}</div>`,
    iconSize: [SZ, SZ],
    iconAnchor: [C, C],
    popupAnchor: [0, -C],
  });
}

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

// Funde as vozes do manifesto numa lista única de fotos. Hoje o manifesto
// traz uma voz só, então a fold é praticamente a identidade — mas o app
// passa a renderizar SEMPRE por aqui. É a costura onde, nos próximos passos,
// entram a pilha de precedência e a reconciliação por divergência.
function foldVoices(data) {
  // Tolera o formato novo (voices) e o antigo (photos plano).
  const voices =
    data && Array.isArray(data.voices)
      ? data.voices
      : [{ id: 'voice/local', photos: (data && data.photos) || [] }];
  const byId = new Map();
  let n = 0;
  for (const v of voices) {
    for (const ph of v.photos || []) {
      // Fotos são set-valued: união por id; a última voz vence em conflito.
      const key = ph.id || `${v.id}#${n++}`;
      byId.set(key, { ...ph, _voice: v.id });
    }
  }
  return [...byId.values()];
}

async function loadPhotos() {
  if (photosLoaded) return;
  if (photosLoading) {
    await photosLoading;
    return;
  }
  photosLoading = (async () => {
    try {
      let data = null;
      for (const url of [PHOTOS_REMOTE_URL, PHOTOS_LOCAL_URL]) {
        try {
          const res = await fetch(url, { cache: 'no-cache' });
          if (res.ok) {
            data = await res.json();
            break;
          }
        } catch (e) {
          console.warn(`[photos] ${url} indisponível: ${e.message}`);
        }
      }
      if (!data) throw new Error('nenhum manifesto de fotos acessível');
      for (const ph of foldVoices(data)) {
        if (!Number.isFinite(ph.lat) || !Number.isFinite(ph.lng)) continue;
        // Cada foto é um pequeno círculo com o próprio thumbnail dentro.
        const icon = photoDivIcon(ph.thumb || ph.file, ph.bearing, ph.fov, '');
        const m = L.marker([ph.lat, ph.lng], { icon, opacity: photosOpacity });
        m._photo = ph;
        const when = ph.datetime
          ? new Date(ph.datetime).toLocaleString('pt-BR')
          : '';
        const rideLine = ph.ride
          ? `<div class="photo-ride">${escapeHtml(
              [ph.ride.code, ph.ride.name].filter(Boolean).join(' · ') ||
                ph.ride.date,
            )}</div>`
          : '';
        const canDelete = Boolean(DELETE_PHOTO_URL && ph.id);
        const delBtn = canDelete
          ? `<button type="button" class="photo-del-btn">Apagar foto</button>`
          : '';
        m.bindPopup(
          `<div class="photo-popup">` +
            `<img src="${ph.file}" loading="lazy" alt="${escapeHtml(ph.orig || '')}" />` +
            rideLine +
            `<div class="photo-meta">${escapeHtml(ph.orig || '')}` +
            (when ? ` · ${escapeHtml(when)}` : '') +
            (Number.isFinite(ph.alt) ? ` · ${ph.alt} m` : '') +
            (Number.isFinite(ph.bearing)
              ? ` · ${Math.round(ph.bearing)}° ${cardinal(ph.bearing)}`
              : '') +
            `</div>${delBtn}</div>`,
          { maxWidth: 320, className: 'photo-popup-wrap' },
        );
        if (canDelete) {
          m.on('popupopen', (e) => {
            const el = e.popup.getElement();
            const btn = el && el.querySelector('.photo-del-btn');
            if (btn) btn.onclick = () => deleteArchivedPhoto(m);
          });
        }
        photoMarkers.push(m);
      }
      photosLoaded = true;
      console.log(`[photos] ${photoMarkers.length} fotos georreferenciadas`);
    } catch (err) {
      console.warn('[photos] falha ao carregar photos.json:', err);
      showToast(`Falha ao carregar fotos: ${err.message}`);
    }
  })();
  await photosLoading;
}

// Visibilidade efetiva: camada ligada E (sem filtro OU foto do pedal filtrado).
function applyPhotoVisibility() {
  for (const m of photoMarkers) {
    const matches =
      !photoRideFilter ||
      (m._photo.ride && m._photo.ride.date === photoRideFilter.date);
    const shouldShow = photosVisible && matches;
    if (shouldShow && !map.hasLayer(m)) m.addTo(map);
    else if (!shouldShow && map.hasLayer(m)) map.removeLayer(m);
  }
  renderPhotoFilterChip();
}

function showPhotos() {
  photosVisible = true;
  loadPhotos().then(() => {
    if (!photosVisible) return;
    applyPhotoVisibility();
    if (photoMarkers.length === 0) {
      showToast('Nenhuma foto georreferenciada (rode build-photos.py)');
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

// Apaga uma foto do acervo via a função delete-photo (protegida por token).
async function deleteArchivedPhoto(m) {
  const ph = m && m._photo;
  if (!ph || !ph.id || !DELETE_PHOTO_URL) return;
  if (
    !window.confirm(
      `Apagar "${ph.orig || ph.id}" do acervo? Esta ação não pode ser desfeita.`,
    )
  ) {
    return;
  }
  const token = getUploadToken();
  if (!token) return;
  try {
    const res = await fetch(DELETE_PHOTO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Upload-Token': token },
      body: JSON.stringify({ id: ph.id }),
    });
    if (res.status === 403) {
      localStorage.removeItem('phidro:uploadToken');
      throw new Error('token inválido');
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    map.removeLayer(m);
    photoMarkers = photoMarkers.filter((x) => x !== m);
    showToast('Foto apagada do acervo.');
  } catch (err) {
    showToast(`Falha ao apagar: ${err.message}`);
  }
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
    `<button type="button" title="Ver todas as fotos">✕</button>`;
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
  loadPhotos().then(() => {
    const ms = ridePhotos(entry.date);
    if (ms.length === 0) return;
    const head = document.createElement('div');
    head.className = 'route-photos-head';
    head.textContent = `${ms.length} foto${ms.length > 1 ? 's' : ''} deste pedal`;
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

// ─── Envio de fotos pelo usuário (apenas na sessão) ──────────────────────────
// Botão que abre o seletor de arquivos; lê o GPS do EXIF de cada foto no
// próprio navegador e a coloca no mapa. HEIC (iPhone) é convertido em JPEG
// via heic2any. Nada é salvo no servidor — recarregar a página limpa tudo.
// As bibliotecas exifr/heic2any são carregadas sob demanda para não pesar
// o carregamento normal da página.
const EXIFR_URL = 'https://cdn.jsdelivr.net/npm/exifr@7/dist/full.umd.js';
const HEIC2ANY_URL =
  'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';
// URL da Cloud Function que emite URLs assinadas (backend/sign-upload/).
// Deixe '' para manter o envio ao acervo desativado — só o preview local
// fica disponível. Preencha após fazer o deploy da função.
// Backend de fotos. Caminhos relativos: o backend (Raspberry Pi) serve o
// app e a API na mesma origem — sem CORS, sem URL para configurar.
const SIGN_UPLOAD_URL = '/sign-upload';
const DELETE_PHOTO_URL = '/delete-photo';
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
  showToast(`Processando ${files.length} foto(s)…`);
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
  const icon = photoDivIcon(p.url, p.bearing, p.fov, 'photo-dot-upload');
  const m = L.marker([p.lat, p.lng], { icon });
  const when = p.datetime ? new Date(p.datetime).toLocaleString('pt-BR') : '';
  const rideText = p.ride
    ? [p.ride.code, p.ride.name].filter(Boolean).join(' · ') || p.ride.date
    : 'Foto enviada · apenas nesta sessão';
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
    { maxWidth: 320, className: 'photo-popup-wrap' },
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

// Exporta os pontos no formato photos.json para realimentar o repositório.
// O thumbnail real é gerado depois por build-photos.py a partir do original.
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

// Token de envio ao acervo — digitado em runtime, guardado só neste aparelho.
// Nunca fica no código publicado.
function getUploadToken() {
  let t = localStorage.getItem('phidro:uploadToken');
  if (!t) {
    t = (window.prompt('Token de envio ao acervo:') || '').trim();
    if (t) localStorage.setItem('phidro:uploadToken', t);
  }
  return t;
}

// PUT do arquivo para a URL assinada. Usa XMLHttpRequest em vez de fetch:
// o Safari falha de forma intermitente um fetch() com corpo grande entre
// origens ("Load failed" / "network connection lost") — o XHR não tem o bug.
function putToSignedUrl(url, file, contentType) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.timeout = 120000;
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`PUT ${xhr.status}`));
    xhr.onerror = () => reject(new Error('PUT bloqueado (rede/CORS)'));
    xhr.ontimeout = () => reject(new Error('PUT expirou'));
    xhr.send(file);
  });
}

// Envia os originais ao bucket do GCS via URLs assinadas da Cloud Function.
async function uploadToArchive() {
  if (!SIGN_UPLOAD_URL) return;
  const pending = uploadedData.filter((p) => p.file && !p.archived);
  if (pending.length === 0) {
    showToast('Nada novo para enviar ao acervo.');
    return;
  }
  const token = getUploadToken();
  if (!token) return;
  showToast(`Enviando ${pending.length} foto(s) ao acervo…`);
  let ok = 0;
  let fail = 0;
  for (const p of pending) {
    try {
      const ct = fileContentType(p.file);
      const res = await fetch(SIGN_UPLOAD_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Upload-Token': token },
        body: JSON.stringify({
          filename: p.orig,
          contentType: ct,
          ride: p.ride || null,
        }),
      });
      if (res.status === 403) {
        localStorage.removeItem('phidro:uploadToken');
        throw new Error('token inválido');
      }
      if (!res.ok) throw new Error(`assinatura HTTP ${res.status}`);
      const { uploadUrl } = await res.json();
      await putToSignedUrl(uploadUrl, p.file, ct);
      p.archived = true;
      ok++;
    } catch (err) {
      console.warn('[upload] envio ao acervo falhou:', p.orig, err);
      fail++;
    }
  }
  renderUploadChip();
  showToast(`Acervo: ${ok} enviada(s)${fail ? ` · ${fail} com erro` : ''}`);
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
  const archived = uploadedData.filter((p) => p.archived).length;
  let html = `<span>📷 ${uploadedMarkers.length} foto(s)`;
  if (archived) html += ` · ${archived} no acervo`;
  html += `</span>`;
  if (SIGN_UPLOAD_URL) {
    html += `<button type="button" data-act="archive">Enviar ao acervo</button>`;
  }
  html +=
    `<button type="button" data-act="export">Exportar</button>` +
    `<button type="button" data-act="clear">Limpar</button>`;
  chip.innerHTML = html;
  if (SIGN_UPLOAD_URL) {
    chip.querySelector('[data-act="archive"]').onclick = uploadToArchive;
  }
  chip.querySelector('[data-act="export"]').onclick = exportUploadedPhotos;
  chip.querySelector('[data-act="clear"]').onclick = clearUploadedPhotos;
}

const uploadBtn = document.getElementById('upload-btn');
const uploadInput = document.getElementById('photo-upload-input');
uploadBtn?.addEventListener('click', () => uploadInput?.click());
uploadInput?.addEventListener('change', () => {
  handlePhotoUpload(uploadInput.files);
  uploadInput.value = ''; // permite reenviar o mesmo arquivo
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

// ─── State ───────────────────────────────────────────────────────────────────
const routesList = document.getElementById('routes-list');
const routesStatus = document.getElementById('routes-status');
const dateFilter = document.getElementById('date-filter');
const rangeFrom = document.getElementById('range-from');
const rangeTo = document.getElementById('range-to');
const rangeFromValue = document.getElementById('range-from-value');
const rangeToValue = document.getElementById('range-to-value');
const dateReset = document.getElementById('date-reset');

// id → { entry, layer, casing, badge, listEl, bounds, dateMs, visible }
const routes = new Map();
let dateMin = null;
let dateMax = null;

// ─── Layer panel toggle (header button) ──────────────────────────────────────
const layersBtn = document.getElementById('layers-btn');
const LAYERS_HIDDEN_KEY = 'phidro:layersHidden';
function applyLayersVisibility(hidden) {
  document.body.classList.toggle('layers-hidden', hidden);
  if (layersBtn) layersBtn.setAttribute('aria-pressed', String(!hidden));
}
applyLayersVisibility(localStorage.getItem(LAYERS_HIDDEN_KEY) === '1');
layersBtn?.addEventListener('click', () => {
  const nowHidden = !document.body.classList.contains('layers-hidden');
  applyLayersVisibility(nowHidden);
  try { localStorage.setItem(LAYERS_HIDDEN_KEY, nowHidden ? '1' : '0'); } catch {}
});

// ─── Sidebar toggle (mobile drawer + desktop hide) ───────────────────────────
// Two distinct states so behavior matches each viewport:
//   .sidebar-open   — explicit "show now" on mobile (drawer slide-in).
//   .sidebar-hidden — explicit "hide" on desktop (map gets full width).
const menuBtn = document.getElementById('menu-btn');
const SIDEBAR_HIDDEN_KEY = 'phidro:sidebarHidden';
const isMobileViewport = () => window.matchMedia('(max-width: 760px)').matches;

// Restore persisted desktop state on boot.
if (localStorage.getItem(SIDEBAR_HIDDEN_KEY) === '1') {
  document.body.classList.add('sidebar-hidden');
}
updateMenuBtnPressed();

menuBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (isMobileViewport()) {
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

window.addEventListener('resize', updateMenuBtnPressed);

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
        `Run \`npm run build:routes\` to generate it.`,
    );
  }

  const all = Array.isArray(data?.routes) ? data.routes : [];
  if (all.length === 0) throw new Error('routes.json contains no routes');

  // Sort by Data descending; rows without a date sink to the bottom.
  all.sort((a, b) => (b.dateMs ?? -Infinity) - (a.dateMs ?? -Infinity));

  const allBounds = L.latLngBounds([]);
  let drawn = 0;

  for (const entry of all) {
    const li = addRouteToSidebar(entry);
    if (!entry.latlngs || entry.latlngs.length === 0) {
      li.classList.add('failed');
      li.title = entry.error || 'No track data';
      routes.set(entry.id, { entry, listEl: li, dateMs: entry.dateMs ?? null, visible: false });
      continue;
    }

    const numberLabel = entry.number?.value
      ? `${entry.number.source} ${entry.number.value}`
      : '';

    // Dark casing + white stroke for readability on top of OSM/hydrography.
    const casing = L.polyline(entry.latlngs, {
      color: '#1a1a1a',
      weight: 7,
      opacity: 0.55,
      lineCap: 'round',
      lineJoin: 'round',
    });
    const layer = L.polyline(entry.latlngs, {
      color: '#ffffff',
      weight: 3.5,
      opacity: 1,
      lineCap: 'round',
      lineJoin: 'round',
    });

    const popupHtml =
      `<strong>${escapeHtml(buildLabel(entry))}</strong><br>` +
      (numberLabel ? `${escapeHtml(numberLabel)} · ` : '') +
      `Route ${entry.id}` +
      (entry.igPost ? `<br><a href="#" class="popup-open-modal" data-route-id="${entry.id}">Open IG post</a>` : '');
    layer.bindPopup(popupHtml);
    layer.on('click', () => openRouteModal(entry.id));
    layer.on('popupopen', () => wireUpPopupLinks());

    // Plain-text number overlay (no background) at the route's midpoint.
    let badge = null;
    if (numberLabel) {
      const mid = entry.latlngs[Math.floor(entry.latlngs.length / 2)];
      badge = L.marker(mid, {
        icon: L.divIcon({
          className: 'route-number-icon',
          html: `<span class="route-number-text">${escapeHtml(numberLabel)}</span>`,
          iconSize: [60, 18],
          iconAnchor: [30, 9],
        }),
        interactive: true,
        keyboard: false,
      });
      badge.on('click', () => openRouteModal(entry.id));
    }

    casing.addTo(map);
    layer.addTo(map);
    if (badge) badge.addTo(map);
    allBounds.extend(layer.getBounds());

    // POIs from the GPX (entry.pois) are kept on the entry but NOT rendered
    // on the always-visible map — they appear only when the user enters edit
    // mode for this route via the modal's "Editar este traçado" button.

    routes.set(entry.id, {
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
  routesStatus.classList.remove('error');
  routesStatus.textContent = renderStatus(drawn, all.length, data.generatedAt);
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────
function addRouteToSidebar(entry) {
  const li = document.createElement('li');
  li.dataset.routeId = entry.id;
  const numberLabel = entry.number?.value
    ? `${entry.number.source} ${entry.number.value}`
    : '';
  li.innerHTML = `
    <span class="route-number sidebar-badge">${numberLabel ? escapeHtml(numberLabel) : '·'}</span>
    <div>
      <strong>${escapeHtml(buildLabel(entry))}</strong>
    </div>
  `;
  li.addEventListener('click', () => openRouteModal(entry.id));
  li.addEventListener('mouseenter', () => onRouteRowHover(entry, li, true));
  li.addEventListener('mouseleave', () => onRouteRowHover(entry, li, false));
  routesList.appendChild(li);
  return li;
}

// ─── Sidebar hover preview (highlight on map + floating stats tooltip) ───────
const routeTooltip = document.getElementById('route-tooltip');

function onRouteRowHover(entry, li, hovering) {
  const r = routes.get(entry.id);
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
  const numberLabel = entry.number?.value
    ? `${entry.number.source} ${entry.number.value}`
    : '';
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

function renderStatus(drawn, total, generatedAt) {
  const generated = generatedAt
    ? ` · built ${new Date(generatedAt).toLocaleDateString()}`
    : '';
  return `${drawn}/${total} routes${generated}`;
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

  dateFilter.hidden = false;
  applyDateWindow(dateMin, dateMax);
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

  // Keep the existing routesStatus text (count of total drawn) — add a window line.
  const baseStatus = routesStatus.textContent.split(' · in window')[0];
  routesStatus.textContent = `${baseStatus} · in window: ${visible}`;
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

// ─── Route detail modal (with IG embed) ──────────────────────────────────────
const routeModal = document.getElementById('route-modal');
const routeModalTitle = document.getElementById('route-modal-title');
const routeModalMeta = document.getElementById('route-modal-meta');
const routeModalIG = document.getElementById('route-modal-ig');
const routeModalClose = document.getElementById('route-modal-close');

routeModalClose.addEventListener('click', closeRouteModal);
routeModal.addEventListener('click', (e) => {
  if (e.target === routeModal) closeRouteModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !routeModal.hidden) closeRouteModal();
});

function openRouteModal(id) {
  const r = routes.get(id);
  if (!r) return;
  focusRoute(id);

  const entry = r.entry;
  const numberLabel = entry.number?.value
    ? `${entry.number.source} ${entry.number.value}`
    : '';

  routeModalTitle.textContent = buildLabel(entry);

  const metaParts = [];
  if (numberLabel) metaParts.push(`<strong>${escapeHtml(numberLabel)}</strong>`);
  if (entry.date) metaParts.push(escapeHtml(entry.date));
  metaParts.push(
    `<a href="https://ridewithgps.com/routes/${entry.id}" target="_blank" rel="noopener">Open on RideWithGPS ↗</a>`,
  );
  if (Array.isArray(entry.latlngs) && entry.latlngs.length >= 2) {
    metaParts.push(
      `<button type="button" class="linkbtn edit-route-btn" data-route-id="${entry.id}">Editar este traçado ✎</button>`,
    );
  }
  routeModalMeta.innerHTML = metaParts.join(' · ');
  routeModalMeta.querySelector('.edit-route-btn')?.addEventListener('click', () => {
    closeRouteModal();
    editEntryInDrawingTool(entry);
  });

  const ig = parseInstagramUrl(entry.igPost);
  if (ig) {
    routeModalIG.innerHTML = `
      <iframe
        class="ig-embed"
        src="${ig.embedUrl}"
        loading="lazy"
        allow="encrypted-media"
        allowtransparency="true"
        allowfullscreen
        scrolling="auto"
        frameborder="0"></iframe>
    `;
  } else if (entry.igPost) {
    routeModalIG.innerHTML = `
      <p class="muted">Could not parse Instagram URL: <code>${escapeHtml(entry.igPost)}</code></p>
    `;
  } else {
    routeModalIG.innerHTML = `<p class="muted">No Instagram post linked for this route.</p>`;
  }

  renderRoutePhotos(entry);
  routeModal.hidden = false;
}

function closeRouteModal() {
  routeModal.hidden = true;
  routeModalIG.innerHTML = ''; // stop the iframe loading
  document.getElementById('route-modal-photos').innerHTML = '';
}

// Accept full URLs to instagram posts/reels/IGTV; return embed URL.
function parseInstagramUrl(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  // shortcode capture (post types: p, reel, reels, tv)
  const m = s.match(/instagram\.com\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
  if (!m) return null;
  const type = m[1].toLowerCase() === 'reels' ? 'reel' : m[1].toLowerCase();
  const code = m[2];
  return {
    type,
    code,
    url: `https://www.instagram.com/${type}/${code}/`,
    embedUrl: `https://www.instagram.com/${type}/${code}/embed`,
  };
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
const traceCancel = document.getElementById('trace-cancel');
const traceCount = document.getElementById('trace-count');

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
  else saveAndExit();
});
traceCancel.addEventListener('click', () => exitDrawingMode());
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
  traceBtn.textContent = 'Salvar GPX';
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

  for (const r of routes.values()) {
    const entry = r.entry;
    const numberLabel = entry.number?.value
      ? `${entry.number.source} ${entry.number.value}`
      : '';
    if (r.layer) {
      const popupHtml =
        `<strong>${escapeHtml(buildLabel(entry))}</strong><br>` +
        (numberLabel ? `${escapeHtml(numberLabel)} · ` : '') +
        `Route ${entry.id}` +
        (entry.igPost
          ? `<br><a href="#" class="popup-open-modal" data-route-id="${entry.id}">Open IG post</a>`
          : '');
      r.layer.bindPopup(popupHtml);
      r.layer.on('click', () => openRouteModal(entry.id));
    }
    if (r.badge) r.badge.on('click', () => openRouteModal(entry.id));
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
  traceBtn.textContent = 'Traçar GPX';
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
    const path = await osrmRoute(
      prev.marker.getLatLng(),
      tp.marker.getLatLng(),
      routingMode === 'foot' ? 'foot' : 'cycling',
    );
    // Discard if a newer call has been made for the same trackpoint, or if it
    // was undone away by undo/restore.
    const stillExists = trackpoints.find((t) => t.id === tpId);
    if (!stillExists || seq !== pendingRouteSeq) return;
    stillExists.pathFromPrev = path;
  } catch (err) {
    console.warn(`OSRM route failed (idx=${idx}):`, err.message);
    // Keep the straight fallback that was already set.
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

// ─── Elevation (Open-Meteo, free + CORS) ─────────────────────────────────────
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

  const BATCH = 100;
  for (let i = 0; i < missing.length; i += BATCH) {
    if (seq !== elevationFetchSeq) return; // newer request superseded us
    const batch = missing.slice(i, i + BATCH);
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
    `${fmt(km, 2)} km · ${ascDesc} · ${formatHMS(movingTimeSec)} mov · ${formatHMS(totalTimeSec)} tot · ⌀ ${fmt(avgKmh)} km/h · ${fmt(totalKJ)} kJ${elevHint}`;
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
    'schema:creator': 'Cláudio · Ajudante cartográfica-energética',
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
  const n = trackpoints.length;
  traceCount.textContent = `${n} ponto${n === 1 ? '' : 's'}`;
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

    if (state.rm && ['straight', 'cycling', 'foot'].includes(state.rm)) {
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
  const trkpts = latlngs
    .map(([lat, lon]) => `      <trkpt lat="${lat}" lon="${lon}"/>`)
    .join('\n');

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
helpBtn?.addEventListener('click', () => (helpModal.hidden = false));
helpClose?.addEventListener('click', () => (helpModal.hidden = true));
helpModal?.addEventListener('click', (e) => {
  if (e.target === helpModal) helpModal.hidden = true;
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
  console.log(`[edit] entry.pois (${poiCount}):`, entry.pois);
  const poiTag = poiCount
    ? ` (${poiCount} POI${poiCount === 1 ? '' : 's'})`
    : ' · sem POIs no routes.json — rode `npm run build:routes`';
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

  if (savedRoutingMode && ['straight', 'cycling', 'foot'].includes(savedRoutingMode)) {
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
