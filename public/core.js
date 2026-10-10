// Núcleo compartilhado: chamadas à API, utilidades e mapa 3D (MapLibre).
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmtDate = (d) => (d ? d.split('-').reverse().join('/') : '—');
export const KIND = { sepultamento: 'Sepultado(a)', exumacao: 'Exumado(a)', cinzas: 'Guarda de cinzas' };

let token = null;
try { token = localStorage.getItem('cemit_token'); } catch {}
export const setToken = (t) => { token = t; try { t ? localStorage.setItem('cemit_token', t) : localStorage.removeItem('cemit_token'); } catch {} };
export const hasToken = () => !!token;
export async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data.error || r.statusText); e.status = r.status; throw e; }
  return data;
}

// ---- geometria (metros <-> graus) ----
export const mPerDeg = (lat) => ({ lat: 111320, lng: 111320 * Math.cos((lat * Math.PI) / 180) });
export function rectAt([lng, lat], w, h, deg) {
  const k = mPerDeg(lat), a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const pts = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => [lng + (x * c - y * s) / k.lng, lat + (x * s + y * c) / k.lat]);
  return { type: 'Polygon', coordinates: [[...pts, pts[0]]] };
}
export const centroid = (g) => { const r = g.coordinates[0].slice(0, -1); return [r.reduce((s, p) => s + p[0], 0) / r.length, r.reduce((s, p) => s + p[1], 0) / r.length]; };
export function transformGeom(g, fn) { return { ...g, coordinates: g.coordinates.map((ring) => ring.map(fn)) }; }
export function rotateGeom(g, deg) {
  const [cx, cy] = centroid(g), k = mPerDeg(cy), a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return transformGeom(g, ([x, y]) => { const dx = (x - cx) * k.lng, dy = (y - cy) * k.lat; return [cx + (dx * c - dy * s) / k.lng, cy + (dx * s + dy * c) / k.lat]; });
}
export function moveGeomTo(g, [lng, lat]) { const [cx, cy] = centroid(g); return transformGeom(g, ([x, y]) => [x - cx + lng, y - cy + lat]); }
export function distanceM([a, b], [c, d]) { const k = mPerDeg(b); return Math.hypot((c - a) * k.lng, (d - b) * k.lat); }
export function bboxOf(g) { const pts = g.coordinates[0]; return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))]; }

// ---- cores ----
export const TYPE_COLORS = { '1G': '#a9c4d6', '2G': '#86adc9', '3G': '#6a95bb', '3GS': '#8c7fc4', '6GS': '#c07fb5', 'FAM': '#d9a35b' };
export const STATUS_COLORS = { livre: '#4fb286', parcial: '#e3b341', ocupado: '#cf5c47', reservado: '#5b8dd6' };
export const STATUS_LABEL = { livre: 'Livre', parcial: 'Parcialmente ocupado', ocupado: 'Ocupado', reservado: 'Reservado' };
const matchExpr = (prop, map, def) => ['match', ['get', prop], ...Object.entries(map).flat(), def];

