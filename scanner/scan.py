"""Escáner de opciones: descarga las cadenas (CBOE, ~15 min de retraso), evalúa los
filtros de config/config.json, escribe los resultados en OUT_DIR y envía Web Push."""
import json
import math
import operator
import os
import re
import shutil
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timezone
from pathlib import Path
from urllib.parse import quote
from zoneinfo import ZoneInfo

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(os.environ.get("OUT_DIR") or ROOT / "out").resolve()
MAX_MATCHES = 150
NY = ZoneInfo("America/New_York")
NOW = datetime.now(timezone.utc)
NOW_MS = int(NOW.timestamp() * 1000)
NOW_ISO = NOW.isoformat(timespec="milliseconds").replace("+00:00", "Z")
MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"]
OPTION_RE = re.compile(r"(\d{6})([CP])(\d{8})$")
TICKER_RE = re.compile(r"^[\^A-Z0-9.]{1,8}$")
OPS = {">": operator.gt, ">=": operator.ge, "<": operator.lt, "<=": operator.le, "=": operator.eq}


def read_json(path, fallback):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return fallback


def write_json(path, data):
    Path(path).write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def is_num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def r(x, d=2):
    return round(x, d) if is_num(x) else None


def market_open(now):
    """Los datos llegan con 15 min de retraso: 9:40–16:25 hora de Nueva York."""
    ny = now.astimezone(NY)
    minutes = ny.hour * 60 + ny.minute
    return ny.weekday() < 5 and 9 * 60 + 40 <= minutes <= 16 * 60 + 25


def fetch_chain(ticker):
    sym = "_" + ticker[1:] if ticker.startswith("^") else ticker.replace(".", "")
    url = f"https://cdn.cboe.com/api/global/delayed_quotes/options/{quote(sym)}.json"
    last_err = None
    for _ in range(2):
        try:
            res = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=60)
            res.raise_for_status()
            return res.json()
        except (requests.RequestException, ValueError) as e:
            last_err = e
    raise last_err


def build_contracts(ticker, raw, today):
    d = raw["data"]
    spot = d["current_price"]
    iv30 = d.get("iv30")
    out = []
    for o in d.get("options") or []:
        m = OPTION_RE.search(o["option"])
        if not m:
            continue
        ymd = m.group(1)
        exp = f"20{ymd[:2]}-{ymd[2:4]}-{ymd[4:6]}"
        dte = (date.fromisoformat(exp) - today).days
        if dte < 0:
            continue
        side = "call" if m.group(2) == "C" else "put"
        strike = int(m.group(3)) / 1000
        bid, ask, last = o.get("bid") or 0, o.get("ask") or 0, o.get("last_trade_price") or 0
        mid = (bid + ask) / 2 if ask > 0 else last
        days = max(dte, 1)
        base = strike if side == "put" else spot  # capital inmovilizado
        volume, oi = o.get("volume") or 0, o.get("open_interest") or 0
        delta = o.get("delta")
        out.append({
            "ticker": ticker, "side": side, "exp": exp, "dte": dte, "strike": strike, "spot": spot, "iv30": iv30,
            "bid": bid, "ask": ask, "last": last, "mid": r(mid, 3),
            "spreadPct": r((ask - bid) / mid * 100, 1) if mid > 0 and ask > 0 else None,
            "iv": r((o.get("iv") or 0) * 100, 1),
            "delta": delta, "absDelta": None if delta is None else abs(delta),
            "gamma": o.get("gamma"), "theta": o.get("theta"), "vega": o.get("vega"), "rho": o.get("rho"),
            "volume": volume, "oi": oi, "volOi": r(volume / oi, 2) if oi > 0 else volume,
            "otmPct": r((spot - strike if side == "put" else strike - spot) / spot * 100, 2),
            "premPct": r(mid / base * 100, 2),
            "annPct": r(mid / base * (365 / days) * 100, 1),
        })
    return out


def matches(c, f):
    side = f.get("side")
    if side and side != "both" and c["side"] != side:
        return False
    tickers = f.get("tickers")
    if tickers and c["ticker"] not in tickers:
        return False
    for cond in f.get("conditions") or []:
        v, op, target = c.get(cond.get("field")), OPS.get(cond.get("op")), cond.get("value")
        if op is None or not is_num(v) or not is_num(target) or not op(v, target):
            return False
    return True


def filter_hash(f):
    s = json.dumps([f.get("side"), f.get("tickers"), f.get("conditions")], sort_keys=True)
    h = 5381
    for ch in s:
        h = ((h * 33) ^ ord(ch)) & 0xFFFFFFFF
    return f"{h:x}"


def describe(c):
    _, m, d = c["exp"].split("-")
    letter = "P" if c["side"] == "put" else "C"
    return (f"{c['ticker']} {c['strike']:g}{letter} {int(d)}{MONTHS[int(m) - 1]} · {c['mid']:.2f}"
            f" · Δ{c['delta'] or 0:.2f} · {c['annPct']}%/año")


