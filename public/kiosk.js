import { $, esc, api, fmtDate, KIND, createCemeteryMap, distanceM, centroid, bboxOf, TYPE_COLORS } from '/core.js';

const session = Math.random().toString(36).slice(2, 10);
const device = new URLSearchParams(location.search).get('device') || 'totem';
const cfg = await api('/api/config');
$('#title').textContent = cfg.name; $('#sub').textContent = `${cfg.city} · Localizador de jazigos`;
const map = await createCemeteryMap($('#map'), cfg);
await map.cem.load();
$('#legend').innerHTML = '<b>Tipos de jazigo</b>' + Object.entries(cfg.types).map(([k, t]) => `<div><span class="sw" style="background:${TYPE_COLORS[k]}"></span>${esc(t.label.replace(/ \(.*\)/, ''))}</div>`).join('');

// ---------- inatividade ----------
let idleT, marker, spinning = false;
const reset = () => { clearTimeout(idleT); idleT = setTimeout(() => startFlow(), (cfg.kioskIdleSeconds || 60) * 1000); };
['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach((e) => addEventListener(e, reset, { passive: true }));

// ---------- teclado virtual ----------
const rows = ['1234567890', 'QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'];
const kb = $('#kb');
kb.innerHTML = rows.map((r) => `<div class="row">${[...r].map((c) => `<button data-k="${c}">${c}</button>`).join('')}${r.startsWith('ZX') ? '<button data-k="⌫" style="flex:1.6">⌫</button>' : ''}</div>`).join('') +
  '<div class="row"><button data-k=" " class="wide">espaço</button><button data-k="C" class="danger" style="flex:1.4">limpar</button></div>';
const q = $('#q'); let timer;
kb.addEventListener('click', (e) => {
  const k = e.target.closest('button')?.dataset.k; if (k == null) return;
  if (k === '⌫') q.value = q.value.slice(0, -1); else if (k === 'C') { q.value = ''; } else q.value += k.toLowerCase();
  q.value = q.value.replace(/^\s+/, '').replace(/\s{2,}/g, ' ');
  clearTimeout(timer); timer = setTimeout(doSearch, 250);
});

async function doSearch() {
  const term = q.value.trim(), box = $('#results');
  $('#detail').style.display = 'none';
  if (term.length < 2) { box.hidden = true; $('#hint').textContent = 'Use o teclado abaixo. Você pode digitar apenas parte do nome.'; return; }
  const { results } = await api(`/api/search?q=${encodeURIComponent(term)}&session=${session}&device=${device}`);
  box.hidden = false;
  if (!results.length) { box.innerHTML = '<div style="padding:1rem">Nenhum resultado. Tente digitar menos letras ou apenas o primeiro nome. Se precisar, procure a recepção.</div>'; return; }
  $('#hint').textContent = `${results.length} resultado(s) — toque no nome para ver no mapa.`;
  box.innerHTML = results.map((r) => `<button data-id="${r.id}"><b>${esc(r.name)}</b><span>${[r.quadra, r.alameda, r.plot_code && 'Jazigo ' + r.plot_code].filter(Boolean).map(esc).join(' · ') || 'Localização a confirmar'} · ${KIND[r.kind]}</span></button>`).join('');
  box.onclick = (e) => { const b = e.target.closest('button'); if (b) show(results.find((x) => x.id == b.dataset.id)); };
}

// ---------- localizar no mapa ----------
async function show(r) {
  api('/api/view', { method: 'POST', body: { deceased_id: r.id, session, device } }).catch(() => {});
  $('#results').hidden = true; $('#kb').style.display = 'none'; $('#searchbox').style.display = 'none';
  const d = $('#detail'); d.style.display = 'block';
  const place = [r.quadra, r.alameda, r.lote && 'Lote ' + r.lote].filter(Boolean).map(esc).join(' · ');
  let info = '';
  const f = r.plot_id && map.cem.select(r.plot_id);
  if (f) {
    const g = f.geometry, c = centroid(g);
    const ent = cfg.entrance || cfg.center, m = Math.round(distanceM(ent, c));
    map.getSource('route').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: [ent, c] } });
    info = `<dt>Distância</dt><dd>≈ ${m} m da entrada (≈ ${Math.max(1, Math.round(m / 70))} min a pé, em linha reta)</dd>`;
    marker?.remove();
    const el = document.createElement('div'); el.className = 'pin'; el.textContent = '📍';
    marker = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat(c).addTo(map);
    map.flyTo({ center: c, zoom: 19.6, pitch: 62, bearing: map.getBearing(), duration: 2600, essential: true });
    spinning = true;
  } else {
    map.cem.select(-1); map.getSource('route').setData({ type: 'FeatureCollection', features: [] });
    info = '<dt>Mapa</dt><dd>A demarcação deste jazigo ainda não foi feita. Procure a recepção.</dd>';
  }
  d.innerHTML = `<span class="badge">${KIND[r.kind]}</span><h2>${esc(r.name)}</h2>
    <div style="color:var(--muted)">${r.birth_date ? '✦ ' + fmtDate(r.birth_date) : ''} ${r.death_date ? '✝ ' + fmtDate(r.death_date) : ''}</div>
    <dl><dt>Local</dt><dd>${place || '—'}</dd><dt>Jazigo</dt><dd>${esc(r.plot_code || '—')}${r.plot_type_label ? ' <span style="font-weight:400;color:var(--muted)">(' + esc(r.plot_type_label) + ')</span>' : ''}</dd>
    ${r.drawer ? `<dt>Gaveta</dt><dd>${r.drawer}ª (contando de baixo para cima)</dd>` : ''}${info}</dl>
    <div style="display:flex;gap:.6rem;flex-wrap:wrap"><button class="primary big" id="again">Nova busca</button><button class="big" id="overview">Ver todo o cemitério</button></div>`;
  $('#again').onclick = newSearch;
  $('#overview').onclick = () => { map.cem.fitBoundary({ pitch: 55 }); };
}
function newSearch() {
  marker?.remove(); marker = null; map.cem.select(-1); map.getSource('route').setData({ type: 'FeatureCollection', features: [] });
  $('#detail').style.display = 'none'; $('#kb').style.display = ''; $('#searchbox').style.display = ''; $('#results').hidden = true;
  q.value = ''; $('#hint').textContent = 'Use o teclado abaixo. Você pode digitar apenas parte do nome.';
  map.cem.fitBoundary({ pitch: cfg.pitch });
}

