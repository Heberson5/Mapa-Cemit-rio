// Editor do mapa: demarcar jazigos, desenhar limite do cemitério, definir entrada e reposicionar tudo.
import { $, $$, esc, api, createCemeteryMap, rectAt, rotateGeom, moveGeomTo, centroid, KIND, STATUS_COLORS, STATUS_LABEL, TYPE_COLORS } from '/core.js';
import { toast, modal, go, plotForm, decForm } from '/admin.js';

const nextCode = (code, i) => {
  if (!i) return code;
  const m = code.match(/^(.*?)(\d+)(\D*)$/);
  return m ? m[1] + String(Number(m[2]) + i).padStart(m[2].length, '0') + m[3] : `${code}-${i + 1}`;
};
const lastNum = (code) => (code.match(/(\d+)\D*$/) || [])[1] || '';

export async function mapView(main, ctx) {
  main.innerHTML = `<div class="mapview"><div class="side" id="side"></div><div id="amap"><div class="mapbox" id="mb"></div><div class="hud" id="hud"></div><div class="legend" id="lg"></div></div></div>`;
  ctx.cfg = await api('/api/config');
  const cfg = ctx.cfg, types = cfg.types;
  const st = { mode: 'select', draft: [], sel: null, pending: null, unmapped: [], rot: 0, last: { type: '1G', code: '', quadra: '', alameda: '', count: 1, gap: 0.4 } };
  const map = await createCemeteryMap($('#mb'), cfg, { colorMode: 'status', free: true });
  const cem = map.cem;
  map.addSource('ghost', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'ghost-fill', type: 'fill', source: 'ghost', paint: { 'fill-color': '#2fe0ff', 'fill-opacity': 0.35 } });
  map.addLayer({ id: 'ghost-line', type: 'line', source: 'ghost', paint: { 'line-color': '#2fe0ff', 'line-width': 2 } });
  map.addLayer({ id: 'ghost-pts', type: 'circle', source: 'ghost', filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 5, 'circle-color': '#fff', 'circle-stroke-color': '#2fe0ff', 'circle-stroke-width': 2 } });
  const setGhost = (features = []) => map.getSource('ghost').setData({ type: 'FeatureCollection', features });
  const feat = (geometry) => ({ type: 'Feature', geometry, properties: {} });

  async function reloadPlots() { await cem.load(); if (st.sel) cem.select(st.sel); await loadUnmapped(); }
  async function loadUnmapped() { st.unmapped = (await api('/api/admin/plots?unmapped=1&limit=400')).plots; }
  await loadUnmapped(); await cem.load();

  // ---------- painel lateral ----------
  const MODES = [['select', '👆 Selecionar'], ['place', '➕ Colocar jazigo'], ['poly', '✏️ Desenhar forma'], ['move', '✥ Mover selecionado'], ['boundary', '⬡ Limite do cemitério'], ['entrance', '🚪 Definir entrada'], ['recenter', '📍 Reposicionar tudo']];
  const HELP = {
    select: 'Clique em um jazigo para ver e editar.', place: 'Clique no mapa para posicionar. A pré-visualização segue o mouse.',
    poly: 'Clique para marcar os cantos; duplo clique (ou "Concluir") finaliza. Esc cancela.', move: 'Selecione um jazigo e clique no novo local.',
    boundary: 'Clique nos cantos do limite do cemitério; duplo clique (ou "Concluir") finaliza.', entrance: 'Clique no local do portão de entrada (origem da rota no totem).',
    recenter: 'Dê zoom até o cemitério REAL e clique no centro dele: todo o layout (jazigos, limite, entrada) é deslocado para lá.',
  };
  function setMode(m) {
    st.mode = m; st.draft = []; setGhost();
    m === 'poly' || m === 'boundary' ? map.doubleClickZoom.disable() : map.doubleClickZoom.enable();
    map.getCanvas().style.cursor = ['select'].includes(m) ? '' : 'crosshair'; renderSide(); hud();
  }
  const hud = (extra = '') => { $('#hud').innerHTML = `<b>${MODES.find((x) => x[0] === st.mode)[1]}</b> — ${HELP[st.mode]} ${extra}`; };
  function renderLegend() {
    const m = cem.colorMode;
    $('#lg').innerHTML = m === 'status' ? Object.entries(STATUS_LABEL).map(([k, l]) => `<div><span class="sw" style="background:${STATUS_COLORS[k]}"></span>${l}</div>`).join('')
      : m === 'type' ? Object.entries(types).map(([k, t]) => `<div><span class="sw" style="background:${TYPE_COLORS[k]}"></span>${k}</div>`).join('')
      : '<div><span class="sw" style="background:#9ad07f"></span>poucas consultas</div><div><span class="sw" style="background:#e5383b"></span>muitas consultas</div><div><span class="sw" style="background:#59707a"></span>nenhuma</div>';
  }
  async function setColor(m) {
    if (m === 'heat') { const s = await api(`/api/admin/stats?from=${ctx.period.from}&to=${ctx.period.to}`); cem.heat = Object.fromEntries(s.heat.map((h) => [h.id, h.n])); toast(`Mapa de calor: consultas de ${ctx.period.from} a ${ctx.period.to}`); }
    cem.recolor(m); renderLegend();
  }
  function renderSide() {
    const L = st.last;
    $('#side').innerHTML = `<div class="tools">${MODES.map(([k, l]) => `<button data-m="${k}" class="${st.mode === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <label>Colorir por</label><select id="cm"><option value="status">Ocupação</option><option value="type">Tipo de jazigo</option><option value="heat">Consultas (mapa de calor)</option></select>
      <label><input type="checkbox" id="mask" style="width:auto"> Ocultar imagem fora do limite (como no totem)</label>
      ${st.mode === 'place' || st.mode === 'poly' ? placeForm() : ''}
      ${st.mode === 'boundary' || st.mode === 'poly' ? `<div class="row2" style="margin-top:.8rem"><button class="primary" id="finish">Concluir (${st.draft.length} pontos)</button><button id="cancel">Cancelar</button></div>` : ''}
      <div id="selbox"></div>`;
    $('#cm').value = cem.colorMode; $('#mask').checked = maskOn;
    $('#cm').onchange = (e) => setColor(e.target.value); $('#mask').onchange = (e) => { maskOn = e.target.checked; cem.setMask(maskOn); };
    $$('.tools button', $('#side')).forEach((b) => (b.onclick = () => setMode(b.dataset.m)));
    $('#finish') && ($('#finish').onclick = finishDraft); $('#cancel') && ($('#cancel').onclick = () => setMode(st.mode));
    bindPlaceForm(); renderSel();
  }
  let maskOn = false;

  function placeForm() {
    const L = st.last, pend = st.pending;
    return `<h3>Novo jazigo</h3>
    <label>Jazigo já cadastrado, ainda sem demarcação (${st.unmapped.length})</label>
    <select id="pend"><option value="">— criar um novo —</option>${st.unmapped.map((p) => `<option value="${p.id}" ${pend === p.id ? 'selected' : ''}>${esc(p.code)} · ${p.type}</option>`).join('')}</select>
    <div class="f2"><div><label>Tipo</label><select id="ptype" ${pend ? 'disabled' : ''}>${Object.entries(types).map(([k, t]) => `<option value="${k}" ${L.type === k ? 'selected' : ''}>${k} – ${esc(t.label.slice(0, 28))}</option>`).join('')}</select></div>
    <div><label>Código</label><input id="pcode" value="${esc(pend ? st.unmapped.find((p) => p.id === pend)?.code : L.code)}" ${pend ? 'disabled' : ''} placeholder="ex.: A-1-001"></div>
    <div><label>Quadra</label><input id="pq" value="${esc(L.quadra)}" ${pend ? 'disabled' : ''}></div><div><label>Alameda</label><input id="pa" value="${esc(L.alameda)}" ${pend ? 'disabled' : ''}></div>
    <div><label>Quantidade em fileira</label><input id="pn" type="number" min="1" max="80" value="${pend ? 1 : L.count}" ${pend || st.mode === 'poly' ? 'disabled' : ''}></div><div><label>Espaço entre (m)</label><input id="pg" type="number" step="0.1" min="0" value="${L.gap}"></div></div>
    <label>Rotação: <b id="rv">${st.rot}</b>°</label><input id="prot" type="range" min="-180" max="180" step="1" value="${st.rot}">
    <small class="m">Tamanho padrão: ${types[pend ? st.unmapped.find((p) => p.id === pend)?.type : L.type]?.w} × ${types[pend ? st.unmapped.find((p) => p.id === pend)?.type : L.type]?.h} m. Códigos terminados em número são incrementados na fileira (A-1-001, A-1-002…).</small>`;
  }
  function bindPlaceForm() {
    if (!$('#pend')) return;
    $('#pend').onchange = (e) => { st.pending = e.target.value ? Number(e.target.value) : null; renderSide(); };
    const sync = () => { const L = st.last; if (!st.pending) { L.type = $('#ptype').value; L.code = $('#pcode').value; L.quadra = $('#pq').value; L.alameda = $('#pa').value; } if (!$('#pn').disabled) L.count = Math.max(1, Math.min(80, Number($('#pn').value) || 1)); L.gap = Number($('#pg').value) || 0; };
    ['ptype', 'pcode', 'pq', 'pa', 'pn', 'pg'].forEach((id) => ($('#' + id).oninput = sync));
    $('#ptype').onchange = () => { sync(); renderSide(); };
    $('#prot').oninput = (e) => { st.rot = Number(e.target.value); $('#rv').textContent = st.rot; };
  }
  const spec = () => { const pend = st.pending && st.unmapped.find((p) => p.id === st.pending); const L = st.last; return { type: pend ? pend.type : L.type, code: pend ? pend.code : L.code, count: pend || st.mode === 'poly' ? 1 : L.count, pend }; };

  // ---------- jazigo selecionado ----------
  async function selectPlot(id, fly) {
    st.sel = id; const f = cem.select(id); renderSel();
    if (f && fly) { const c = centroid(f.geometry); map.flyTo({ center: c, zoom: 19.5, pitch: 55, duration: 1500 }); }
  }
  async function renderSel() {
    const box = $('#selbox'); if (!box) return;
    if (!st.sel) { box.innerHTML = '<p><small class="m">Nenhum jazigo selecionado.</small></p>'; return; }
    let p; try { p = await api('/api/admin/plots/' + st.sel); } catch { box.innerHTML = ''; return; }
    box.innerHTML = `<h3>${esc(p.code)} <small class="m">${p.type}</small></h3>
      <div><span class="sw" style="background:${STATUS_COLORS[p.status]}"></span>${STATUS_LABEL[p.status]} · ${p.occ}/${p.cap} gavetas${p.reserved ? ' · reservado' + (p.reserved_for ? ' p/ ' + esc(p.reserved_for) : '') : ''}</div>
      <small class="m">${esc([p.quadra, p.alameda, p.lote && 'Lote ' + p.lote].filter(Boolean).join(' · '))}${p.geometry ? '' : ' · <b style="color:var(--warn)">sem demarcação</b>'}</small>
      <div class="row2" style="margin:.7rem 0"><button id="ed">Editar dados</button><button id="adddec">+ Falecido</button></div>
      ${p.geometry ? `<div class="row2"><span class="m">Girar:</span><button data-r="-5">−5°</button><button data-r="-1">−1°</button><button data-r="1">+1°</button><button data-r="5">+5°</button></div>
      <div class="row2" style="margin-top:.5rem"><button id="mv">✥ Mover</button><button id="ungeo" class="danger">Remover demarcação</button></div>` : '<p><button id="mkgeo" class="primary">Demarcar este jazigo no mapa</button></p>'}
      <h3>Ocupação</h3>${p.deceased.length ? p.deceased.map((d) => `<div class="box" style="margin:.4rem 0;padding:.5rem .7rem;cursor:pointer" data-d="${d.id}"><b>${esc(d.name)}</b><br><small class="m">${KIND[d.kind]}${d.drawer ? ' · gaveta ' + d.drawer : ''}${d.death_date ? ' · † ' + d.death_date : ''}</small></div>`).join('') : '<small class="m">Nenhum cadastro.</small>'}
      <p><button class="danger" id="delp" style="margin-top:.8rem">Excluir jazigo</button></p>`;
    $('#ed').onclick = () => plotForm(p, async () => { await reloadPlots(); renderSel(); });
    $('#adddec').onclick = () => decForm({ plot_code: p.code }, renderSel);
    $$('[data-d]', box).forEach((el) => (el.onclick = () => decForm(p.deceased.find((d) => d.id == el.dataset.d), renderSel)));
    $$('[data-r]', box).forEach((b) => (b.onclick = async () => { await patchGeom(p.id, rotateGeom(p.geometry, Number(b.dataset.r))); renderSel(); }));
    $('#mv') && ($('#mv').onclick = () => setMode('move'));
    $('#ungeo') && ($('#ungeo').onclick = async () => { await api(`/api/admin/plots/${p.id}/geometry`, { method: 'PATCH', body: { geometry: null } }); st.sel = null; await reloadPlots(); renderSide(); });
    $('#mkgeo') && ($('#mkgeo').onclick = () => { st.pending = p.id; setMode('place'); });
    $('#delp').onclick = async () => { if (confirm(`Excluir o jazigo ${p.code}?`)) { await api('/api/admin/plots/' + p.id, { method: 'DELETE' }); st.sel = null; cem.select(-1); await reloadPlots(); renderSide(); } };
  }
  async function patchGeom(id, geometry) { await api(`/api/admin/plots/${id}/geometry`, { method: 'PATCH', body: { geometry } }); await cem.load(); cem.select(id); }

  // ---------- ações no mapa ----------
  const offsetCenter = ([lng, lat], meters, deg) => { const k = { lat: 111320, lng: 111320 * Math.cos((lat * Math.PI) / 180) }, a = (deg * Math.PI) / 180; return [lng + (meters * Math.cos(a)) / k.lng, lat + (meters * Math.sin(a)) / k.lat]; };
  const placeGeoms = (lngLat) => { const s = spec(), t = types[s.type], g = st.last.gap; return Array.from({ length: s.count }, (_, i) => rectAt(offsetCenter(lngLat, i * (t.w + g), st.rot), t.w, t.h, st.rot)); };

  async function doPlace(lngLat) {
    const s = spec(); if (!s.pend && !s.code.trim()) return toast('Informe o código do jazigo (ou escolha um já cadastrado).', true);
    const geoms = placeGeoms(lngLat); let ok = 0, dup = 0;
    for (let i = 0; i < geoms.length; i++) {
      try {
        if (s.pend) await api(`/api/admin/plots/${s.pend.id}/geometry`, { method: 'PATCH', body: { geometry: geoms[i] } });
        else { const code = nextCode(s.code.trim(), i); await api('/api/admin/plots', { method: 'POST', body: { code, type: s.type, quadra: st.last.quadra, alameda: st.last.alameda, lote: lastNum(code), geometry: geoms[i] } }); }
        ok++;
      } catch (e) { if (e.status === 409) dup++; else throw e; }
    }
    if (!s.pend) st.last.code = nextCode(s.code.trim(), geoms.length);
    toast(`${ok} jazigo(s) demarcado(s)${dup ? ` · ${dup} código(s) já existiam` : ''}`, !!dup && !ok);
    if (s.pend) { const idx = st.unmapped.findIndex((p) => p.id === s.pend.id); st.pending = st.unmapped[idx + 1]?.id ?? null; }
    await reloadPlots(); renderSide();
  }
  async function finishDraft() {
    const pts = st.draft; const need = st.mode === 'boundary' ? 3 : 3;
    if (pts.length < need) return toast('Marque pelo menos 3 pontos.', true);
    const geometry = { type: 'Polygon', coordinates: [[...pts, pts[0]]] };
    if (st.mode === 'boundary') {
      await api('/api/admin/config', { method: 'PUT', body: { boundary: geometry } }); cem.setBoundary(geometry); toast('Limite do cemitério salvo');
    } else {
      const s = spec(); if (!s.pend && !s.code.trim()) return toast('Informe o código do jazigo.', true);
      if (s.pend) await api(`/api/admin/plots/${s.pend.id}/geometry`, { method: 'PATCH', body: { geometry } });
      else { try { await api('/api/admin/plots', { method: 'POST', body: { code: s.code.trim(), type: s.type, quadra: st.last.quadra, alameda: st.last.alameda, lote: lastNum(s.code), geometry } }); st.last.code = nextCode(s.code.trim(), 1); }
        catch (e) { return toast(e.message, true); } }
      toast('Jazigo demarcado'); await reloadPlots();
    }
    st.draft = []; setGhost(); renderSide();
  }
  const drawDraft = (cursor) => {
    const pts = cursor ? [...st.draft, cursor] : st.draft; const fs = st.draft.map((p) => feat({ type: 'Point', coordinates: p }));
    if (pts.length >= 2) fs.push(feat(pts.length >= 3 ? { type: 'Polygon', coordinates: [[...pts, pts[0]]] } : { type: 'LineString', coordinates: pts }));
    setGhost(fs);
  };

  map.on('mousemove', (e) => {
    const ll = [e.lngLat.lng, e.lngLat.lat];
    if (st.mode === 'place') setGhost(placeGeoms(ll).map(feat));
    else if (st.mode === 'poly' || st.mode === 'boundary') { if (st.draft.length) drawDraft(ll); }
    else if (st.mode === 'select') map.getCanvas().style.cursor = map.queryRenderedFeatures(e.point, { layers: ['plots-3d'] }).length ? 'pointer' : '';
  });
  map.on('click', async (e) => {
    const ll = [e.lngLat.lng, e.lngLat.lat];
    try {
      if (st.mode === 'select') { const f = map.queryRenderedFeatures(e.point, { layers: ['plots-3d'] })[0]; if (f) selectPlot(f.properties.id); else { st.sel = null; cem.select(-1); renderSel(); } }
      else if (st.mode === 'place') await doPlace(ll);
      else if (st.mode === 'poly' || st.mode === 'boundary') { st.draft.push(ll); drawDraft(); $('#finish') && ($('#finish').textContent = `Concluir (${st.draft.length} pontos)`); }
      else if (st.mode === 'move') {
        if (!st.sel) return toast('Selecione um jazigo antes.', true);
        const f = cem.features.find((x) => x.properties.id === st.sel); await patchGeom(st.sel, moveGeomTo(f.geometry, ll)); toast('Jazigo movido'); setMode('select'); renderSel();
      } else if (st.mode === 'entrance') { await api('/api/admin/config', { method: 'PUT', body: { entrance: ll } }); toast('Entrada definida'); setMode('select'); }
      else if (st.mode === 'recenter') {
        const [cx, cy] = cfg.center; if (!confirm('Mover TODO o layout (jazigos, limite e entrada) para este ponto?')) return;
        await api('/api/admin/recenter', { method: 'POST', body: { dLng: ll[0] - cx, dLat: ll[1] - cy } }); toast('Mapa reposicionado'); go('map');
      }
    } catch (err) { toast(err.message, true); }
  });
  map.on('dblclick', (e) => { if (st.mode === 'poly' || st.mode === 'boundary') { st.draft.pop(); finishDraft(); } });
  const onKey = (e) => { if (!document.body.contains($('#mb'))) return removeEventListener('keydown', onKey);
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    if (e.key === 'Escape') setMode('select'); if (e.key === 'Enter' && (st.mode === 'poly' || st.mode === 'boundary')) finishDraft();
    if (e.key === 'r' && st.mode === 'place') { st.rot = ((st.rot + 90 + 180) % 360) - 180; renderSide(); } };
  addEventListener('keydown', onKey);

  renderSide(); hud(); renderLegend();
  if (ctx.focusPlot === 'heat') { await setColor('heat'); $('#cm').value = 'heat'; }
  else if (typeof ctx.focusPlot === 'number') { const f = cem.features.find((x) => x.properties.id === ctx.focusPlot); if (f) selectPlot(ctx.focusPlot, true); else { st.pending = ctx.focusPlot; setMode('place'); toast('Este jazigo ainda não está no mapa: aproxime a vista e clique para posicionar.'); } }
  else if (cfg.boundary) cem.fitBoundary({ duration: 0, pitch: 45 });
}
