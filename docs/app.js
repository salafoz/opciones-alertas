'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LS = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// En GitHub Pages el repositorio se deduce de la URL; en localhost se trabaja con los ficheros locales.
const ghHost = location.hostname.match(/^([^.]+)\.github\.io$/);
const REPO = ghHost ? `${ghHost[1]}/${location.pathname.split('/')[1]}` : null;

const FIELDS = [
  ['annPct', 'Rentab. anualizada %'], ['premPct', 'Prima % s/ capital'], ['mid', 'Prima (mid)'],
  ['bid', 'Bid'], ['ask', 'Ask'], ['last', 'Último'], ['spreadPct', 'Spread %'],
  ['dte', 'Días a vencimiento'], ['strike', 'Strike'], ['spot', 'Precio subyacente'], ['otmPct', '% fuera de dinero'],
  ['iv', 'IV %'], ['iv30', 'IV30 subyacente %'], ['delta', 'Delta'], ['absDelta', '|Delta|'],
  ['gamma', 'Gamma'], ['theta', 'Theta'], ['vega', 'Vega'], ['rho', 'Rho'],
  ['volume', 'Volumen'], ['oi', 'Open interest'], ['volOi', 'Volumen / OI'],
];
const FIELD_LABEL = Object.fromEntries(FIELDS);
const OPS = ['>=', '<=', '>', '<', '='];
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

let config = { tickers: [], filters: [] };
let configSha = null;
let index = null, results = null;
let editingId = null;

/* ---------- utilidades ---------- */
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}
const num = (v, d = 2) => (v == null || !Number.isFinite(+v) ? '—' : (+v).toLocaleString('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d }));
const big = (v) => (v == null ? '—' : v >= 1e6 ? num(v / 1e6, 1) + 'M' : v >= 1e4 ? num(v / 1e3, 0) + 'k' : num(v, 0));
const fmtExp = (e) => { const [y, m, d] = e.split('-'); return `${+d} ${MONTHS[+m - 1]} ${y.slice(2)}`; };
const dteOf = (e) => Math.max(0, Math.round((Date.parse(e) - Date.parse(new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }))) / 864e5));
const fmtTime = (iso) => new Date(iso).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const parseTickers = (s) => [...new Set(String(s).toUpperCase().split(/[\s,;]+/).filter((t) => /^[\^A-Z0-9.]{1,8}$/.test(t)))];
const b64decode = (b) => new TextDecoder().decode(Uint8Array.from(atob(b.replace(/\s/g, '')), (c) => c.charCodeAt(0)));
const b64encode = (s) => { let o = ''; for (const b of new TextEncoder().encode(s)) o += String.fromCharCode(b); return btoa(o); };

/* ---------- GitHub ---------- */
async function gh(path, opts = {}) {
  const headers = { Accept: 'application/vnd.github+json', ...(opts.headers || {}) };
  const token = LS.get('token', '');
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com/repos/${REPO}/${path}`, { ...opts, headers, cache: 'no-store' });
  if (!res.ok) throw Object.assign(new Error(`GitHub respondió ${res.status}`), { status: res.status });
  return res;
}
async function getRepoJson(path) {
  if (!REPO) return { json: await (await fetch(`../${path}`, { cache: 'no-store' })).json(), sha: null };
  const f = await (await gh(`contents/${path}?ref=main`)).json();
  return { json: JSON.parse(b64decode(f.content)), sha: f.sha };
}
async function putRepoJson(path, json, sha, message) {
  const body = { message, branch: 'main', content: b64encode(JSON.stringify(json, null, 2) + '\n') };
  if (sha) body.sha = sha;
  return (await (await gh(`contents/${path}`, { method: 'PUT', body: JSON.stringify(body) })).json()).content.sha;
}
async function getData(file) {
  if (!REPO) return (await fetch(`../out/${file}`, { cache: 'no-store' })).json();
  // Sin token la API de GitHub solo admite 60 peticiones/hora: se lee directamente el fichero público.
  if (!LS.get('token', '')) return (await fetch(`https://raw.githubusercontent.com/${REPO}/data/${file}`, { cache: 'no-store' })).json();
  try {
    return await (await gh(`contents/${file}?ref=data`, { headers: { Accept: 'application/vnd.github.raw+json' } })).json();
  } catch {
    return (await fetch(`https://raw.githubusercontent.com/${REPO}/data/${file}`, { cache: 'no-store' })).json();
  }
}

