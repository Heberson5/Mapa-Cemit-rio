// Servidor do Mapa do Cemitério – Node 22+ (sem dependências de runtime além de arquivos estáticos).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { seedDemo } from './seed.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dir, 'public');
const PORT = Number(process.env.PORT || 3000);
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const TZ_OFFSET_H = -4; // Tangará da Serra / MT (UTC-4)

mkdirSync(path.join(__dir, 'data'), { recursive: true });
const db = new DatabaseSync(process.env.DB_FILE || path.join(__dir, 'data', 'cemiterio.db'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');

// Tipos de jazigo (cap = gavetas; w/h = tamanho padrão em metros; height = altura 3D em metros)
export const TYPES = {
  '1G':  { label: '1 gaveta',                                   cap: 1, w: 1.2, h: 2.6, height: 0.7 },
  '2G':  { label: '2 gavetas empilhadas',                       cap: 2, w: 1.2, h: 2.6, height: 1.3 },
  '3G':  { label: '3 gavetas empilhadas',                       cap: 3, w: 1.2, h: 2.6, height: 1.9 },
  '3GS': { label: '3 gavetas empilhadas + área de serviço',     cap: 3, w: 1.2, h: 3.8, height: 1.9 },
  '6GS': { label: '6 gavetas empilhadas + área de serviço',     cap: 6, w: 1.2, h: 3.8, height: 3.4 },
  'FAM': { label: 'Terreno familiar (anfiteatro) – 6 gavetas + área de serviço', cap: 6, w: 3.6, h: 4.4, height: 2.0 },
};

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS plots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  alameda TEXT DEFAULT '', quadra TEXT DEFAULT '', lote TEXT DEFAULT '',
  geometry TEXT,              -- GeoJSON Polygon (null = ainda não demarcado)
  reserved INTEGER DEFAULT 0, reserved_for TEXT DEFAULT '',
  notes TEXT DEFAULT '', demo INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS deceased (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, name_norm TEXT NOT NULL,
  plot_id INTEGER REFERENCES plots(id) ON DELETE SET NULL,
  drawer INTEGER,
  kind TEXT NOT NULL DEFAULT 'sepultamento', -- sepultamento | exumacao | cinzas
  birth_date TEXT, death_date TEXT, event_date TEXT,
  responsible TEXT DEFAULT '', phone TEXT DEFAULT '', notes TEXT DEFAULT '', demo INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_dec_norm ON deceased(name_norm);
CREATE INDEX IF NOT EXISTS idx_dec_plot ON deceased(plot_id);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL, kind TEXT NOT NULL,       -- search | view
  term TEXT, results INTEGER, deceased_id INTEGER, plot_id INTEGER, session TEXT, device TEXT
);
CREATE INDEX IF NOT EXISTS idx_ev_ts ON events(ts);
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL, type TEXT NOT NULL,      -- nps | stars | choice | text
  options TEXT DEFAULT '[]', category TEXT DEFAULT '', active INTEGER DEFAULT 1, position INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS responses (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, session TEXT);
CREATE TABLE IF NOT EXISTS answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  response_id INTEGER NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL, value_num REAL, value_text TEXT
);
`);

const DEFAULT_CONFIG = {
  name: 'Memorial Santa Cruz',
  city: 'Tangará da Serra – MT',
  // Ponto aproximado em Tangará da Serra: AJUSTE no painel (Configurações → clicar no cemitério).
  center: [-57.4933, -14.6229],
  zoom: 17.5, pitch: 55, bearing: 0,
  boundary: null, entrance: null,
  tileUrl: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  tileAttribution: 'Imagem: Esri World Imagery', tileMaxZoom: 19,
  imageryYear: '2026', kioskIdleSeconds: 60, surveyEnabled: true,
};
function getConfig() {
  const row = db.prepare("SELECT value FROM settings WHERE key='config'").get();
  return { ...DEFAULT_CONFIG, ...(row ? JSON.parse(row.value) : {}) };
}
function setConfig(c) {
  db.prepare("INSERT INTO settings(key,value) VALUES('config',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(JSON.stringify(c));
}

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const nowLocal = () => new Date(Date.now() + TZ_OFFSET_H * 3600e3).toISOString().slice(0, 19).replace('T', ' ');
const tx = (fn) => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };

// ---------- consultas compartilhadas ----------
const OCC_SQL = `(SELECT COUNT(*) FROM deceased d WHERE d.plot_id=p.id AND d.kind!='exumacao')`;
function plotStatus(p) {
  const cap = TYPES[p.type]?.cap ?? 1;
  if (p.occ >= cap) return 'ocupado';
  if (p.occ > 0) return 'parcial';
  return p.reserved ? 'reservado' : 'livre';
}
function plotsGeoJSON() {
  const rows = db.prepare(`SELECT p.*, ${OCC_SQL} AS occ FROM plots p WHERE geometry IS NOT NULL`).all();
  return {
    type: 'FeatureCollection',
    features: rows.map((p) => ({
      type: 'Feature', id: p.id, geometry: JSON.parse(p.geometry),
      properties: {
        id: p.id, code: p.code, type: p.type, alameda: p.alameda, quadra: p.quadra, lote: p.lote,
        occ: p.occ, cap: TYPES[p.type]?.cap ?? 1, status: plotStatus(p),
        height: TYPES[p.type]?.height ?? 1,
      },
    })),
  };
}
function deceasedRows(where, params, limit = 50, offset = 0) {
  return db.prepare(`
    SELECT d.*, p.code AS plot_code, p.type AS plot_type, p.alameda, p.quadra, p.lote, p.geometry IS NOT NULL AS mapped
    FROM deceased d LEFT JOIN plots p ON p.id=d.plot_id
    ${where} ORDER BY d.name_norm LIMIT ? OFFSET ?`).all(...params, limit, offset);
}
function searchWhere(q) {
  const toks = norm(q).split(/\s+/).filter(Boolean);
  return { where: toks.length ? 'WHERE ' + toks.map(() => 'd.name_norm LIKE ?').join(' AND ') : '', params: toks.map((t) => `%${t}%`) };
}
const publicDeceased = (r) => ({
  id: r.id, name: r.name, kind: r.kind, birth_date: r.birth_date, death_date: r.death_date, event_date: r.event_date,
  drawer: r.drawer, plot_id: r.plot_id, plot_code: r.plot_code, plot_type: r.plot_type,
  plot_type_label: TYPES[r.plot_type]?.label, alameda: r.alameda, quadra: r.quadra, lote: r.lote, mapped: !!r.mapped,
});

// ---------- autenticação simples (token em memória) ----------
const sessions = new Map(); // token -> expira
const safeEq = (a, b) => { const A = Buffer.from(String(a)), B = Buffer.from(String(b)); return A.length === B.length && timingSafeEqual(A, B); };
function authed(req) {
  const t = (req.headers.authorization || '').replace(/^Bearer /, '');
  const exp = sessions.get(t);
  if (!exp || exp < Date.now()) { sessions.delete(t); return false; }
  return true;
}

// ---------- estatísticas ----------
function range(q) {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from || '') ? q.from : '1970-01-01';
  const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to || '') ? q.to : '2999-12-31';
  return [from + ' 00:00:00', to + ' 23:59:59'];
}
function stats(q) {
  const [a, b] = range(q);
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const V = "e.kind='view' AND e.ts BETWEEN ? AND ?";
  const group = (col, label = col) => all(`
    SELECT COALESCE(NULLIF(${col},''),'(sem informação)') AS label, COUNT(*) AS n
    FROM events e JOIN plots p ON p.id=e.plot_id WHERE ${V} GROUP BY 1 ORDER BY n DESC LIMIT 30`, a, b);
  const groupBy = q.groupDay === 'month' ? 'substr(e.ts,1,7)' : 'substr(e.ts,1,10)';
  return {
    totals: {
      views: one(`SELECT COUNT(*) n FROM events e WHERE ${V}`, a, b).n,
      searches: one("SELECT COUNT(*) n FROM events e WHERE e.kind='search' AND e.ts BETWEEN ? AND ?", a, b).n,
      noResults: one("SELECT COUNT(*) n FROM events e WHERE e.kind='search' AND e.results=0 AND e.ts BETWEEN ? AND ?", a, b).n,
      deceased: one('SELECT COUNT(*) n FROM deceased').n,
      plots: one('SELECT COUNT(*) n FROM plots').n,
      mapped: one('SELECT COUNT(*) n FROM plots WHERE geometry IS NOT NULL').n,
    },
    series: all(`SELECT ${groupBy} AS label, COUNT(*) AS n FROM events e WHERE ${V} GROUP BY 1 ORDER BY 1`, a, b),
    hours: all(`SELECT substr(e.ts,12,2) AS label, COUNT(*) AS n FROM events e WHERE ${V} GROUP BY 1 ORDER BY 1`, a, b),
    byDeceased: all(`SELECT d.id, d.name AS label, p.code AS plot, COUNT(*) AS n FROM events e JOIN deceased d ON d.id=e.deceased_id
      LEFT JOIN plots p ON p.id=d.plot_id WHERE ${V} GROUP BY d.id ORDER BY n DESC LIMIT 30`, a, b),
    byPlot: all(`SELECT p.id, p.code AS label, p.type, COUNT(*) AS n FROM events e JOIN plots p ON p.id=e.plot_id
      WHERE ${V} GROUP BY p.id ORDER BY n DESC LIMIT 30`, a, b),
    byQuadra: group('p.quadra'), byAlameda: group('p.alameda'), byType: group('p.type'),
    byKind: all(`SELECT d.kind AS label, COUNT(*) AS n FROM events e JOIN deceased d ON d.id=e.deceased_id WHERE ${V} GROUP BY 1`, a, b),
    missedTerms: all(`SELECT term AS label, COUNT(*) AS n FROM events e WHERE e.kind='search' AND e.results=0 AND e.ts BETWEEN ? AND ?
      GROUP BY term ORDER BY n DESC LIMIT 20`, a, b),
    heat: all(`SELECT e.plot_id AS id, COUNT(*) AS n FROM events e WHERE ${V} AND e.plot_id IS NOT NULL GROUP BY 1`, a, b),
  };
}
function npsStats(q) {
  const [a, b] = range(q);
  const nq = db.prepare("SELECT id FROM questions WHERE type='nps'").all().map((r) => r.id);
  const vals = nq.length
    ? db.prepare(`SELECT an.value_num v, substr(r.ts,1,10) d, an.question_id qid FROM answers an JOIN responses r ON r.id=an.response_id
        WHERE an.question_id IN (${nq.map(() => '?').join(',')}) AND an.value_num IS NOT NULL AND r.ts BETWEEN ? AND ?`).all(...nq, a, b)
    : [];
  const pro = vals.filter((x) => x.v >= 9).length, det = vals.filter((x) => x.v <= 6).length, n = vals.length;
  const byDay = {};
  for (const x of vals) { (byDay[x.d] ||= []).push(x.v); }
  const calc = (arr) => arr.length ? Math.round(((arr.filter((v) => v >= 9).length - arr.filter((v) => v <= 6).length) / arr.length) * 100) : null;
  const questions = db.prepare('SELECT * FROM questions ORDER BY position,id').all().map((qq) => {
    const rows = db.prepare(`SELECT an.value_num v, an.value_text t, r.ts FROM answers an JOIN responses r ON r.id=an.response_id
      WHERE an.question_id=? AND r.ts BETWEEN ? AND ? ORDER BY r.ts DESC`).all(qq.id, a, b);
    const o = { id: qq.id, text: qq.text, type: qq.type, category: qq.category, count: rows.length };
    if (qq.type === 'nps' || qq.type === 'stars') {
      const nums = rows.map((r) => r.v).filter((v) => v != null);
      o.avg = nums.length ? +(nums.reduce((s, v) => s + v, 0) / nums.length).toFixed(2) : null;
      const dist = {}; nums.forEach((v) => (dist[v] = (dist[v] || 0) + 1)); o.dist = dist;
    } else if (qq.type === 'choice') {
      const dist = {}; rows.forEach((r) => r.t && (dist[r.t] = (dist[r.t] || 0) + 1)); o.dist = dist;
    } else o.texts = rows.filter((r) => r.t).slice(0, 50).map((r) => ({ ts: r.ts, text: r.t }));
    return o;
  });
  const byCategory = {};
  for (const qq of questions) if ((qq.type === 'stars' || qq.type === 'nps') && qq.avg != null) (byCategory[qq.category || 'Geral'] ||= []).push(qq.avg);
  return {
    responses: db.prepare('SELECT COUNT(*) n FROM responses WHERE ts BETWEEN ? AND ?').get(a, b).n,
    nps: { score: calc(vals.map((x) => x.v)), n, promoters: pro, detractors: det, passives: n - pro - det },
    trend: Object.keys(byDay).sort().map((d) => ({ label: d, nps: calc(byDay[d]), n: byDay[d].length })),
    questions,
    categories: Object.entries(byCategory).map(([label, arr]) => ({ label, avg: +(arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(2) })),
  };
}

// ---------- importação ----------
const KIND_MAP = { sepultamento: 'sepultamento', sepultado: 'sepultamento', inumacao: 'sepultamento', exumacao: 'exumacao', exumado: 'exumacao', cinzas: 'cinzas', cremacao: 'cinzas', 'guarda de cinzas': 'cinzas', 'guarda cinzas': 'cinzas' };
const TYPE_ALIAS = (raw) => {
  const s = norm(raw).replace(/\s+/g, '');
  if (TYPES[String(raw || '').toUpperCase().trim()]) return String(raw).toUpperCase().trim();
  if (/fam|anfi/.test(s)) return 'FAM';
  if (/6.*serv|6gs/.test(s)) return '6GS';
  if (/3.*serv|3gs/.test(s)) return '3GS';
  if (/^3|3g/.test(s)) return '3G';
  if (/^2|2g/.test(s)) return '2G';
  if (/^1|1g/.test(s)) return '1G';
  return null;
};
const isoDate = (v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') { const d = new Date(Math.round((v - 25569) * 86400e3)); return d.toISOString().slice(0, 10); }
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : s;
};
function importRows(rows, { createPlots = true, dryRun = false } = {}) {
  const res = { total: rows.length, created: 0, updated: 0, plotsCreated: 0, errors: [] };
  const findPlot = db.prepare('SELECT * FROM plots WHERE code=?');
  const insPlot = db.prepare('INSERT INTO plots(code,type,alameda,quadra,lote) VALUES(?,?,?,?,?)');
  const findDec = db.prepare('SELECT id FROM deceased WHERE name_norm=? AND IFNULL(death_date,\'\')=IFNULL(?,\'\') AND IFNULL(plot_id,0)=IFNULL(?,0)');
  const insDec = db.prepare(`INSERT INTO deceased(name,name_norm,plot_id,drawer,kind,birth_date,death_date,event_date,responsible,phone,notes) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
  const updDec = db.prepare(`UPDATE deceased SET drawer=?,kind=?,birth_date=?,event_date=?,responsible=?,phone=?,notes=? WHERE id=?`);
  const run = () => rows.forEach((r, i) => {
    try {
      const name = String(r.nome ?? '').trim();
      if (!name) throw new Error('nome vazio');
      const kind = KIND_MAP[norm(r.situacao)] || (r.situacao ? null : 'sepultamento');
      if (!kind) throw new Error(`situação inválida "${r.situacao}" (use sepultamento, exumação ou cinzas)`);
      let plotId = null;
      const code = String(r.jazigo ?? '').trim();
      if (code) {
        let p = findPlot.get(code);
        if (!p) {
          if (!createPlots) throw new Error(`jazigo "${code}" não cadastrado`);
          const type = TYPE_ALIAS(r.tipo_jazigo) || '1G';
          const info = insPlot.run(code, type, String(r.alameda ?? ''), String(r.quadra ?? ''), String(r.lote ?? ''));
          p = { id: Number(info.lastInsertRowid) }; res.plotsCreated++;
        }
        plotId = p.id;
      }
      const dd = isoDate(r.data_falecimento);
      const drawer = r.gaveta ? parseInt(r.gaveta, 10) || null : null;
      const vals = [drawer, kind, isoDate(r.data_nascimento), isoDate(r.data_evento), String(r.responsavel ?? ''), String(r.telefone ?? ''), String(r.observacoes ?? '')];
      const ex = findDec.get(norm(name), dd, plotId);
      if (ex) { updDec.run(...vals, ex.id); res.updated++; }
      else { insDec.run(name, norm(name), plotId, drawer, kind, vals[2], dd, vals[3], vals[4], vals[5], vals[6]); res.created++; }
    } catch (e) { res.errors.push({ linha: i + 2, erro: e.message }); }
  });
  db.exec('BEGIN');
  try { run(); db.exec(dryRun ? 'ROLLBACK' : 'COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  return res;
}

// ---------- roteamento ----------
const routes = [];
const route = (method, pattern, handler, { admin = false } = {}) => {
  const keys = []; const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, handler, admin });
};
const J = (res, data, code = 200) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };

