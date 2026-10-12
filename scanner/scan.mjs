// Escáner de opciones: descarga las cadenas (CBOE, ~15 min de retraso), evalúa los
// filtros de config/config.json, escribe los resultados en OUT_DIR y envía Web Push.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.env.OUT_DIR || path.join(ROOT, 'out'));
const MAX_MATCHES = 150;
const now = new Date();

const readJson = async (p, fallback) => {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return fallback; }
};
const r = (x, d = 2) => (Number.isFinite(x) ? +x.toFixed(d) : null);

function nyParts(d) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23', weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { weekday: p.weekday, date: `${p.year}-${p.month}-${p.day}`, minutes: +p.hour * 60 + +p.minute };
}

// Los datos llegan con 15 min de retraso: 9:40–16:25 hora de Nueva York.
function marketOpen(d) {
  const p = nyParts(d);
  return !['Sat', 'Sun'].includes(p.weekday) && p.minutes >= 9 * 60 + 40 && p.minutes <= 16 * 60 + 25;
}

async function fetchChain(ticker) {
  const sym = ticker.startsWith('^') ? '_' + ticker.slice(1) : ticker.replace(/\./g, '');
  const url = `https://cdn.cboe.com/api/global/delayed_quotes/options/${encodeURIComponent(sym)}.json`;
  let lastErr;
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

function buildContracts(ticker, raw, today) {
  const d = raw.data;
  const spot = d.current_price;
  const iv30 = d.iv30 ?? null;
  const out = [];
  for (const o of d.options || []) {
    const m = /(\d{6})([CP])(\d{8})$/.exec(o.option);
    if (!m) continue;
    const exp = `20${m[1].slice(0, 2)}-${m[1].slice(2, 4)}-${m[1].slice(4, 6)}`;
    const dte = Math.round((Date.parse(exp) - Date.parse(today)) / 864e5);
    if (dte < 0) continue;
    const side = m[2] === 'C' ? 'call' : 'put';
    const strike = +m[3] / 1000;
    const bid = o.bid || 0, ask = o.ask || 0, last = o.last_trade_price || 0;
    const mid = ask > 0 ? (bid + ask) / 2 : last;
    const days = Math.max(dte, 1);
    const base = side === 'put' ? strike : spot; // capital inmovilizado
    const volume = o.volume || 0, oi = o.open_interest || 0;
    out.push({
      ticker, side, exp, dte, strike, spot, iv30,
      bid, ask, last, mid: r(mid, 3),
      spreadPct: mid > 0 && ask > 0 ? r(((ask - bid) / mid) * 100, 1) : null,
      iv: r((o.iv || 0) * 100, 1),
      delta: o.delta ?? null, absDelta: o.delta == null ? null : Math.abs(o.delta),
      gamma: o.gamma ?? null, theta: o.theta ?? null, vega: o.vega ?? null, rho: o.rho ?? null,
      volume, oi, volOi: oi > 0 ? r(volume / oi, 2) : volume,
      otmPct: r(((side === 'put' ? spot - strike : strike - spot) / spot) * 100, 2),
      premPct: r((mid / base) * 100, 2),
      annPct: r((mid / base) * (365 / days) * 100, 1),
    });
  }
  return out;
}

const OPS = {
  '>': (a, b) => a > b, '>=': (a, b) => a >= b,
  '<': (a, b) => a < b, '<=': (a, b) => a <= b, '=': (a, b) => a === b,
};

function matches(c, f) {
  if (f.side && f.side !== 'both' && c.side !== f.side) return false;
  if (f.tickers?.length && !f.tickers.includes(c.ticker)) return false;
  for (const cond of f.conditions || []) {
    const v = c[cond.field], op = OPS[cond.op], target = Number(cond.value);
    if (!op || v == null || !Number.isFinite(v) || !Number.isFinite(target) || !op(v, target)) return false;
  }
  return true;
}

function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

const fmtExp = (e) => {
  const [, m, d] = e.split('-');
  return `${+d}${['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'][+m - 1]}`;
};
const describe = (c) =>
  `${c.ticker} ${c.strike}${c.side === 'put' ? 'P' : 'C'} ${fmtExp(c.exp)} · ${c.mid.toFixed(2)} · Δ${(c.delta ?? 0).toFixed(2)} · ${c.annPct}%/año`;

async function sendPushes(messages, state) {
  const subs = (await readJson(path.join(ROOT, 'config', 'subscriptions.json'), []))
    .filter((s) => s?.endpoint && !state.dead.includes(s.endpoint));
  const publicKey = (await fs.readFile(path.join(ROOT, 'docs', 'vapid-public.txt'), 'utf8').catch(() => '')).trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!messages.length) return;
  if (!subs.length || !publicKey || !privateKey) {
    console.log(`Push omitido (suscripciones: ${subs.length}, claves VAPID: ${publicKey && privateKey ? 'sí' : 'no'})`);
    return;
  }
  const { default: webpush } = await import('web-push');
  const subject = `https://github.com/${process.env.GITHUB_REPOSITORY || 'opciones-alertas'}`;
  webpush.setVapidDetails(subject, publicKey, privateKey);
  for (const msg of messages) {
    for (const sub of subs) {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(msg), { TTL: 3600, urgency: 'high' });
      } catch (e) {
        console.log(`Push fallido (${e.statusCode || e.message})`);
        if (e.statusCode === 404 || e.statusCode === 410) state.dead.push(sub.endpoint);
      }
    }
  }
  console.log(`Push enviados: ${messages.length} mensaje(s) a ${subs.length} dispositivo(s)`);
}

