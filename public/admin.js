import { $, $$, esc, api, fmtDate, KIND, STATUS_LABEL, STATUS_COLORS, setToken, hasToken } from '/core.js';
import { mapView } from '/admin-map.js';

export const ctx = { cfg: null, period: { from: daysAgo(30), to: today() }, focusPlot: null, heat: null };
function today() { return new Date(Date.now() - 4 * 3600e3).toISOString().slice(0, 10); }
function daysAgo(n) { return new Date(Date.now() - 4 * 3600e3 - n * 864e5).toISOString().slice(0, 10); }

export function toast(msg, err) { const t = document.createElement('div'); t.className = 'toast' + (err ? ' err' : ''); t.textContent = msg; document.body.append(t); setTimeout(() => t.remove(), err ? 5000 : 2400); }
export function modal(html) {
  const m = document.createElement('div'); m.className = 'modal'; m.innerHTML = `<div>${html}</div>`; document.body.append(m);
  m.addEventListener('mousedown', (e) => { if (e.target === m) m.remove(); }); m.close = () => m.remove(); return m;
}
const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { if (e.status === 401) return showLogin(); toast(e.message, true); } };
export const call = (path, opts) => api(path, opts);

// ---------- navegação ----------
const VIEWS = [['dash', '📊 Consultas'], ['map', '🗺️ Mapa / Demarcação'], ['plots', '⚰️ Jazigos'], ['dec', '👤 Falecidos'], ['import', '📥 Importar planilha'], ['nps', '⭐ Pesquisa / NPS'], ['cfg', '⚙️ Configurações']];
const nav = $('#nav');
nav.innerHTML = '<h1>Memorial Santa Cruz<small>Gestão do cemitério</small></h1>' + VIEWS.map(([k, l]) => `<a data-v="${k}">${l}</a>`).join('') +
  '<div class="sp"></div><a href="/" target="_blank">🖥️ Abrir totem</a><a id="logout">Sair</a>';
nav.onclick = (e) => { const a = e.target.closest('a[data-v]'); if (a) go(a.dataset.v); };
$('#logout').onclick = () => { setToken(null); showLogin(); };
let current = null;
export function go(v, arg) {
  current = v; location.hash = v; ctx.focusPlot = arg ?? null;
  $$('nav a[data-v]').forEach((a) => a.classList.toggle('on', a.dataset.v === v));
  const main = $('#main'); main.innerHTML = '';
  guard(async () => { await ({ dash, map: mapView, plots, dec, import: importView, nps, cfg: settings }[v] || dash)(main, ctx); })();
}
const page = (main, html) => { main.innerHTML = `<div class="page">${html}</div>`; return main.firstElementChild; };

// ---------- login ----------
function showLogin() {
  $('#login').hidden = false;
  $('#lf').onsubmit = async (e) => {
    e.preventDefault(); const f = new FormData(e.target);
    try { const r = await api('/api/login', { method: 'POST', body: { user: f.get('user'), password: f.get('password') } }); setToken(r.token); $('#login').hidden = true; boot(r.defaultPassword); }
    catch (er) { $('#lerr').textContent = er.message; }
  };
}

// ---------- gráficos simples ----------
const bars = (rows, { color } = {}) => { const max = Math.max(1, ...rows.map((r) => Math.abs(r.n))); return rows.length ? rows.map((r) => `<div class="bar"><span class="l" title="${esc(r.label)}">${esc(r.label)}</span><i style="width:${(Math.abs(r.n) / max) * 100}%;${r.n < 0 ? 'background:var(--bad)' : color ? 'background:' + color : ''}"></i><b>${r.n}</b></div>`).join('') : '<small class="m">Sem dados no período.</small>'; };
const cols = (rows) => { const max = Math.max(1, ...rows.map((r) => r.n)); return rows.length ? `<div class="cols">${rows.map((r) => `<i style="height:${(r.n / max) * 100}%" title="${esc(r.label)}: ${r.n}"></i>`).join('')}</div><div style="display:flex;justify-content:space-between;font-size:.75rem;color:var(--muted)"><span>${esc(rows[0].label)}</span><span>${esc(rows.at(-1).label)}</span></div>` : '<small class="m">Sem dados no período.</small>'; };
const csvDownload = (name, rows) => { const csv = rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(';')).join('\n'); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' })); a.download = name; a.click(); };
function periodBar(onChange) {
  const p = ctx.period;
  const el = document.createElement('div'); el.className = 'bar-row';
  el.innerHTML = `<div><label>De</label><input type="date" id="pf" value="${p.from}"></div><div><label>Até</label><input type="date" id="pt" value="${p.to}"></div>
  <button data-d="0">Hoje</button><button data-d="7">7 dias</button><button data-d="30">30 dias</button><button data-d="365">12 meses</button><button data-d="all">Tudo</button>`;
  const apply = () => { p.from = $('#pf', el).value || '1970-01-01'; p.to = $('#pt', el).value || today(); onChange(); };
  el.onchange = apply;
  el.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; const d = b.dataset.d; p.from = d === 'all' ? '1970-01-01' : daysAgo(Number(d)); p.to = today(); onChange(); };
  return el;
}