// Público (totem)
route('GET', '/api/config', () => {
  const c = getConfig();
  return { ...c, types: TYPES };
});
route('GET', '/api/plots', () => plotsGeoJSON());
route('GET', '/api/search', ({ query }) => {
  const q = (query.q || '').trim();
  if (norm(q).length < 2) return { results: [] };
  const { where, params } = searchWhere(q);
  const rows = deceasedRows(where, params, 30).map(publicDeceased);
  if (query.log !== '0') db.prepare('INSERT INTO events(ts,kind,term,results,session,device) VALUES(?,?,?,?,?,?)')
    .run(nowLocal(), 'search', norm(q), rows.length, query.session || '', query.device || 'totem');
  return { results: rows };
});
route('POST', '/api/view', ({ body }) => {
  const d = db.prepare('SELECT id,plot_id FROM deceased WHERE id=?').get(Number(body.deceased_id));
  if (!d) return { ok: false };
  db.prepare('INSERT INTO events(ts,kind,deceased_id,plot_id,session,device) VALUES(?,?,?,?,?,?)')
    .run(nowLocal(), 'view', d.id, d.plot_id, body.session || '', body.device || 'totem');
  return { ok: true };
});
route('GET', '/api/plot/:id', ({ params }) => {
  const p = db.prepare(`SELECT p.*, ${OCC_SQL} AS occ FROM plots p WHERE id=?`).get(params.id);
  if (!p) return null;
  return { id: p.id, code: p.code, type: p.type, quadra: p.quadra, alameda: p.alameda, lote: p.lote, geometry: p.geometry ? JSON.parse(p.geometry) : null,
    status: plotStatus(p), cap: TYPES[p.type]?.cap, deceased: deceasedRows('WHERE d.plot_id=?', [p.id], 50).map(publicDeceased) };
});
route('GET', '/api/survey', () => ({
  enabled: getConfig().surveyEnabled,
  questions: db.prepare('SELECT id,text,type,options FROM questions WHERE active=1 ORDER BY position,id').all().map((q) => ({ ...q, options: JSON.parse(q.options || '[]') })),
}));
route('POST', '/api/survey/respond', ({ body }) => {
  const answers = (body.answers || []).filter((a) => a && a.question_id && (a.value_num != null || (a.value_text ?? '') !== ''));
  if (!answers.length) return { ok: true, saved: 0 };
  tx(() => {
    const r = db.prepare('INSERT INTO responses(ts,session) VALUES(?,?)').run(nowLocal(), body.session || '');
    const ins = db.prepare('INSERT INTO answers(response_id,question_id,value_num,value_text) VALUES(?,?,?,?)');
    for (const a of answers) ins.run(Number(r.lastInsertRowid), a.question_id, a.value_num ?? null, a.value_text ?? null);
  });
  return { ok: true, saved: answers.length };
});