// ---------- fluxo: boas-vindas → pesquisa (NPS) → busca ----------
const ov = $('#overlay');
async function startFlow() {
  newSearch(); ov.className = 'show';
  ov.innerHTML = `<div class="box"><div class="logo" style="margin:auto;width:84px;height:84px;font-size:3rem;border-radius:50%;background:var(--brand);color:#241c05;display:grid;place-items:center">✝</div>
    <h2>${esc(cfg.name)}</h2><p style="font-size:1.3rem;color:var(--muted)">Encontre o local de descanso do seu ente querido</p>
    <button class="primary welcome-btn" id="go">Toque para começar</button></div>`;
  map.easeTo({ bearing: map.getBearing() + 40, duration: 60000, easing: (t) => t });
  $('#go').onclick = async () => { map.stop(); let s = { enabled: false, questions: [] }; try { s = await api('/api/survey'); } catch {} 
    if (s.enabled && s.questions.length) survey(s.questions); else closeOverlay(); };
  clearTimeout(idleT);
}
function closeOverlay() { ov.className = ''; reset(); map.cem.fitBoundary({ pitch: cfg.pitch }); }

function survey(questions) {
  const answers = []; let i = 0;
  const finish = async () => {
    try { await api('/api/survey/respond', { method: 'POST', body: { session, answers } }); } catch {}
    ov.innerHTML = '<div class="box"><h2>Obrigado pela sua opinião! 💚</h2></div>'; setTimeout(closeOverlay, 1300);
  };
  const next = () => { i++; i < questions.length ? render() : finish(); };
  function render() {
    const qq = questions[i];
    let body = '';
    if (qq.type === 'nps') body = `<div class="opts nps">${Array.from({ length: 11 }, (_, n) => `<button data-n="${n}">${n}</button>`).join('')}</div><div class="scale"><span>Nada provável</span><span>Muito provável</span></div>`;
    else if (qq.type === 'stars') body = `<div class="opts">${[1, 2, 3, 4, 5].map((n) => `<button data-n="${n}">${'★'.repeat(n)}</button>`).join('')}</div><div class="scale"><span>Ruim</span><span>Excelente</span></div>`;
    else if (qq.type === 'choice') body = `<div class="opts">${qq.options.map((o) => `<button data-t="${esc(o)}" style="font-size:1.3rem">${esc(o)}</button>`).join('')}</div>`;
    else body = `<textarea id="txt" rows="3" placeholder="Toque e digite (opcional)" style="font-size:1.3rem"></textarea><div class="opts"><button class="primary" id="ok">Enviar</button></div>`;
    ov.innerHTML = `<div class="box"><p style="color:var(--muted)">Antes de começar, queremos ouvir você</p><h2>${esc(qq.text)}</h2>${body}
      <div><button id="skip">${i === questions.length - 1 ? 'Pular e buscar' : 'Pular esta pergunta'}</button> <button id="skipall" style="margin-left:.5rem">Ir direto para a busca</button></div>
      <div class="dots">${i + 1} de ${questions.length}</div></div>`;
    ov.querySelectorAll('.opts button[data-n]').forEach((b) => (b.onclick = () => { answers.push({ question_id: qq.id, value_num: Number(b.dataset.n) }); next(); }));
    ov.querySelectorAll('.opts button[data-t]').forEach((b) => (b.onclick = () => { answers.push({ question_id: qq.id, value_text: b.dataset.t }); next(); }));
    $('#ok', ov) && ($('#ok', ov).onclick = () => { const v = $('#txt').value.trim(); if (v) answers.push({ question_id: qq.id, value_text: v }); next(); });
    $('#skip', ov).onclick = next;
    $('#skipall', ov).onclick = () => { answers.length ? finish() : closeOverlay(); };
  }
  render();
}

// giro suave do mapa após localizar
map.on('moveend', () => { if (spinning) { spinning = false; map.easeTo({ bearing: map.getBearing() + 20, duration: 9000, easing: (t) => t }); } });
startFlow();
// atalho p/ teste: teclado físico
addEventListener('keydown', (e) => { if (ov.classList.contains('show') || $('#kb').style.display === 'none') return;
  if (e.key.length === 1 || e.key === 'Backspace') { e.key === 'Backspace' ? (q.value = q.value.slice(0, -1)) : (q.value += e.key); clearTimeout(timer); timer = setTimeout(doSearch, 250); } });