// ---------- painel de consultas ----------
async function dash(main) {
  const root = page(main, '<h2>Consultas no totem</h2><div id="pb"></div><div id="dc"></div>');
  $('#pb', root).append(periodBar(load));
  async function load() {
    $('#pf') && ($('#pf').value = ctx.period.from, $('#pt').value = ctx.period.to);
    const s = await api(`/api/admin/stats?from=${ctx.period.from}&to=${ctx.period.to}&groupDay=${ctx.period.from < daysAgo(120) ? 'month' : 'day'}`);
    ctx.heat = Object.fromEntries(s.heat.map((h) => [h.id, h.n]));
    const t = s.totals, pct = t.plots ? Math.round((t.mapped / t.plots) * 100) : 0;
    $('#dc').innerHTML = `
    <div class="grid g4">
      <div class="box kpi"><b>${t.views}</b><span>Consultas (falecidos localizados)</span></div>
      <div class="box kpi"><b>${t.searches}</b><span>Buscas realizadas</span></div>
      <div class="box kpi"><b>${t.noResults}</b><span>Buscas sem resultado</span></div>
      <div class="box kpi"><b>${t.deceased}</b><span>Falecidos cadastrados</span></div>
      <div class="box kpi"><b>${t.mapped}/${t.plots}</b><span>Jazigos demarcados (${pct}%)</span></div>
    </div>
    <div class="grid g2" style="margin-top:1rem">
      <div class="box"><h3 style="margin-top:0">Consultas por ${ctx.period.from < daysAgo(120) ? 'mês' : 'dia'}</h3>${cols(s.series)}</div>
      <div class="box"><h3 style="margin-top:0">Horário de maior movimento</h3>${cols(s.hours.map((h) => ({ label: h.label + 'h', n: h.n })))}</div>
      <div class="box"><h3 style="margin-top:0">Por quadra</h3>${bars(s.byQuadra)}</div>
      <div class="box"><h3 style="margin-top:0">Por alameda</h3>${bars(s.byAlameda)}</div>
      <div class="box"><h3 style="margin-top:0">Por tipo de jazigo</h3>${bars(s.byType)}</div>
      <div class="box"><h3 style="margin-top:0">Por situação do falecido</h3>${bars(s.byKind.map((k) => ({ ...k, label: KIND[k.label] || k.label })))}</div>
      <div class="box"><h3 style="margin-top:0">Falecidos mais consultados <button id="x1" style="float:right;padding:.2em .7em">CSV</button></h3>${bars(s.byDeceased.map((r) => ({ label: `${r.label} (${r.plot || '—'})`, n: r.n })))}</div>
      <div class="box"><h3 style="margin-top:0">Jazigos mais consultados <button id="x2" style="float:right;padding:.2em .7em">CSV</button> <button id="heat" style="float:right;padding:.2em .7em;margin-right:.4rem">Mapa de calor</button></h3>${bars(s.byPlot.map((r) => ({ label: `${r.label} · ${r.type}`, n: r.n })))}</div>
      <div class="box"><h3 style="margin-top:0">Termos buscados sem resultado</h3>${bars(s.missedTerms)}<small class="m">Ajuda a achar cadastros faltantes ou grafias diferentes.</small></div>
    </div>`;
    $('#x1').onclick = () => csvDownload('consultas-por-falecido.csv', [['Falecido', 'Jazigo', 'Consultas'], ...s.byDeceased.map((r) => [r.label, r.plot, r.n])]);
    $('#x2').onclick = () => csvDownload('consultas-por-jazigo.csv', [['Jazigo', 'Tipo', 'Consultas'], ...s.byPlot.map((r) => [r.label, r.type, r.n])]);
    $('#heat').onclick = () => go('map', 'heat');
  }
  guard(load)();
}