route('POST', '/api/login', ({ body }) => {
  if (safeEq(body.user ?? '', ADMIN_USER) && safeEq(body.password ?? '', ADMIN_PASSWORD)) {
    const t = randomBytes(24).toString('hex'); sessions.set(t, Date.now() + 12 * 3600e3);
    return { token: t, defaultPassword: ADMIN_PASSWORD === 'admin' };
  }
  return { __status: 401, error: 'Usuário ou senha inválidos' };
});

// Admin
const A = { admin: true };
route('PUT', '/api/admin/config', ({ body }) => {
  const cur = getConfig();
  const allowed = ['name', 'city', 'center', 'zoom', 'pitch', 'bearing', 'boundary', 'entrance', 'tileUrl', 'tileAttribution', 'tileMaxZoom', 'imageryYear', 'kioskIdleSeconds', 'surveyEnabled'];
  for (const k of allowed) if (k in body) cur[k] = body[k];
  setConfig(cur); return { ok: true };
}, A);
route('POST', '/api/admin/recenter', ({ body }) => { // desloca todo o mapa para um novo centro
  const { dLng, dLat } = body;
  if (![dLng, dLat].every(Number.isFinite)) return { __status: 400, error: 'delta inválido' };
  const shift = (g) => ({ ...g, coordinates: g.coordinates.map((ring) => ring.map(([x, y]) => [x + dLng, y + dLat])) });
  tx(() => {
    for (const p of db.prepare('SELECT id,geometry FROM plots WHERE geometry IS NOT NULL').all())
      db.prepare('UPDATE plots SET geometry=? WHERE id=?').run(JSON.stringify(shift(JSON.parse(p.geometry))), p.id);
    const c = getConfig();
    c.center = [c.center[0] + dLng, c.center[1] + dLat];
    if (c.boundary) c.boundary = shift(c.boundary);
    if (c.entrance) c.entrance = [c.entrance[0] + dLng, c.entrance[1] + dLat];
    setConfig(c);
  });
  return { ok: true };
}, A);
route('GET', '/api/admin/plots', ({ query }) => {
  const q = norm(query.q || '');
  const rows = db.prepare(`SELECT p.*, ${OCC_SQL} AS occ FROM plots p ORDER BY p.quadra,p.alameda,p.code`).all()
    .map((p) => ({ ...p, geometry: undefined, mapped: !!p.geometry, cap: TYPES[p.type]?.cap, status: plotStatus(p) }))
    .filter((p) => !q || norm(`${p.code} ${p.quadra} ${p.alameda} ${p.lote}`).includes(q))
    .filter((p) => !query.type || p.type === query.type)
    .filter((p) => !query.unmapped || !p.mapped);
  return { total: rows.length, plots: rows.slice(0, Number(query.limit) || 500) };
}, A);
const plotCols = (b) => [b.code, b.type, b.alameda ?? '', b.quadra ?? '', b.lote ?? '', b.geometry ? JSON.stringify(b.geometry) : null, b.reserved ? 1 : 0, b.reserved_for ?? '', b.notes ?? ''];
const validPlot = (b) => (!b.code || !TYPES[b.type]) ? 'Informe o código e um tipo válido' : null;
route('POST', '/api/admin/plots', ({ body }) => {
  const err = validPlot(body); if (err) return { __status: 400, error: err };
  try {
    const r = db.prepare('INSERT INTO plots(code,type,alameda,quadra,lote,geometry,reserved,reserved_for,notes) VALUES(?,?,?,?,?,?,?,?,?)').run(...plotCols(body));
    return { id: Number(r.lastInsertRowid) };
  } catch (e) { return { __status: 409, error: 'Já existe jazigo com esse código' }; }
}, A);
route('PUT', '/api/admin/plots/:id', ({ params, body }) => {
  const err = validPlot(body); if (err) return { __status: 400, error: err };
  try {
    db.prepare('UPDATE plots SET code=?,type=?,alameda=?,quadra=?,lote=?,geometry=?,reserved=?,reserved_for=?,notes=? WHERE id=?').run(...plotCols(body), params.id);
    return { ok: true };
  } catch (e) { return { __status: 409, error: 'Já existe jazigo com esse código' }; }
}, A);
route('PATCH', '/api/admin/plots/:id/geometry', ({ params, body }) => {
  db.prepare('UPDATE plots SET geometry=? WHERE id=?').run(body.geometry ? JSON.stringify(body.geometry) : null, params.id); return { ok: true };
}, A);
route('DELETE', '/api/admin/plots/:id', ({ params }) => { db.prepare('DELETE FROM plots WHERE id=?').run(params.id); return { ok: true }; }, A);
route('GET', '/api/admin/plots/:id', ({ params }) => {
  const p = db.prepare(`SELECT p.*, ${OCC_SQL} AS occ FROM plots p WHERE id=?`).get(params.id);
  if (!p) return null;
  return { ...p, geometry: p.geometry ? JSON.parse(p.geometry) : null, cap: TYPES[p.type]?.cap, status: plotStatus(p),
    deceased: deceasedRows('WHERE d.plot_id=?', [p.id], 100) };
}, A);

