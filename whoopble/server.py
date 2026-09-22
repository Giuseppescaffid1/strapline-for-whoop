"""Localhost dashboard: a live page plus a server-sent-events feed of strap metrics."""

from __future__ import annotations

import json
import math
import queue
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class MetricsHub:
    """Thread-safe rolling window of live samples with derived metrics."""

    def __init__(self, window_s: float = 300.0) -> None:
        self._lock = threading.Lock()
        self._window = window_s
        self._hr: dict[int, tuple[float, int]] = {}  # second -> (t, bpm), deduped across sources
        self._rr: deque[tuple[float, int]] = deque()
        self._subs: list[queue.Queue[str]] = []
        self._last: dict | None = None
        self._count = 0
        self._hr_min: int | None = None
        self._hr_max: int | None = None
        self._hr_sum = 0
        self._hr_n = 0
        self.status: dict = {
            "connected": False,
            "battery_pct": None,
            "serial": None,
            "device": None,
            "started_at": time.time(),
        }

    def set_status(self, **fields: object) -> None:
        with self._lock:
            self.status.update(fields)
        self._broadcast()

    def push(self, t: float, bpm: int, rr_ms: list[int] | tuple[int, ...], wearing: object = None, source: str = "") -> None:
        with self._lock:
            self._count += 1
            if bpm > 0:
                self._hr[int(t)] = (t, bpm)
                self._hr_min = bpm if self._hr_min is None else min(self._hr_min, bpm)
                self._hr_max = bpm if self._hr_max is None else max(self._hr_max, bpm)
                self._hr_sum += bpm
                self._hr_n += 1
            for rr in rr_ms:
                self._rr.append((t, int(rr)))
            cutoff = t - self._window
            for sec in [s for s in self._hr if s < cutoff]:
                del self._hr[sec]
            while self._rr and self._rr[0][0] < cutoff:
                self._rr.popleft()
            self._last = {"t": t, "bpm": bpm, "rr_ms": list(rr_ms), "wearing": wearing, "source": source}
        self._broadcast()

    def snapshot(self) -> dict:
        with self._lock:
            series = sorted(self._hr.values())
            return {
                **self.status,
                "now": time.time(),
                "last": self._last,
                "samples": self._count,
                "session": {
                    "hr_min": self._hr_min,
                    "hr_max": self._hr_max,
                    "hr_avg": round(self._hr_sum / self._hr_n, 1) if self._hr_n else None,
                },
                "rmssd_60s": self._rmssd(60),
                "rmssd_5m": self._rmssd(300),
                "hr_series": [[round(t, 1), bpm] for t, bpm in series],
            }

    def _rmssd(self, span_s: float) -> float | None:
        if not self._rr:
            return None
        cutoff = self._rr[-1][0] - span_s
        recent = [(t, rr) for t, rr in self._rr if t >= cutoff]
        # Beats are reported per second; only difference intervals that are really successive.
        diffs = [
            (b[1] - a[1]) ** 2
            for a, b in zip(recent, recent[1:])
            if b[0] - a[0] <= 2.0
        ]
        if len(diffs) < 5:
            return None
        return round(math.sqrt(sum(diffs) / len(diffs)), 1)

    def subscribe(self) -> queue.Queue[str]:
        q: queue.Queue[str] = queue.Queue(maxsize=64)
        with self._lock:
            self._subs.append(q)
        return q

    def unsubscribe(self, q: queue.Queue[str]) -> None:
        with self._lock:
            if q in self._subs:
                self._subs.remove(q)

    def _broadcast(self) -> None:
        payload = json.dumps(self.snapshot())
        with self._lock:
            subs = list(self._subs)
        for q in subs:
            try:
                q.put_nowait(payload)
            except queue.Full:
                pass