// ---------- jazigos ----------
export async function plotForm(p = {}, onSaved) {
  const types = ctx.cfg.types;
  const m = modal(`<h2 style="margin-top:0">${p.id ? 'Editar jazigo' : 'Novo jazigo'}</h2><form id="pf">
    <div class="f2"><div><label>Código *</label><input name="code" required value="${esc(p.code)}"></div>
    <div><label>Tipo *</label><select name="type">${Object.entries(types).map(([k, t]) => `<option value="${k}" ${p.type === k ? 'selected' : ''}>${k} – ${esc(t.label)}</option>`).join('')}</select></div>
    <div><label>Quadra</label><input name="quadra" value="${esc(p.quadra)}"></div><div><label>Alameda</label><input name="alameda" value="${esc(p.alameda)}"></div>
    <div><label>Lote</label><input name="lote" value="${esc(p.lote)}"></div><div><label>Reservado para</label><input name="reserved_for" value="${esc(p.reserved_for)}"></div></div>
    <label><input type="checkbox" name="reserved" style="width:auto" ${p.reserved ? 'checked' : ''}> Jazigo reservado</label>
    <label>Observações</label><textarea name="notes" rows="2">${esc(p.notes)}</textarea>
    <div class="row2" style="margin-top:1rem"><button class="primary">Salvar</button><button type="button" id="cn">Cancelar</button></div></form>`);
  $('#cn', m).onclick = m.close;
  $('#pf', m).onsubmit = guard(async (e) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); f.reserved = !!f.reserved; f.geometry = p.geometry;
    await api(p.id ? `/api/admin/plots/${p.id}` : '/api/admin/plots', { method: p.id ? 'PUT' : 'POST', body: f }); m.close(); toast('Jazigo salvo'); onSaved?.(); });
}
async function plots(main) {
  const root = page(main, `<h2>Jazigos</h2><div class="bar-row"><div style="flex:1"><label>Buscar (código, quadra, alameda)</label><input id="q"></div>
    <div><label>Tipo</label><select id="t"><option value="">Todos</option>${Object.keys(ctx.cfg.types).map((k) => `<option>${k}</option>`).join('')}</select></div>
    <div><label>Demarcação</label><select id="u"><option value="">Todos</option><option value="1">Sem demarcação no mapa</option></select></div><button class="primary" id="new">+ Novo jazigo</button></div><div class="box" id="tb"></div>`);
  const load = guard(async () => {
    const r = await api(`/api/admin/plots?q=${encodeURIComponent($('#q').value)}&type=${$('#t').value}&unmapped=${$('#u').value}&limit=300`);
    $('#tb').innerHTML = `<small class="m">${r.total} jazigo(s)${r.total > 300 ? ' — mostrando 300; refine a busca' : ''}</small><table><tr><th>Código</th><th>Tipo</th><th>Quadra</th><th>Alameda</th><th>Lote</th><th>Ocupação</th><th>Situação</th><th>No mapa</th><th></th></tr>
    ${r.plots.map((p) => `<tr><td><b>${esc(p.code)}</b></td><td>${p.type}</td><td>${esc(p.quadra)}</td><td>${esc(p.alameda)}</td><td>${esc(p.lote)}</td><td>${p.occ}/${p.cap}</td>
      <td><span class="sw" style="background:${STATUS_COLORS[p.status]}"></span>${STATUS_LABEL[p.status]}</td><td>${p.mapped ? '✔' : '<span style="color:var(--warn)">pendente</span>'}</td>
      <td style="white-space:nowrap"><button data-map="${p.id}" style="padding:.2em .6em">${p.mapped ? 'Ver no mapa' : 'Demarcar'}</button> <button data-ed="${p.id}" style="padding:.2em .6em">Editar</button> <button class="danger" data-del="${p.id}" style="padding:.2em .6em">✕</button></td></tr>`).join('')}</table>`;
  });
  let t; $('#q').oninput = () => { clearTimeout(t); t = setTimeout(load, 250); }; $('#t').onchange = $('#u').onchange = load;
  $('#new').onclick = () => plotForm({}, load);
  $('#tb').onclick = guard(async (e) => { const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.map) return go('map', Number(b.dataset.map));
    if (b.dataset.ed) return plotForm(await api('/api/admin/plots/' + b.dataset.ed), load);
    if (b.dataset.del && confirm('Excluir este jazigo? Os falecidos vinculados ficarão sem jazigo.')) { await api('/api/admin/plots/' + b.dataset.del, { method: 'DELETE' }); load(); } });
  load();
}