async function saveConfig(message) {
  if (!REPO) { LS.set('devConfig', config); toast('Modo local: guardado solo en este navegador'); return true; }
  if (!LS.get('token', '')) { toast('Falta el token de GitHub: añádelo en Ajustes'); showTab('ajustes'); return false; }
  try {
    try {
      configSha = await putRepoJson('config/config.json', config, configSha, message);
    } catch (e) {
      if (e.status !== 409 && e.status !== 422) throw e;
      configSha = (await getRepoJson('config/config.json')).sha; // otro dispositivo lo cambió: se reintenta
      configSha = await putRepoJson('config/config.json', config, configSha, message);
    }
    return true;
  } catch (e) {
    toast(e.status === 401 || e.status === 403 || e.status === 404 ? 'Token sin permiso sobre el repositorio' : `No se pudo guardar: ${e.message}`);
    return false;
  }
}

/* ---------- Alertas ---------- */
function matchRow(c) {
  const side = c.side === 'put' ? 'put' : 'call';
  return `<div class="row">
    <div class="r1"><b>${esc(c.ticker)}</b><span class="pill ${side}">${side.toUpperCase()}</span>
      <b>${num(c.strike, c.strike % 1 ? 2 : 0)}</b><span>${fmtExp(c.exp)}</span><span class="muted small">${c.dte} d</span>
      ${c.isNew ? '<span class="pill new">NUEVO</span>' : ''}</div>
    <div class="r2">
      <span>Prima <b>${num(c.mid)}</b> <span>(${num(c.bid)} / ${num(c.ask)})</span></span>
      <span class="hi">Anual <b>${num(c.annPct, 1)}%</b></span>
      <span>Δ <b>${num(c.delta, 2)}</b></span><span>Θ <b>${num(c.theta, 2)}</b></span>
      <span>Γ <b>${num(c.gamma, 3)}</b></span><span>Vega <b>${num(c.vega, 2)}</b></span>
      <span>IV <b>${num(c.iv, 1)}%</b></span><span>OTM <b>${num(c.otmPct, 1)}%</b></span>
      <span>Spot <b>${num(c.spot)}</b></span><span>Vol <b>${big(c.volume)}</b></span><span>OI <b>${big(c.oi)}</b></span>
    </div></div>`;
}

function renderResults() {
  const box = $('#results');
  $('#updated').textContent = results?.updated ? fmtTime(results.updated) : '';
  $('#scanInfo').textContent = index ? `${index.tickers.filter((t) => !t.error).length} acciones · datos con ~15 min de retraso` : '';
  if (!results) { box.innerHTML = '<div class="empty">Todavía no hay ningún escaneo. Pulsa «Escanear ahora».</div>'; return; }
  if (!results.filters.length) { box.innerHTML = '<div class="empty">No hay filtros activos. Crea uno en la pestaña Filtros.</div>'; return; }
  box.innerHTML = results.filters.map((f) => `<div class="card">
    <div class="head"><h2>${esc(f.name)}</h2>
      ${f.newCount ? `<span class="pill new">${f.newCount} nuevas</span>` : ''}<span class="pill">${f.total}</span></div>
    ${f.matches.length ? f.matches.map(matchRow).join('') : '<div class="row muted small">Ningún contrato cumple el filtro ahora mismo.</div>'}
    ${f.total > f.matches.length ? `<div class="row muted small">Se muestran ${f.matches.length} de ${f.total}.</div>` : ''}
  </div>`).join('');
}

async function loadData() {
  try { [index, results] = await Promise.all([getData('index.json'), getData('results.json')]); }
  catch { index = results = null; }
  renderResults(); refreshChains(); renderStatus();
}

/* ---------- Filtros ---------- */
const condText = (c) => `${FIELD_LABEL[c.field] || c.field} ${c.op} ${c.value}`;