// ---- mapa ----
// opts: { interactive, editor }. Retorna o objeto map do MapLibre com helpers (map.cem.*).
export async function createCemeteryMap(container, cfg, { colorMode = 'type', fit = true, free = false } = {}) {
  const b = cfg.boundary ? bboxOf(cfg.boundary) : [cfg.center[0] - 0.002, cfg.center[1] - 0.002, cfg.center[0] + 0.002, cfg.center[1] + 0.002];
  const padLng = 0.0012, padLat = 0.0010;
  const maxBounds = [[b[0] - padLng, b[1] - padLat], [b[2] + padLng, b[3] + padLat]];
  const map = new maplibregl.Map({
    container, center: cfg.center, zoom: cfg.zoom, pitch: cfg.pitch, bearing: cfg.bearing, maxPitch: 75, minZoom: free ? 3 : 15.5, maxZoom: 22,
    maxBounds: free ? undefined : maxBounds, attributionControl: { compact: true }, antialias: true, canvasContextAttributes: { antialias: true },
    style: {
      version: 8,
      glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
      sources: { sat: { type: 'raster', tiles: [cfg.tileUrl], tileSize: 256, maxzoom: cfg.tileMaxZoom || 19, attribution: `${cfg.tileAttribution || ''} · ${cfg.imageryYear || ''}` } },
      layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#16241c' } }, { id: 'sat', type: 'raster', source: 'sat', paint: { 'raster-saturation': 0.05, 'raster-contrast': 0.05 } }],
    },
  });
  await new Promise((r) => map.on('load', r));
  const cem = (map.cem = { colorMode, heat: null, cfg });

  // Máscara: escurece tudo fora do limite do cemitério ("imagem só do cemitério")
  const world = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]];
  const hole = cfg.boundary ? cfg.boundary.coordinates[0] : [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]];
  map.addSource('mask', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'Polygon', coordinates: [world, hole] } } });
  map.addLayer({ id: 'mask', type: 'fill', source: 'mask', paint: { 'fill-color': '#0c1511', 'fill-opacity': free ? 0 : 0.94 } });
  cem.setMask = (on) => map.setPaintProperty('mask', 'fill-opacity', on ? 0.94 : 0);
  cem.setBoundary = (g) => { const ring = g.coordinates[0]; map.getSource('mask').setData({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [world, ring] } }); map.getSource('boundary').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: ring } }); };
  map.addSource('boundary', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: hole } } });
  map.addLayer({ id: 'boundary', type: 'line', source: 'boundary', paint: { 'line-color': '#f3e2a9', 'line-width': 2, 'line-dasharray': [3, 2] } });

  map.addSource('plots', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'plots-3d', type: 'fill-extrusion', source: 'plots', minzoom: 16,
    paint: { 'fill-extrusion-color': matchExpr('type', TYPE_COLORS, '#999'), 'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 16, ['*', ['get', 'height'], 1.6], 19, ['get', 'height']], 'fill-extrusion-base': 0, 'fill-extrusion-opacity': 0.93, 'fill-extrusion-vertical-gradient': true },
  });
  map.addLayer({ id: 'plots-line', type: 'line', source: 'plots', minzoom: 17.5, paint: { 'line-color': 'rgba(255,255,255,.55)', 'line-width': 0.6 } });
  map.addLayer({ id: 'plots-label', type: 'symbol', source: 'plots', minzoom: 20.2, layout: { 'text-field': ['get', 'code'], 'text-font': ['Open Sans Regular'], 'text-size': 10, 'text-allow-overlap': false }, paint: { 'text-color': '#fff', 'text-halo-color': '#000', 'text-halo-width': 1.2 } });
  map.addSource('sel', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'sel-3d', type: 'fill-extrusion', source: 'sel', paint: { 'fill-extrusion-color': '#ffd23f', 'fill-extrusion-height': ['+', ['get', 'height'], 0.8], 'fill-extrusion-opacity': 1 } });
  map.addLayer({ id: 'sel-line', type: 'line', source: 'sel', paint: { 'line-color': '#ffffff', 'line-width': 2.5 } });
  map.addSource('route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'route', type: 'line', source: 'route', paint: { 'line-color': '#2fe0ff', 'line-width': 4, 'line-dasharray': [1, 1.6], 'line-opacity': 0.95 } });

  cem.features = [];
  cem.recolor = (mode = cem.colorMode) => {
    cem.colorMode = mode;
    let expr;
    if (mode === 'status') expr = matchExpr('status', STATUS_COLORS, '#999');
    else if (mode === 'heat' && cem.heat) {
      const max = Math.max(1, ...Object.values(cem.heat));
      const col = (n) => { const t = n / max; return t > 0.66 ? '#e5383b' : t > 0.33 ? '#f39237' : t > 0.12 ? '#f2cc57' : '#9ad07f'; };
      const pairs = Object.entries(cem.heat).flatMap(([id, n]) => [Number(id), col(n)]);
      expr = pairs.length ? ['match', ['get', 'id'], ...pairs, '#59707a'] : '#59707a';
    } else expr = matchExpr('type', TYPE_COLORS, '#999');
    map.setPaintProperty('plots-3d', 'fill-extrusion-color', expr);
  };
  cem.load = async () => {
    const fc = await api('/api/plots'); cem.features = fc.features;
    map.getSource('plots').setData(fc); cem.recolor();
    return fc;
  };
  cem.select = (id) => {
    const f = cem.features.filter((x) => x.properties.id === id);
    map.getSource('sel').setData({ type: 'FeatureCollection', features: f });
    return f[0];
  };
  cem.fit = (g, opts = {}) => { const [a, bb, c, d] = bboxOf(g); map.fitBounds([[a, bb], [c, d]], { padding: 60, duration: 1400, ...opts }); };
  cem.fitBoundary = (opts) => { map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 40, duration: 1200, ...opts }); };
  if (fit && cfg.boundary) map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 40, duration: 0, pitch: cfg.pitch, bearing: cfg.bearing });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
  return map;
}
export function waitIdle(map) { return new Promise((r) => (map.loaded() ? r() : map.once('idle', r))); }