// ---------- falecidos ----------
export async function decForm(d = {}, onSaved) {
  const m = modal(`<h2 style="margin-top:0">${d.id ? 'Editar cadastro' : 'Novo falecido'}</h2><form id="df">
    <label>Nome completo *</label><input name="name" required value="${esc(d.name)}">
    <div class="f2"><div><label>Situação</label><select name="kind">${Object.entries(KIND).map(([k, l]) => `<option value="${k}" ${d.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <div><label>Data do evento (sepultamento / exumação / cinzas)</label><input type="date" name="event_date" value="${d.event_date || ''}"></div>
    <div><label>Nascimento</label><input type="date" name="birth_date" value="${d.birth_date || ''}"></div><div><label>Falecimento</label><input type="date" name="death_date" value="${d.death_date || ''}"></div>
    <div><label>Código do jazigo</label><input name="plot_code" value="${esc(d.plot_code)}" placeholder="ex.: A-1-001"></div><div><label>Gaveta nº (1 = mais baixa)</label><input type="number" min="1" name="drawer" value="${d.drawer || ''}"></div>
    <div><label>Responsável</label><input name="responsible" value="${esc(d.responsible)}"></div><div><label>Telefone</label><input name="phone" value="${esc(d.phone)}"></div></div>
    <label>Observações</label><textarea name="notes" rows="2">${esc(d.notes)}</textarea>
    <div class="row2" style="margin-top:1rem"><button class="primary">Salvar</button><button type="button" id="cn">Cancelar</button>${d.id ? '<button type="button" class="danger" id="rm" style="margin-left:auto">Excluir</button>' : ''}</div></form>`);
  $('#cn', m).onclick = m.close;
  $('#rm', m) && ($('#rm', m).onclick = guard(async () => { if (confirm('Excluir este cadastro?')) { await api('/api/admin/deceased/' + d.id, { method: 'DELETE' }); m.close(); onSaved?.(); } }));
  $('#df', m).onsubmit = guard(async (e) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); const code = f.plot_code.trim(); delete f.plot_code;
    f.plot_id = null;
    if (code) { const r = await api(`/api/admin/plots?q=${encodeURIComponent(code)}&limit=100`); const p = r.plots.find((x) => x.code.toLowerCase() === code.toLowerCase());
      if (!p) return toast(`Jazigo "${code}" não encontrado. Cadastre-o primeiro em Jazigos.`, true); f.plot_id = p.id; }
    f.drawer = f.drawer ? Number(f.drawer) : null;
    await api(d.id ? `/api/admin/deceased/${d.id}` : '/api/admin/deceased', { method: d.id ? 'PUT' : 'POST', body: f }); m.close(); toast('Cadastro salvo'); onSaved?.(); });
}
async function dec(main) {
  const root = page(main, `<h2>Falecidos</h2><div class="bar-row"><div style="flex:1"><label>Buscar por nome</label><input id="q"></div>
    <div><label>Situação</label><select id="k"><option value="">Todas</option>${Object.entries(KIND).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div>
    <div><label>Vínculo</label><select id="u"><option value="">Todos</option><option value="1">Sem jazigo</option></select></div><button class="primary" id="new">+ Novo cadastro</button></div><div class="box" id="tb"></div>`);
  let off = 0;
  const load = guard(async () => {
    const r = await api(`/api/admin/deceased?q=${encodeURIComponent($('#q').value)}&kind=${$('#k').value}&unlinked=${$('#u').value}&limit=50&offset=${off}`);
    $('#tb').innerHTML = `<small class="m">${r.total} cadastro(s)</small><table><tr><th>Nome</th><th>Situação</th><th>Falecimento</th><th>Jazigo</th><th>Gaveta</th><th>Local</th><th>Responsável</th></tr>
    ${r.rows.map((d) => `<tr class="clk" data-id="${d.id}"><td><b>${esc(d.name)}</b></td><td>${KIND[d.kind]}</td><td>${fmtDate(d.death_date)}</td><td>${esc(d.plot_code || '—')}</td><td>${d.drawer || '—'}</td><td>${esc([d.quadra, d.alameda].filter(Boolean).join(' · '))}</td><td>${esc(d.responsible)}</td></tr>`).join('')}</table>
    <div class="row2" style="margin-top:.8rem"><button id="pv" ${off ? '' : 'disabled'}>← Anterior</button><button id="nx" ${off + 50 < r.total ? '' : 'disabled'}>Próxima →</button></div>`;
    $('#pv').onclick = () => { off = Math.max(0, off - 50); load(); }; $('#nx').onclick = () => { off += 50; load(); };
    ctx._dec = Object.fromEntries(r.rows.map((d) => [d.id, d]));
  });
  let t; $('#q').oninput = () => { off = 0; clearTimeout(t); t = setTimeout(load, 250); }; $('#k').onchange = $('#u').onchange = () => { off = 0; load(); };
  $('#new').onclick = () => decForm({}, load);
  $('#tb').onclick = (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) decForm(ctx._dec[tr.dataset.id], load); };
  load();
}

// ---------- importação ----------
const SYN = {
  nome: ['nome', 'falecido', 'nomedofalecido', 'nomecompleto', 'name'], data_falecimento: ['datafalecimento', 'falecimento', 'dataobito', 'obito', 'datadofalecimento', 'datadoobito'],
  data_nascimento: ['nascimento', 'datanascimento', 'datadenascimento'], situacao: ['situacao', 'tipo', 'movimento', 'status', 'tipodemovimento', 'servico'],
  data_evento: ['dataevento', 'datasepultamento', 'dataexumacao', 'datadosepultamento', 'datadoevento', 'data'], jazigo: ['jazigo', 'codigo', 'codigojazigo', 'sepultura', 'cod', 'codjazigo', 'numerojazigo'],
  tipo_jazigo: ['tipojazigo', 'tipodejazigo', 'modelo', 'modelojazigo', 'tipodasepultura'], gaveta: ['gaveta', 'numerogaveta', 'gavetan'], quadra: ['quadra'], alameda: ['alameda', 'rua'], lote: ['lote', 'numero', 'num'],
  responsavel: ['responsavel', 'familiar', 'contato', 'nomeresponsavel'], telefone: ['telefone', 'fone', 'celular', 'whatsapp'], observacoes: ['observacoes', 'obs', 'observacao', 'notas'],
};
const nk = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
async function importView(main) {
  const root = page(main, `<h2>Importar cadastros por planilha</h2>
  <div class="box"><p>Envie um arquivo <b>.xlsx</b> ou <b>.csv</b>. A 1ª linha deve ter os títulos das colunas (reconhecemos variações como "Falecido", "Data do óbito", "Sepultura"…).
  Colunas aceitas: <code>nome</code>, <code>data_falecimento</code>, <code>data_nascimento</code>, <code>situacao</code> (sepultamento / exumação / cinzas), <code>data_evento</code>, <code>jazigo</code> (código), <code>tipo_jazigo</code> (1G, 2G, 3G, 3GS, 6GS, FAM), <code>gaveta</code>, <code>quadra</code>, <code>alameda</code>, <code>lote</code>, <code>responsavel</code>, <code>telefone</code>, <code>observacoes</code>.</p>
  <p>Jazigos que ainda não existem são criados <b>sem posição no mapa</b> — depois você os demarca em <i>Mapa / Demarcação</i>. Cadastros repetidos (mesmo nome, data e jazigo) são atualizados, não duplicados.</p>
  <div class="row2"><input type="file" id="file" accept=".xlsx,.xls,.csv" style="max-width:340px"><button id="tpl">Baixar planilha modelo</button></div></div><div id="pv"></div>`);
  $('#tpl').onclick = () => { const ws = XLSX.utils.json_to_sheet([
    { nome: 'Maria da Silva', data_nascimento: '12/03/1940', data_falecimento: '05/01/2024', situacao: 'sepultamento', data_evento: '06/01/2024', jazigo: 'A-1-001', tipo_jazigo: '2G', gaveta: 1, quadra: 'Quadra A', alameda: 'Alameda 1', lote: '1', responsavel: 'João da Silva', telefone: '(65) 99999-0000', observacoes: '' },
    { nome: 'José Pereira', data_nascimento: '', data_falecimento: '10/02/2015', situacao: 'cinzas', data_evento: '12/02/2015', jazigo: 'F-01', tipo_jazigo: 'FAM', gaveta: 3, quadra: 'Anfiteatro', alameda: 'Anel 1', lote: '1', responsavel: '', telefone: '', observacoes: 'Guarda de cinzas (urna)' }]);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Cadastros'); XLSX.writeFile(wb, 'modelo-importacao-cemiterio.xlsx'); };
  $('#file').onchange = guard(async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const wb = XLSX.read(await f.arrayBuffer(), { type: 'array', cellDates: false });
    const raw = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', raw: true });
    if (!raw.length) return toast('Planilha vazia', true);
    const headers = Object.keys(raw[0]), map = {};
    for (const h of headers) for (const [k, syns] of Object.entries(SYN)) if (!Object.values(map).includes(k) && syns.includes(nk(h))) map[h] = k;
    const rows = raw.map((r) => Object.fromEntries(Object.entries(map).map(([h, k]) => [k, r[h]])));
    const ignored = headers.filter((h) => !map[h]);
    $('#pv').innerHTML = `<div class="box" style="margin-top:1rem"><b>${rows.length} linhas</b> · colunas reconhecidas: ${Object.entries(map).map(([h, k]) => `<span class="chip">${esc(h)} → ${k}</span>`).join(' ')}
      ${ignored.length ? `<br><small class="m">Ignoradas: ${ignored.map(esc).join(', ')}</small>` : ''}${map && !Object.values(map).includes('nome') ? '<p style="color:var(--bad)">Não encontrei a coluna "nome".</p>' : ''}
      <div style="max-height:260px;overflow:auto;margin-top:.7rem"><table><tr>${[...new Set(Object.values(map))].map((k) => `<th>${k}</th>`).join('')}</tr>${rows.slice(0, 8).map((r) => `<tr>${[...new Set(Object.values(map))].map((k) => `<td>${esc(r[k])}</td>`).join('')}</tr>`).join('')}</table></div>
      <label><input type="checkbox" id="cp" checked style="width:auto"> Criar automaticamente jazigos não cadastrados</label>
      <div class="row2" style="margin-top:.8rem"><button id="sim">Simular (não grava)</button><button class="primary" id="imp">Importar ${rows.length} linhas</button></div><div id="res"></div></div>`;
    const run = (dry) => guard(async () => { const r = await api('/api/admin/import', { method: 'POST', body: { rows, dryRun: dry, createPlots: $('#cp').checked } });
      $('#res').innerHTML = `<h3>${dry ? 'Simulação' : 'Resultado'}</h3><div class="row2"><span class="chip">${r.created} novos</span><span class="chip">${r.updated} atualizados</span><span class="chip">${r.plotsCreated} jazigos criados</span><span class="chip" style="${r.errors.length ? 'border-color:var(--bad)' : ''}">${r.errors.length} erros</span></div>
      ${r.errors.length ? `<table style="margin-top:.6rem"><tr><th>Linha</th><th>Erro</th></tr>${r.errors.slice(0, 100).map((x) => `<tr><td>${x.linha}</td><td>${esc(x.erro)}</td></tr>`).join('')}</table>` : ''}`;
      if (!dry) toast('Importação concluída'); })();
    $('#sim').onclick = run(true); $('#imp').onclick = run(false);
  });
}

// ---------- pesquisa / NPS ----------
async function nps(main) {
  const root = page(main, '<h2>Pesquisa de satisfação e NPS</h2><div id="pb"></div><div id="nc"></div><h3>Perguntas exibidas no totem</h3><div class="box" id="qs"></div>');
  $('#pb', root).append(periodBar(load));
  async function load() {
    const s = await api(`/api/admin/nps?from=${ctx.period.from}&to=${ctx.period.to}`);
    const n = s.nps, tot = Math.max(1, n.n), sc = n.score, col = sc == null ? 'var(--muted)' : sc >= 50 ? 'var(--ok)' : sc >= 0 ? 'var(--warn)' : 'var(--bad)';
    $('#nc').innerHTML = `<div class="grid g2"><div class="box"><div class="nps-big" style="color:${col}">${sc ?? '—'}</div><div>NPS (${n.n} resposta${n.n === 1 ? '' : 's'} na pergunta NPS · ${s.responses} questionário${s.responses === 1 ? '' : 's'})</div>
      <div class="stack"><i style="width:${(n.promoters / tot) * 100}%;background:var(--ok)"></i><i style="width:${(n.passives / tot) * 100}%;background:var(--warn)"></i><i style="width:${(n.detractors / tot) * 100}%;background:var(--bad)"></i></div>
      <small class="m">Promotores (9–10): ${n.promoters} · Neutros (7–8): ${n.passives} · Detratores (0–6): ${n.detractors}<br>NPS = % promotores − % detratores</small></div>
      <div class="box"><h3 style="margin-top:0">Média por categoria (1–5 / 0–10)</h3>${bars(s.categories.map((c) => ({ label: c.label, n: c.avg })))}</div>
      <div class="box"><h3 style="margin-top:0">NPS por dia</h3>${bars(s.trend.map((t) => ({ label: t.label + ` (${t.n})`, n: t.nps ?? 0 })).slice(-14))}</div></div>
      <h3>Por pergunta</h3><div class="grid g2">${s.questions.map((q) => `<div class="box"><b>${esc(q.text)}</b><br><small class="m">${q.count} resposta(s)${q.avg != null ? ' · média ' + q.avg : ''}</small>
        ${q.dist ? bars(Object.entries(q.dist).sort((a, b) => (isNaN(a[0]) ? 0 : a[0] - b[0])).map(([label, n]) => ({ label, n }))) : ''}
        ${q.texts ? `<div style="max-height:180px;overflow:auto;margin-top:.4rem">${q.texts.map((t) => `<p style="margin:.3rem 0"><small class="m">${t.ts}</small><br>${esc(t.text)}</p>`).join('') || '<small class="m">Sem comentários.</small>'}</div>` : ''}</div>`).join('')}</div>`;
  }
  async function loadQs() {
    const qs = await api('/api/admin/questions'); const T = { nps: 'NPS (0–10)', stars: 'Estrelas (1–5)', choice: 'Múltipla escolha', text: 'Texto livre' };
    $('#qs').innerHTML = `<table><tr><th>#</th><th>Pergunta</th><th>Tipo</th><th>Categoria</th><th>Ativa</th></tr>${qs.map((q) => `<tr class="clk" data-id="${q.id}"><td>${q.position}</td><td>${esc(q.text)}</td><td>${T[q.type]}</td><td>${esc(q.category)}</td><td>${q.active ? '✔' : '—'}</td></tr>`).join('')}</table><button class="primary" id="nq" style="margin-top:.8rem">+ Nova pergunta</button>
    <p><small class="m">As perguntas ativas aparecem no totem antes da busca, nesta ordem. Use categorias como "Ambiente", "Limpeza", "Atendimento" para analisar cada aspecto.</small></p>`;
    const edit = (q = { type: 'stars', active: 1, position: qs.length + 1, options: [] }) => {
      const m = modal(`<h2 style="margin-top:0">${q.id ? 'Editar pergunta' : 'Nova pergunta'}</h2><form id="qf"><label>Pergunta</label><input name="text" required value="${esc(q.text)}">
        <div class="f2"><div><label>Tipo</label><select name="type">${Object.entries(T).map(([k, l]) => `<option value="${k}" ${q.type === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div><div><label>Categoria</label><input name="category" value="${esc(q.category)}" placeholder="Ambiente, Atendimento…"></div>
        <div><label>Ordem</label><input type="number" name="position" value="${q.position}"></div><div><label>&nbsp;</label><label style="margin:.6rem 0"><input type="checkbox" name="active" style="width:auto" ${q.active ? 'checked' : ''}> Ativa no totem</label></div></div>
        <label>Opções (uma por linha — só para múltipla escolha)</label><textarea name="options" rows="4">${esc((q.options || []).join('\n'))}</textarea>
        <div class="row2" style="margin-top:1rem"><button class="primary">Salvar</button><button type="button" id="cn">Cancelar</button>${q.id ? '<button type="button" class="danger" id="rm" style="margin-left:auto">Excluir</button>' : ''}</div></form>`);
      $('#cn', m).onclick = m.close; $('#rm', m) && ($('#rm', m).onclick = guard(async () => { if (confirm('Excluir a pergunta e todas as respostas dela?')) { await api('/api/admin/questions/' + q.id, { method: 'DELETE' }); m.close(); loadQs(); load(); } }));
      $('#qf', m).onsubmit = guard(async (e) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); f.active = !!f.active; f.position = Number(f.position) || 0; f.options = f.options.split('\n').map((s) => s.trim()).filter(Boolean);
        await api(q.id ? '/api/admin/questions/' + q.id : '/api/admin/questions', { method: q.id ? 'PUT' : 'POST', body: f }); m.close(); loadQs(); });
    };
    $('#nq').onclick = () => edit(); $('#qs').onclick = (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) edit(qs.find((q) => q.id == tr.dataset.id)); };
  }
  guard(load)(); guard(loadQs)();
}