function renderFilters() {
  const box = $('#filters');
  if (!config.filters.length) { box.innerHTML = '<div class="empty">Sin filtros. Pulsa «+ Filtro» para crear el primero.</div>'; return; }
  box.innerHTML = config.filters.map((f) => `<div class="card">
    <div class="head"><h2>${esc(f.name)}</h2>
      <input type="checkbox" class="switch" data-toggle="${esc(f.id)}" ${f.enabled !== false ? 'checked' : ''} aria-label="Activo">
      <button class="btn" data-edit="${esc(f.id)}">Editar</button></div>
    <div class="body small muted">
      <span class="pill ${f.side === 'both' ? '' : f.side}">${{ put: 'PUTS', call: 'CALLS', both: 'PUTS + CALLS' }[f.side] || 'PUTS + CALLS'}</span>
      ${f.tickers?.length ? esc(f.tickers.join(', ')) : 'todos los tickers'}<br>
      ${(f.conditions || []).map((c) => esc(condText(c))).join(' · ') || 'sin condiciones'}
    </div></div>`).join('');
}

function condRow(c = { field: 'dte', op: '>=', value: '' }) {
  const div = document.createElement('div');
  div.className = 'cond';
  div.innerHTML = `<select aria-label="Campo">${FIELDS.map(([k, l]) => `<option value="${k}" ${k === c.field ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <select aria-label="Operador">${OPS.map((o) => `<option ${o === c.op ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>
    <input type="number" step="any" inputmode="decimal" aria-label="Valor" value="${esc(c.value)}" required>
    <button type="button" class="btn ghost" aria-label="Quitar condición">✕</button>`;
  $('button', div).onclick = () => div.remove();
  return div;
}

function openEditor(id) {
  const f = config.filters.find((x) => x.id === id) ||
    { name: '', side: 'put', tickers: [], conditions: [{ field: 'dte', op: '<=', value: 45 }], sortBy: 'annPct', sortDir: 'desc', cooldownHours: 24 };
  editingId = id || null;
  $('#dlgTitle').textContent = id ? 'Editar filtro' : 'Nuevo filtro';
  $('#fName').value = f.name; $('#fSide').value = f.side || 'both';
  $('#fTickers').value = (f.tickers || []).join(', ');
  $('#conds').replaceChildren(...(f.conditions || []).map(condRow));
  $('#fSort').innerHTML = FIELDS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('');
  $('#fSort').value = f.sortBy || 'annPct'; $('#fDir').value = f.sortDir || 'desc';
  $('#fCooldown').value = f.cooldownHours ?? 24;
  $('#btnDelFilter').hidden = !id;
  $('#dlg').showModal();
}

async function submitFilter(e) {
  e.preventDefault();
  const f = {
    id: editingId || `f${Date.now().toString(36)}`,
    name: $('#fName').value.trim(),
    enabled: config.filters.find((x) => x.id === editingId)?.enabled ?? true,
    side: $('#fSide').value,
    tickers: parseTickers($('#fTickers').value),
    conditions: $$('#conds .cond').map((d) => {
      const [field, op] = $$('select', d).map((s) => s.value);
      return { field, op, value: parseFloat($('input', d).value) };
    }).filter((c) => Number.isFinite(c.value)),
    sortBy: $('#fSort').value, sortDir: $('#fDir').value,
    cooldownHours: Math.max(0, parseFloat($('#fCooldown').value) || 0),
  };
  const i = config.filters.findIndex((x) => x.id === f.id);
  const before = structuredClone(config.filters);
  if (i >= 0) config.filters[i] = f; else config.filters.push(f);
  if (await saveConfig(`Filtro: ${f.name}`)) { $('#dlg').close(); renderFilters(); toast('Filtro guardado. Se escaneará en ~1 min'); }
  else config.filters = before;
}

/* ---------- Cadena ---------- */
const chains = {};      // cadenas ya descargadas, por ticker
let openTicker = null;  // empresa desplegada en la columna izquierda
let sel = null;         // { ticker, exp } que se muestra en la tabla
let chainSide = LS.get('chainSide', 'both'); // 'call' | 'put' | 'both'

function renderSide() {
  const ok = (index?.tickers || []).filter((t) => !t.error);
  $('#chSide').innerHTML = ok.map((t) => {
    const open = t.ticker === openTicker, ch = chains[t.ticker];
    const exps = !open ? '' : `<div class="exps">${ch
      ? ch.exps.map((e) => `<button data-exp="${e}" class="${sel?.ticker === t.ticker && sel.exp === e ? 'on' : ''}">${fmtExp(e)}<span>${dteOf(e)} d</span></button>`).join('')
      : '<span class="muted small">Cargando…</span>'}</div>`;
    return `<div class="co${open ? ' open' : ''}">
      <button class="cohead" data-ticker="${esc(t.ticker)}" aria-expanded="${open}"><b>${esc(t.ticker)}</b><span>${num(t.spot)}</span></button>${exps}</div>`;
  }).join('') || '<div class="muted small" style="padding:10px">Sin datos todavía.</div>';
}

async function toggleTicker(t) {
  if (openTicker === t) { openTicker = null; renderSide(); return; }
  openTicker = t;
  renderSide();
  if (!chains[t]) {
    try { chains[t] = await getData(`chains/${t.replace('^', '_')}.json`); }
    catch { toast(`No se pudo cargar la cadena de ${t}`); openTicker = null; renderSide(); return; }
  }
  if (openTicker !== t) return; // se desplegó otra empresa mientras cargaba
  const exps = chains[t].exps;
  selectExp(t, exps.find((e) => dteOf(e) >= 25) || exps[0]);
  $('#chSide .co.open')?.scrollIntoView({ block: 'nearest' });
}

function selectExp(ticker, exp) {
  sel = exp ? { ticker, exp } : null;
  renderSide();
  renderChain();
}

function openDefaultChain() {
  renderSide();
  const first = (index?.tickers || []).find((t) => !t.error);
  if (!sel && !openTicker && first) toggleTicker(first.ticker);
}

// Tras un escaneo nuevo se descartan las cadenas en memoria y se recarga la que esté a la vista.
async function refreshChains() {
  for (const k of Object.keys(chains)) delete chains[k];
  if ($('#tab-cadena').hidden) return;
  const keep = sel;
  if (!keep) { openTicker = null; return openDefaultChain(); }
  try { chains[keep.ticker] = await getData(`chains/${keep.ticker.replace('^', '_')}.json`); } catch {}
  const ch = chains[keep.ticker];
  selectExp(keep.ticker, ch?.exps.includes(keep.exp) ? keep.exp : ch?.exps[0]);
}

const CHAIN_COLS = ['Prima', 'Bid', 'Ask', 'Δ', 'Γ', 'Θ', 'Vega', 'Rho', 'IV', 'Vol', 'OI'];
function sideCells(r, itm, first) {
  const cls = `${itm ? 'itm' : ''}${first ? ' gs' : ''}`;
  if (!r) return CHAIN_COLS.map((_, i) => `<td class="${i ? (itm ? 'itm' : '') : cls}">—</td>`).join('');
  const mid = r[4] > 0 ? (r[3] + r[4]) / 2 : r[5];
  const v = [`<b>${num(mid)}</b>`, num(r[3]), num(r[4]), num(r[7], 3), num(r[8], 4), num(r[9], 3), num(r[10], 3),
    num(r[13], 3), `${num(r[6], 1)}%`, big(r[11]), big(r[12])];
  return v.map((x, i) => `<td class="${i ? (itm ? 'itm' : '') : cls}">${x}</td>`).join('');
}

function renderChain() {
  for (const b of $$('#chSeg button')) b.classList.toggle('on', b.dataset.side === chainSide);
  const showCalls = chainSide !== 'put', showPuts = chainSide !== 'call';
  const ch = sel && chains[sel.ticker];
  if (!ch) {
    $('#chInfo').textContent = '';
    $('#chain').innerHTML = '<div class="empty">Elige una empresa y un vencimiento en la columna de la izquierda.</div>';
    return;
  }
  const ei = ch.exps.indexOf(sel.exp), spot = ch.spot, all = $('#chAll').checked;
  $('#chInfo').innerHTML = `<b>${esc(ch.ticker)}</b> ${num(spot)} · vence ${fmtExp(sel.exp)} (${dteOf(sel.exp)} d) · IV30 ${num(ch.iv30, 1)}%`;
  const byStrike = new Map();
  for (const r of ch.rows) {
    if (r[0] !== ei) continue;
    if (!byStrike.has(r[2])) byStrike.set(r[2], {});
    byStrike.get(r[2])[r[1] ? 'put' : 'call'] = r;
  }
  let strikes = [...byStrike.keys()].sort((a, b) => a - b);
  if (!all) strikes = strikes.filter((k) => Math.abs(k / spot - 1) <= 0.2);
  if (!strikes.length) { $('#chain').innerHTML = '<div class="empty">Sin contratos para este vencimiento.</div>'; return; }
  const atm = strikes.reduce((b, k) => (Math.abs(k - spot) < Math.abs(b - spot) ? k : b));
  const heads = CHAIN_COLS.map((c, i) => `<th class="${i ? '' : 'gs'}">${c}</th>`).join('');
  $('#chain').innerHTML = `<div class="tablewrap chainwrap"><table><thead>
    <tr><th class="k" rowspan="2">Strike</th>${showCalls ? `<th class="gc gs" colspan="${CHAIN_COLS.length}">CALLS</th>` : ''}${showPuts ? `<th class="gp gs" colspan="${CHAIN_COLS.length}">PUTS</th>` : ''}</tr>
    <tr class="h2">${showCalls ? heads : ''}${showPuts ? heads : ''}</tr></thead><tbody>
    ${strikes.map((k) => `<tr class="${k === atm ? 'atm' : ''}"><td class="k">${num(k, k % 1 ? 2 : 0)}</td>${
      showCalls ? sideCells(byStrike.get(k).call, k < spot, true) : ''}${showPuts ? sideCells(byStrike.get(k).put, k > spot, true) : ''}</tr>`).join('')}
    </tbody></table></div>`;
  const wrap = $('#chain .chainwrap'), row = $('tr.atm', wrap);
  if (row) wrap.scrollTop = row.offsetTop - wrap.clientHeight / 2;
}

/* ---------- Ajustes ---------- */
function renderStatus() {
  $('#tokenState').textContent = !REPO ? 'modo local' : LS.get('token', '') ? 'guardado' : 'falta';
  const errs = (index?.tickers || []).filter((t) => t.error);
  $('#status').innerHTML = [
    ['Repositorio', REPO || 'local'],
    ['Último escaneo', results?.updated ? fmtTime(results.updated) : '—'],
    ['Acciones con datos', index ? index.tickers.length - errs.length : '—'],
    ...(errs.length ? [['Sin datos', errs.map((t) => t.ticker).join(', ')]] : []),
  ].map(([k, v]) => `<div class="kv"><span class="muted">${esc(k)}</span><span>${esc(v)}</span></div>`).join('');
}

async function renderPushState() {
  const el = $('#pushState');
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) { el.textContent = 'no soportado'; return; }
  if (Notification.permission === 'denied') { el.textContent = 'bloqueadas'; return; }
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg && await reg.pushManager.getSubscription();
  el.textContent = sub && LS.get('pushSaved', '') === sub.endpoint ? 'activas' : 'inactivas';
  el.classList.toggle('new', el.textContent === 'activas');
}

async function enablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return toast('Este navegador no admite notificaciones push');
  if (REPO && !LS.get('token', '')) return toast('Guarda primero el token de GitHub');
  if (await Notification.requestPermission() !== 'granted') { renderPushState(); return toast('Permiso de notificaciones denegado'); }
  try {
    const key = (await (await fetch('vapid-public.txt', { cache: 'no-store' })).text()).trim();
    const appKey = Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey });
    }
    if (REPO) {
      let { json: list, sha } = await getRepoJson('config/subscriptions.json').catch(() => ({ json: [], sha: null }));
      if (!Array.isArray(list)) list = [];
      if (!list.some((s) => s.endpoint === sub.endpoint)) {
        list.push({ ...sub.toJSON(), added: new Date().toISOString() });
        await putRepoJson('config/subscriptions.json', list, sha, 'Nueva suscripción push');
      }
    }
    LS.set('pushSaved', sub.endpoint);
    toast('Notificaciones activadas');
  } catch (e) { toast(`No se pudieron activar: ${e.message}`); }
  renderPushState();
}