def send_pushes(messages, state):
    if not messages:
        return
    subs = [s for s in read_json(ROOT / "config" / "subscriptions.json", [])
            if isinstance(s, dict) and s.get("endpoint") and s["endpoint"] not in state["dead"]]
    private_key = os.environ.get("VAPID_PRIVATE_KEY")
    if not subs or not private_key:
        print(f"Push omitido (suscripciones: {len(subs)}, clave VAPID: {'sí' if private_key else 'no'})")
        return
    from pywebpush import WebPushException, webpush

    subject = f"https://github.com/{os.environ.get('GITHUB_REPOSITORY') or 'opciones-alertas'}"
    for msg in messages:
        for sub in subs:
            try:
                webpush(
                    subscription_info={"endpoint": sub["endpoint"], "keys": sub["keys"]},
                    data=json.dumps(msg, ensure_ascii=False),
                    vapid_private_key=private_key.strip(),
                    vapid_claims={"sub": subject},  # pywebpush añade "aud" y lo modifica: uno nuevo por envío
                    ttl=3600,
                    headers={"Urgency": "high"},
                )
            except WebPushException as e:
                status = e.response.status_code if e.response is not None else None
                print(f"Push fallido ({status or e})")
                if status in (404, 410):
                    state["dead"].append(sub["endpoint"])
    print(f"Push enviados: {len(messages)} mensaje(s) a {len(subs)} dispositivo(s)")


def main():
    if os.environ.get("GITHUB_EVENT_NAME") == "schedule" and not market_open(NOW):
        print("Mercado cerrado: no se escanea.")
        return
    config = read_json(ROOT / "config" / "config.json", {})
    tickers = list(dict.fromkeys(str(t).upper().strip() for t in config.get("tickers") or []))
    tickers = [t for t in tickers if TICKER_RE.match(t)]
    filters = [f for f in config.get("filters") or [] if f.get("enabled") is not False]
    state = {"notified": {}, "dead": [], **read_json(OUT / "state.json", {})}
    today = NOW.astimezone(NY).date()

    shutil.rmtree(OUT / "chains", ignore_errors=True)
    (OUT / "chains").mkdir(parents=True, exist_ok=True)

    def scan_ticker(t):
        try:
            raw = fetch_chain(t)
            contracts = build_contracts(t, raw, today)
            d = raw["data"]
            exps = sorted({c["exp"] for c in contracts})
            exp_idx = {e: i for i, e in enumerate(exps)}
            write_json(OUT / "chains" / f"{t.replace('^', '_')}.json", {
                "ticker": t, "spot": d["current_price"], "iv30": r(d.get("iv30"), 1),
                "quoteTime": raw.get("timestamp"), "exps": exps,
                "cols": ["exp", "put", "strike", "bid", "ask", "last", "iv", "delta", "gamma", "theta", "vega", "volume", "oi"],
                "rows": [[exp_idx[c["exp"]], 1 if c["side"] == "put" else 0, c["strike"], c["bid"], c["ask"], c["last"],
                          c["iv"], c["delta"], c["gamma"], c["theta"], c["vega"], c["volume"], c["oi"]] for c in contracts],
            })
            print(f"{t}: {len(contracts)} contratos")
            return contracts, {
                "ticker": t, "spot": d["current_price"], "changePct": r(d.get("price_change_percent"), 2),
                "iv30": r(d.get("iv30"), 1), "contracts": len(contracts), "quoteTime": raw.get("timestamp"),
            }
        except Exception as e:  # un ticker que falla no debe tumbar el escaneo
            print(f"{t}: ERROR {e}")
            return [], {"ticker": t, "error": str(e)}

    all_contracts = []
    index = {"updated": NOW_ISO, "tickers": []}
    with ThreadPoolExecutor(max_workers=4) as pool:
        for contracts, info in pool.map(scan_ticker, tickers):
            all_contracts.extend(contracts)
            index["tickers"].append(info)

    results = {"updated": NOW_ISO, "filters": []}
    messages = []
    live_keys = set()
    for f in filters:
        key = f"{f['id']}:{filter_hash(f)}"
        live_keys.add(key)
        seen = state["notified"].setdefault(key, {})
        cooldown = f.get("cooldownHours")
        cooldown_ms = (cooldown if is_num(cooldown) else 24) * 3600e3
        sort_by = f.get("sortBy") or "annPct"
        found = sorted(
            (c for c in all_contracts if matches(c, f)),
            key=lambda c: c[sort_by] if is_num(c.get(sort_by)) else -math.inf,
            reverse=f.get("sortDir") != "asc",
        )
        fresh = []
        for c in found:
            ck = f"{c['ticker']}|{c['exp']}|{c['side']}|{c['strike']:g}"
            if ck not in seen or NOW_MS - seen[ck] >= cooldown_ms:
                seen[ck] = NOW_MS
                fresh.append(c)
        for ck in [k for k, ts in seen.items() if NOW_MS - ts > 45 * 864e5]:
            del seen[ck]
        fresh_ids = {id(c) for c in fresh}
        results["filters"].append({
            "id": f["id"], "name": f.get("name"), "total": len(found), "newCount": len(fresh),
            "matches": [{**c, "isNew": id(c) in fresh_ids} for c in found[:MAX_MATCHES]],
        })
        if fresh:
            body = "\n".join(describe(c) for c in fresh[:4])
            if len(fresh) > 4:
                body += f"\n…y {len(fresh) - 4} más"
            messages.append({
                "title": f"{f.get('name')}: {len(fresh)} {'nueva' if len(fresh) == 1 else 'nuevas'}",
                "body": body, "tag": f["id"],
            })
        print(f"Filtro \"{f.get('name')}\": {len(found)} coincidencias, {len(fresh)} nuevas")
    for k in [k for k in state["notified"] if k not in live_keys]:
        del state["notified"][k]

    send_pushes(messages, state)
    state["dead"] = list(dict.fromkeys(state["dead"]))[-200:]

    write_json(OUT / "index.json", index)
    write_json(OUT / "results.json", results)
    write_json(OUT / "state.json", state)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