route('GET', '/api/admin/deceased', ({ query }) => {
  let { where, params } = searchWhere(query.q || '');
  const extra = [];
  if (query.kind) { extra.push('d.kind=?'); params.push(query.kind); }
  if (query.plot) { extra.push('d.plot_id=?'); params.push(Number(query.plot)); }
  if (query.unlinked) extra.push('d.plot_id IS NULL');
  if (extra.length) where = (where ? where + ' AND ' : 'WHERE ') + extra.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) n FROM deceased d ${where}`).get(...params).n;
  const limit = Math.min(Number(query.limit) || 50, 500), offset = Number(query.offset) || 0;
  return { total, rows: deceasedRows(where, params, limit, offset) };
}, A);
const decCols = (b) => [b.name.trim(), norm(b.name), b.plot_id || null, b.drawer || null, b.kind || 'sepultamento', b.birth_date || null, b.death_date || null, b.event_date || null, b.responsible ?? '', b.phone ?? '', b.notes ?? ''];
route('POST', '/api/admin/deceased', ({ body }) => {
  if (!body.name?.trim()) return { __status: 400, error: 'Informe o nome' };
  const r = db.prepare('INSERT INTO deceased(name,name_norm,plot_id,drawer,kind,birth_date,death_date,event_date,responsible,phone,notes) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(...decCols(body));
  return { id: Number(r.lastInsertRowid) };
}, A);
route('PUT', '/api/admin/deceased/:id', ({ params, body }) => {
  if (!body.name?.trim()) return { __status: 400, error: 'Informe o nome' };
  db.prepare('UPDATE deceased SET name=?,name_norm=?,plot_id=?,drawer=?,kind=?,birth_date=?,death_date=?,event_date=?,responsible=?,phone=?,notes=? WHERE id=?').run(...decCols(body), params.id);
  return { ok: true };
}, A);
route('DELETE', '/api/admin/deceased/:id', ({ params }) => { db.prepare('DELETE FROM deceased WHERE id=?').run(params.id); return { ok: true }; }, A);

route('GET', '/api/admin/stats', ({ query }) => stats(query), A);
route('GET', '/api/admin/nps', ({ query }) => npsStats(query), A);
route('GET', '/api/admin/questions', () => db.prepare('SELECT * FROM questions ORDER BY position,id').all().map((q) => ({ ...q, options: JSON.parse(q.options || '[]') })), A);
const qCols = (b) => [b.text, b.type, JSON.stringify(b.options || []), b.category || '', b.active ? 1 : 0, b.position || 0];
const validQ = (b) => (!b.text?.trim() || !['nps', 'stars', 'choice', 'text'].includes(b.type)) ? 'Pergunta ou tipo inválido' : null;
route('POST', '/api/admin/questions', ({ body }) => { const e = validQ(body); if (e) return { __status: 400, error: e };
  return { id: Number(db.prepare('INSERT INTO questions(text,type,options,category,active,position) VALUES(?,?,?,?,?,?)').run(...qCols(body)).lastInsertRowid) }; }, A);
route('PUT', '/api/admin/questions/:id', ({ params, body }) => { const e = validQ(body); if (e) return { __status: 400, error: e };
  db.prepare('UPDATE questions SET text=?,type=?,options=?,category=?,active=?,position=? WHERE id=?').run(...qCols(body), params.id); return { ok: true }; }, A);
route('DELETE', '/api/admin/questions/:id', ({ params }) => {
  db.prepare('DELETE FROM answers WHERE question_id=?').run(params.id);
  db.prepare('DELETE FROM questions WHERE id=?').run(params.id); return { ok: true }; }, A);
route('POST', '/api/admin/clear-demo', () => {
  tx(() => { db.exec('DELETE FROM deceased WHERE demo=1; DELETE FROM plots WHERE demo=1; DELETE FROM events; DELETE FROM answers; DELETE FROM responses;'); });
  return { ok: true };
}, A);

route('POST', '/api/admin/import', ({ body }) =>
  importRows(body.rows || [], { createPlots: body.createPlots !== false, dryRun: !!body.dryRun }), A);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.csv': 'text/csv; charset=utf-8' };
async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/kiosk.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  try {
    const buf = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': rel.startsWith('/vendor/') ? 'public, max-age=86400' : 'no-cache' });
    res.end(buf);
  } catch { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Não encontrado'); }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
  const r = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
  if (!r) return J(res, { error: 'rota não encontrada' }, 404);
  if (r.admin && !authed(req)) return J(res, { error: 'não autorizado' }, 401);
  try {
    let body = {};
    if (req.method !== 'GET' && req.method !== 'DELETE') {
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > 30e6) throw new Error('corpo muito grande'); chunks.push(c); }
      if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    const m = url.pathname.match(r.re);
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    const out = await r.handler({ req, body, params, query: Object.fromEntries(url.searchParams) });
    if (out === null) return J(res, { error: 'não encontrado' }, 404);
    if (out?.__status) { const { __status, ...rest } = out; return J(res, rest, __status); }
    J(res, out);
  } catch (e) { console.error(e); J(res, { error: e.message }, 500); }
});

if (db.prepare('SELECT COUNT(*) n FROM plots').get().n === 0 && process.env.NO_DEMO !== '1') {
  console.log('Banco vazio: criando dados de demonstração…');
  seedDemo({ db, TYPES, getConfig, setConfig, norm, tx });
}
server.listen(PORT, () => console.log(`Totem:  http://localhost:${PORT}/\nAdmin:  http://localhost:${PORT}/admin.html  (usuário: ${ADMIN_USER})`));