// ---------- configurações ----------
async function settings(main) {
  const c = ctx.cfg;
  const root = page(main, `<h2>Configurações</h2><div class="grid g2"><form class="box" id="cf"><h3 style="margin-top:0">Cemitério e totem</h3>
    <label>Nome</label><input name="name" value="${esc(c.name)}"><label>Cidade</label><input name="city" value="${esc(c.city)}">
    <div class="f2"><div><label>Tempo de inatividade do totem (s)</label><input type="number" name="kioskIdleSeconds" value="${c.kioskIdleSeconds}"></div><div><label>Ano da imagem (rótulo)</label><input name="imageryYear" value="${esc(c.imageryYear)}"></div></div>
    <label><input type="checkbox" name="surveyEnabled" style="width:auto" ${c.surveyEnabled ? 'checked' : ''}> Exibir pesquisa (NPS) antes da busca no totem</label>
    <h3>Imagem aérea</h3><label>URL dos tiles (XYZ) — satélite ou ortofoto de drone</label><input name="tileUrl" value="${esc(c.tileUrl)}">
    <div class="f2"><div><label>Zoom máximo nativo dos tiles</label><input type="number" name="tileMaxZoom" value="${c.tileMaxZoom}"></div><div><label>Crédito</label><input name="tileAttribution" value="${esc(c.tileAttribution)}"></div></div>
    <p><small class="m">Padrão: Esri World Imagery (gratuita, resolução variável). Para uma imagem <b>atual e nítida</b> (4K, lápides visíveis no gramado), faça um voo de drone, gere a ortofoto (ex.: WebODM → "XYZ tiles") e cole aqui o endereço, p.ex. <code>https://seu-servidor/tiles/{z}/{x}/{y}.png</code>. Para usar o Google/Mapbox é preciso chave de API e respeitar os termos de uso.</small></p>
    <button class="primary" style="margin-top:.6rem">Salvar</button></form>
    <div class="box"><h3 style="margin-top:0">Posição do cemitério</h3><p>Defina o local real, o limite (cerca/muro) e a entrada no editor: <button id="tomap">Abrir Mapa / Demarcação</button></p>
    <small class="m">Centro atual: ${c.center.map((x) => x.toFixed(6)).join(', ')}</small>
    <h3>Dados de demonstração</h3><p>O sistema veio com um layout fictício para testes. Ao terminar de conferir, apague-o (também zera consultas e respostas de pesquisa).</p><button class="danger" id="demo">Apagar dados de demonstração</button>
    <h3>Acesso</h3><small class="m">Usuário e senha da gestão são definidos pelas variáveis de ambiente <code>ADMIN_USER</code> e <code>ADMIN_PASSWORD</code> do servidor. Troque a senha padrão antes de publicar.</small></div></div>`);
  $('#tomap', root).onclick = () => go('map');
  $('#cf', root).onsubmit = guard(async (e) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target));
    f.surveyEnabled = !!f.surveyEnabled; f.kioskIdleSeconds = Number(f.kioskIdleSeconds) || 60; f.tileMaxZoom = Number(f.tileMaxZoom) || 19;
    await api('/api/admin/config', { method: 'PUT', body: f }); await loadCfg(); toast('Configurações salvas'); });
  $('#demo', root).onclick = guard(async () => { if (confirm('Apagar jazigos e falecidos de demonstração, consultas e respostas?')) { await api('/api/admin/clear-demo', { method: 'POST', body: {} }); toast('Dados de demonstração apagados'); } });
}

async function loadCfg() { ctx.cfg = await api('/api/config'); }
async function boot(defaultPw) {
  await loadCfg();
  if (defaultPw) toast('Atenção: senha padrão em uso. Defina ADMIN_PASSWORD no servidor.', true);
  go(location.hash.slice(1) || 'dash');
}
if (hasToken()) guard(boot)(); else showLogin();