class _Handler(BaseHTTPRequestHandler):
    hub: MetricsHub

    def do_GET(self) -> None:  # noqa: N802 - http.server API
        path = self.path.split("?", 1)[0]
        if path == "/":
            self._send(200, "text/html; charset=utf-8", DASHBOARD_HTML.encode())
        elif path == "/api/latest":
            self._send(200, "application/json", json.dumps(self.hub.snapshot()).encode())
        elif path == "/events":
            self._events()
        else:
            self._send(404, "text/plain", b"not found")

    def _send(self, code: int, ctype: str, body: bytes) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _events(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        q = self.hub.subscribe()
        try:
            self.wfile.write(f"data: {json.dumps(self.hub.snapshot())}\n\n".encode())
            self.wfile.flush()
            while True:
                try:
                    payload = q.get(timeout=15)
                    self.wfile.write(f"data: {payload}\n\n".encode())
                except queue.Empty:
                    self.wfile.write(b": keepalive\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            self.hub.unsubscribe(q)

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002 - http.server API
        pass


def start_server(hub: MetricsHub, port: int, host: str = "127.0.0.1") -> ThreadingHTTPServer:
    handler = type("Handler", (_Handler,), {"hub": hub})
    httpd = ThreadingHTTPServer((host, port), handler)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, name="dashboard-http", daemon=True).start()
    return httpd


DASHBOARD_HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>WHOOP live</title>
<style>
  /* Same tokens as the browser app (docs/style.css), so the two dashboards do
     not read as two different products. Kept inline: this page is served by a
     single-file localhost server with nothing to link to. */
  :root {
    --bg:#07090c; --surface:#0e1219; --surface-2:#131926;
    --line:rgba(255,255,255,.07); --sheen:rgba(255,255,255,.045);
    --fg:#eef2f8; --muted:#7b8698; --faint:#4d5768;
    --accent:#00e5b0; --accent-2:#7ddc5b; --amber:#f5b43f;
    --r-lg:18px; --r-pill:999px;
    --e1:0 1px 2px rgba(0,0,0,.5), 0 8px 24px -12px rgba(0,0,0,.8);
    --ease:cubic-bezier(.22,.61,.36,1);
    --safe-t:env(safe-area-inset-top,0px); --safe-b:env(safe-area-inset-bottom,0px);
    --safe-l:env(safe-area-inset-left,0px); --safe-r:env(safe-area-inset-right,0px);
  }
  * { box-sizing:border-box; }
  body {
    margin:0; background:var(--bg);
    background-image:radial-gradient(1200px 700px at 50% -20%, #121924 0%, var(--bg) 62%);
    background-attachment:fixed; color:var(--fg);
    font:15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing:antialiased;
  }
  header {
    position:sticky; top:0; z-index:10;
    display:flex; align-items:center; gap:10px; flex-wrap:wrap;
    padding:calc(12px + var(--safe-t)) calc(16px + var(--safe-r)) 12px calc(16px + var(--safe-l));
    background:rgba(7,9,12,.84); backdrop-filter:saturate(160%) blur(14px);
    -webkit-backdrop-filter:saturate(160%) blur(14px); border-bottom:1px solid var(--line);
  }
  header h1 { margin:0 auto 0 0; font-size:15px; font-weight:650; letter-spacing:.01em; }
  .status { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .status span.pill {
    display:inline-flex; align-items:center; gap:7px; padding:5px 11px;
    border:1px solid var(--line); border-radius:var(--r-pill); background:var(--surface);
    font-size:12px; color:var(--muted); font-variant-numeric:tabular-nums; white-space:nowrap;
  }
  .status span.pill:empty { display:none; }
  .dot { width:7px; height:7px; border-radius:50%; background:var(--faint); flex:none; }
  .dot.on { background:var(--accent); box-shadow:0 0 8px var(--accent); }
  main {
    padding:16px calc(16px + var(--safe-r)) calc(24px + var(--safe-b)) calc(16px + var(--safe-l));
    max-width:1100px; margin:0 auto;
    display:grid; gap:12px; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr));
  }
  .card {
    background:linear-gradient(180deg, var(--surface-2) 0%, var(--surface) 100%);
    border:1px solid var(--line); border-radius:var(--r-lg); padding:16px;
    box-shadow:var(--e1); position:relative; overflow:hidden; min-width:0;
  }
  .card::before {
    content:''; position:absolute; inset:0 0 auto; height:1px; pointer-events:none;
    background:linear-gradient(90deg, transparent, var(--sheen) 18%, var(--sheen) 82%, transparent);
  }
  .card.hero, .card.wide { grid-column:1 / -1; }
  .label { color:var(--faint); font-size:10px; text-transform:uppercase; letter-spacing:.15em; font-weight:600; }
  .value { font-size:28px; font-weight:640; margin-top:8px; font-variant-numeric:tabular-nums; letter-spacing:-.02em; line-height:1; }
  .value small { font-size:11.5px; color:var(--faint); font-weight:400; margin-left:4px; letter-spacing:0; }
  .hero .value {
    font-size:clamp(58px,18vw,92px); line-height:.9; letter-spacing:-.045em;
    background:linear-gradient(160deg,#fff 8%,var(--accent) 118%);
    -webkit-background-clip:text; background-clip:text; color:transparent;
    transition:filter .32s var(--ease);
  }
  .hero .value small { -webkit-text-fill-color:var(--muted); color:var(--muted); font-size:13px; }
  .sub { color:var(--muted); font-size:12.5px; margin-top:8px; }
  canvas { width:100%; height:180px; display:block; margin-top:10px; }
  /* Stale data is stated, not implied: the figure goes amber and the age pill
     says how long it has been since the last sample. */
  .stale .hero .value { background:none; -webkit-text-fill-color:var(--amber); color:var(--amber); }
  @media (min-width:720px) { main { padding:20px; gap:14px; } canvas { height:230px; } .card { padding:18px; } }
  @media (min-width:1000px) { .card.hero { grid-column:span 2; } }
  @media (prefers-reduced-motion:reduce) { * { transition-duration:.001ms !important; } }
</style>
</head>
<body>
<header>
  <h1>WHOOP live</h1>
  <div class="status">
    <span class="pill"><span class="dot" id="dot"></span><span id="conn">connecting…</span></span>
    <span class="pill" id="device"></span>
    <span class="pill" id="battery"></span>
    <span class="pill" id="age"></span>
  </div>
</header>
<main>
  <div class="card hero">
    <div class="label">Heart rate</div>
    <div class="value"><span id="hr">—</span><small>bpm</small></div>
    <div class="sub" id="hrsub">waiting for the strap</div>
  </div>
  <div class="card">
    <div class="label">HRV · RMSSD 60 s</div>
    <div class="value"><span id="rmssd60">—</span><small>ms</small></div>
    <div class="sub">successive beat intervals, last minute</div>
  </div>
  <div class="card">
    <div class="label">HRV · RMSSD 5 min</div>
    <div class="value"><span id="rmssd5">—</span><small>ms</small></div>
    <div class="sub">pulse-derived (PRV), not ECG</div>
  </div>
  <div class="card">
    <div class="label">Session range</div>
    <div class="value"><span id="range">—</span></div>
    <div class="sub" id="avg">min · avg · max</div>
  </div>
  <div class="card wide">
    <div class="label">Heart rate · last 5 minutes</div>
    <canvas id="chart"></canvas>
  </div>
</main>
<script>
const $ = id => document.getElementById(id);
const canvas = $('chart'), ctx = canvas.getContext('2d');
let lastAt = 0, lastSeries = null;

function fmt(v, d = 0) { return (v === null || v === undefined) ? '—' : Number(v).toFixed(d); }

// The canvas had a fixed 1000x220 backing store stretched to whatever width the
// window happened to be, which is a blurred chart on every screen and a badly
// squashed one on a phone. Size it to the element, at device resolution.
function sized() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const w = canvas.clientWidth || 600, h = canvas.clientHeight || 180;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return [w, h];
}

function draw(series) {
  lastSeries = series || lastSeries;
  const [w, h] = sized();
  const s = lastSeries;
  if (!s || s.length < 2) return;
  const t1 = s[s.length - 1][0], t0 = Math.max(s[0][0], t1 - 300);
  const pts = s.filter(p => p[0] >= t0);
  if (pts.length < 2) return;
  const vals = pts.map(p => p[1]);
  const lo = Math.max(30, Math.min(...vals) - 5), hi = Math.max(...vals) + 5;
  const x = t => 2 + (t - t0) / Math.max(1, t1 - t0) * (w - 14);
  const y = v => 12 + (h - 28) * (1 - (v - lo) / Math.max(1, hi - lo));

  ctx.strokeStyle = 'rgba(255,255,255,.05)'; ctx.lineWidth = 1;
  ctx.fillStyle = '#3b4454'; ctx.font = '10.5px -apple-system, system-ui, sans-serif';
  ctx.beginPath();
  for (let i = 0; i <= 4; i++) {
    const gy = Math.round(12 + (h - 28) * i / 4) + 0.5;
    ctx.moveTo(0, gy); ctx.lineTo(w, gy);
  }
  ctx.stroke();
  for (let i = 0; i <= 4; i++) {
    const gy = Math.round(12 + (h - 28) * i / 4) + 0.5;
    ctx.fillText(Math.round(hi - (hi - lo) * i / 4), 2, gy - 3);
  }

  // A pause of more than five seconds breaks the line: joining across it would
  // draw a heart rate nobody measured.
  const runs = []; let run = [], prevT = null;
  for (const [t, v] of pts) {
    if (prevT !== null && t - prevT > 5) { runs.push(run); run = []; }
    run.push([x(t), y(v)]); prevT = t;
  }
  if (run.length) runs.push(run);

  const fill = ctx.createLinearGradient(0, 0, 0, h);
  fill.addColorStop(0, 'rgba(0,229,176,.28)');
  fill.addColorStop(1, 'rgba(0,229,176,0)');
  for (const r of runs) {
    if (r.length < 2) continue;
    ctx.beginPath(); ctx.moveTo(r[0][0], r[0][1]);
    for (const [px, py] of r.slice(1)) ctx.lineTo(px, py);
    ctx.lineTo(r[r.length - 1][0], h); ctx.lineTo(r[0][0], h); ctx.closePath();
    ctx.fillStyle = fill; ctx.fill();

    ctx.beginPath(); ctx.moveTo(r[0][0], r[0][1]);
    for (const [px, py] of r.slice(1)) ctx.lineTo(px, py);
    ctx.strokeStyle = '#00e5b0'; ctx.lineWidth = 2.2;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.shadowColor = 'rgba(0,229,176,.45)'; ctx.shadowBlur = 10;
    ctx.stroke(); ctx.shadowBlur = 0;
  }
  const last = runs[runs.length - 1], p = last && last[last.length - 1];
  if (p) {
    ctx.beginPath(); ctx.arc(p[0], p[1], 3.4, 0, Math.PI * 2);
    ctx.fillStyle = '#eef2f8';
    ctx.shadowColor = 'rgba(0,229,176,.9)'; ctx.shadowBlur = 9;
    ctx.fill(); ctx.shadowBlur = 0;
  }
}

function render(s) {
  const last = s.last;
  $('dot').className = 'dot' + (s.connected ? ' on' : '');
  $('conn').textContent = s.connected ? 'connected' : 'not connected';
  $('device').textContent = s.device ? s.device + (s.serial ? ' · ' + s.serial : '') : '';
  $('battery').textContent = s.battery_pct === null || s.battery_pct === undefined ? '' : 'battery ' + fmt(s.battery_pct) + '%';
  if (last) {
    lastAt = last.t;
    $('hr').textContent = last.bpm > 0 ? last.bpm : '—';
    const rr = last.rr_ms && last.rr_ms.length ? 'RR ' + last.rr_ms.join(' / ') + ' ms' : 'no beat intervals this second';
    const wear = last.wearing === null || last.wearing === undefined ? '' : (last.wearing ? ' · on wrist' : ' · off wrist');
    $('hrsub').textContent = rr + wear + (last.source ? ' · ' + last.source : '');
  }
  $('rmssd60').textContent = fmt(s.rmssd_60s, 1);
  $('rmssd5').textContent = fmt(s.rmssd_5m, 1);
  const ss = s.session || {};
  $('range').textContent = ss.hr_min === null || ss.hr_min === undefined ? '—' : ss.hr_min + '–' + ss.hr_max;
  $('avg').textContent = ss.hr_avg === null || ss.hr_avg === undefined ? 'min · avg · max' : 'avg ' + fmt(ss.hr_avg, 1) + ' bpm · ' + s.samples + ' samples';
  draw(s.hr_series);
}

function tickAge() {
  if (!lastAt) return;
  const age = Math.max(0, Date.now() / 1000 - lastAt);
  $('age').textContent = age < 3 ? 'live' : 'last sample ' + Math.round(age) + ' s ago';
  document.body.classList.toggle('stale', age > 5);
}
setInterval(tickAge, 1000);

// Redraw when the element resizes — rotating a phone changes the chart\'s width
// without changing anything the server sends.
if (window.ResizeObserver) new ResizeObserver(() => draw(null)).observe(canvas);

function connect() {
  const es = new EventSource('/events');
  es.onmessage = e => render(JSON.parse(e.data));
  es.onerror = () => { es.close(); $('conn').textContent = 'reconnecting…'; setTimeout(connect, 2000); };
}
fetch('/api/latest').then(r => r.json()).then(render).finally(connect);
</script>
</body>
</html>
"""