async function main() {
  if (process.env.GITHUB_EVENT_NAME === 'schedule' && !marketOpen(now)) {
    console.log('Mercado cerrado: no se escanea.');
    return;
  }
  const config = await readJson(path.join(ROOT, 'config', 'config.json'), {});
  const tickers = [...new Set((config.tickers || []).map((t) => String(t).toUpperCase().trim()))]
    .filter((t) => /^[\^A-Z0-9.]{1,8}$/.test(t));
  const filters = (config.filters || []).filter((f) => f.enabled !== false);
  const state = { notified: {}, dead: [], ...(await readJson(path.join(OUT, 'state.json'), {})) };
  const today = nyParts(now).date;

  await fs.rm(path.join(OUT, 'chains'), { recursive: true, force: true });
  await fs.mkdir(path.join(OUT, 'chains'), { recursive: true });

  const all = [];
  const index = { updated: now.toISOString(), tickers: [] };
  const queue = [...tickers];
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let t; (t = queue.shift()); ) {
      try {
        const raw = await fetchChain(t);
        const contracts = buildContracts(t, raw, today);
        all.push(...contracts);
        const exps = [...new Set(contracts.map((c) => c.exp))].sort();
        const d = raw.data;
        index.tickers.push({
          ticker: t, spot: d.current_price, changePct: r(d.price_change_percent, 2),
          iv30: r(d.iv30, 1), contracts: contracts.length, quoteTime: raw.timestamp,
        });
        await fs.writeFile(path.join(OUT, 'chains', `${t.replace('^', '_')}.json`), JSON.stringify({
          ticker: t, spot: d.current_price, iv30: r(d.iv30, 1), quoteTime: raw.timestamp, exps,
          cols: ['exp', 'put', 'strike', 'bid', 'ask', 'last', 'iv', 'delta', 'gamma', 'theta', 'vega', 'volume', 'oi'],
          rows: contracts.map((c) => [exps.indexOf(c.exp), c.side === 'put' ? 1 : 0, c.strike, c.bid, c.ask, c.last,
            c.iv, c.delta, c.gamma, c.theta, c.vega, c.volume, c.oi]),
        }));
        console.log(`${t}: ${contracts.length} contratos`);
      } catch (e) {
        index.tickers.push({ ticker: t, error: String(e.message || e) });
        console.log(`${t}: ERROR ${e.message || e}`);
      }
    }
  }));
  index.tickers.sort((a, b) => tickers.indexOf(a.ticker) - tickers.indexOf(b.ticker));

  const results = { updated: now.toISOString(), filters: [] };
  const messages = [];
  const liveKeys = new Set();
  for (const f of filters) {
    const key = `${f.id}:${hash(JSON.stringify([f.side, f.tickers, f.conditions]))}`;
    liveKeys.add(key);
    const seen = (state.notified[key] ||= {});
    const cooldownMs = (Number.isFinite(+f.cooldownHours) ? +f.cooldownHours : 24) * 3600e3;
    const dir = f.sortDir === 'asc' ? 1 : -1;
    const sortBy = f.sortBy || 'annPct';
    const found = all.filter((c) => matches(c, f))
      .sort((a, b) => dir * ((a[sortBy] ?? -Infinity) - (b[sortBy] ?? -Infinity)));
    const fresh = [];
    for (const c of found) {
      const ck = `${c.ticker}|${c.exp}|${c.side}|${c.strike}`;
      if (!seen[ck] || now - seen[ck] >= cooldownMs) { seen[ck] = +now; fresh.push(c); }
    }
    for (const ck of Object.keys(seen)) if (now - seen[ck] > 45 * 864e5) delete seen[ck];
    const freshSet = new Set(fresh);
    results.filters.push({
      id: f.id, name: f.name, total: found.length, newCount: fresh.length,
      matches: found.slice(0, MAX_MATCHES).map((c) => ({ ...c, isNew: freshSet.has(c) })),
    });
    if (fresh.length) {
      messages.push({
        title: `${f.name}: ${fresh.length} ${fresh.length === 1 ? 'nueva' : 'nuevas'}`,
        body: fresh.slice(0, 4).map(describe).join('\n') + (fresh.length > 4 ? `\n…y ${fresh.length - 4} más` : ''),
        tag: f.id,
      });
    }
    console.log(`Filtro "${f.name}": ${found.length} coincidencias, ${fresh.length} nuevas`);
  }
  for (const k of Object.keys(state.notified)) if (!liveKeys.has(k)) delete state.notified[k];

  await sendPushes(messages, state);
  state.dead = [...new Set(state.dead)].slice(-200);

  await fs.writeFile(path.join(OUT, 'index.json'), JSON.stringify(index));
  await fs.writeFile(path.join(OUT, 'results.json'), JSON.stringify(results));
  await fs.writeFile(path.join(OUT, 'state.json'), JSON.stringify(state));
}

main().catch((e) => { console.error(e); process.exit(1); });