async function testPush() {
  if (!('serviceWorker' in navigator) || Notification.permission !== 'granted') return toast('Activa primero las notificaciones');
  const reg = await navigator.serviceWorker.ready;
  reg.showNotification('Prueba de alerta', { body: 'AAPL 220P 16ene · 3,10 · Δ-0,25 · 32%/año', icon: 'icon-192.png', badge: 'badge.png', tag: 'test' });
}

/* ---------- navegación y arranque ---------- */
function showTab(name) {
  for (const s of $$('main > section')) s.hidden = s.id !== `tab-${name}`;
  for (const b of $$('nav button')) b.classList.toggle('on', b.dataset.tab === name);
  document.body.classList.toggle('wide', name === 'cadena');
  if (name === 'cadena') openDefaultChain();
  if (name === 'ajustes') { renderStatus(); renderPushState(); }
  history.replaceState(null, '', `#${name}`);
  window.scrollTo(0, 0);
}

async function init() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  for (const b of $$('nav button')) b.onclick = () => showTab(b.dataset.tab);

  $('#btnRefresh').onclick = async () => { await loadData(); toast('Datos actualizados'); };
  $('#btnScan').onclick = async () => {
    config.requestedAt = new Date().toISOString();
    if (await saveConfig('Escaneo manual')) toast(REPO ? 'Escaneo lanzado: pulsa Actualizar en ~1 min' : 'En local: ejecuta node scanner/scan.mjs');
  };
  $('#btnNewFilter').onclick = () => openEditor(null);
  $('#filters').onclick = (e) => { const id = e.target.dataset.edit; if (id) openEditor(id); };
  $('#filters').onchange = async (e) => {
    const f = config.filters.find((x) => x.id === e.target.dataset.toggle);
    if (!f) return;
    f.enabled = e.target.checked;
    if (!(await saveConfig(`${f.enabled ? 'Activar' : 'Pausar'}: ${f.name}`))) { f.enabled = !f.enabled; renderFilters(); }
  };
  $('#btnAddCond').onclick = () => $('#conds').append(condRow());
  $('#dlgCancel').onclick = () => $('#dlg').close();
  $('#filterForm').onsubmit = submitFilter;
  $('#btnDelFilter').onclick = async () => {
    const f = config.filters.find((x) => x.id === editingId);
    if (!f || !confirm(`¿Eliminar el filtro «${f.name}»?`)) return;
    const before = config.filters;
    config.filters = before.filter((x) => x !== f);
    if (await saveConfig(`Eliminar filtro: ${f.name}`)) { $('#dlg').close(); renderFilters(); } else config.filters = before;
  };
  $('#chSide').onclick = (e) => {
    const b = e.target.closest('button');
    if (b?.dataset.ticker) toggleTicker(b.dataset.ticker);
    else if (b?.dataset.exp) selectExp(openTicker, b.dataset.exp);
  };
  $('#chAll').onchange = renderChain;
  $('#chSeg').onclick = (e) => {
    const side = e.target.dataset.side;
    if (!side) return;
    chainSide = side; LS.set('chainSide', side);
    renderChain();
  };
  $('#btnSaveTickers').onclick = async () => {
    const before = config.tickers;
    config.tickers = parseTickers($('#tickers').value);
    if (await saveConfig('Actualizar tickers')) { $('#tickers').value = config.tickers.join(' '); toast(`${config.tickers.length} tickers guardados`); }
    else config.tickers = before;
  };
  $('#btnSaveToken').onclick = async () => {
    LS.set('token', $('#token').value.trim());
    renderStatus();
    await loadConfig(); loadData();
    toast('Token guardado en este dispositivo');
  };
  $('#btnPush').onclick = enablePush;
  $('#btnTestPush').onclick = testPush;
  $('#token').value = LS.get('token', '');

  const start = location.hash.slice(1);
  showTab(['alertas', 'filtros', 'cadena', 'ajustes'].includes(start) ? start : 'alertas');
  await loadConfig();
  await loadData();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadData(); });
}

async function loadConfig() {
  try {
    const f = await getRepoJson('config/config.json');
    config = { tickers: [], filters: [], ...((!REPO && LS.get('devConfig', null)) || f.json) };
    configSha = f.sha;
  } catch { toast('No se pudo leer la configuración'); }
  $('#tickers').value = config.tickers.join(' ');
  renderFilters();
}

init();
