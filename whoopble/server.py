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
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WHOOP live</title>
<style>
  :root { --bg:#0e1116; --card:#171c24; --fg:#e8edf3; --muted:#8a94a3; --accent:#19d3b5; --warn:#f5a524; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.4 -apple-system, "Segoe UI", Roboto, sans-serif; }
  header { display:flex; align-items:center; justify-content:space-between; padding:16px 20px; border-bottom:1px solid #222a35; }
  header h1 { margin:0; font-size:18px; font-weight:600; letter-spacing:.02em; }
  .status { display:flex; gap:14px; color:var(--muted); font-size:13px; align-items:center; }
  .dot { width:10px; height:10px; border-radius:50%; background:#555; display:inline-block; margin-right:6px; }
  .dot.on { background:var(--accent); box-shadow:0 0 8px var(--accent); }
  main { padding:20px; max-width:1100px; margin:0 auto; display:grid; gap:16px; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); }
  .card { background:var(--card); border:1px solid #222a35; border-radius:14px; padding:16px 18px; }
  .card.wide { grid-column:1 / -1; }
  .label { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.08em; }
  .value { font-size:34px; font-weight:600; margin-top:4px; font-variant-numeric:tabular-nums; }
  .value small { font-size:14px; color:var(--muted); font-weight:400; margin-left:4px; }
  .hero .value { font-size:72px; line-height:1; color:var(--accent); }
  .sub { color:var(--muted); font-size:13px; margin-top:6px; }
  canvas { width:100%; height:220px; display:block; }
  .stale .hero .value { color:var(--warn); }
</style>
</head>
<body>
<header>
  <h1>WHOOP live</h1>
  <div class="status">
    <span><span class="dot" id="dot"></span><span id="conn">connecting…</span></span>
    <span id="device"></span>
    <span id="battery"></span>
    <span id="age"></span>
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
    <canvas id="chart" width="1000" height="220"></canvas>
  </div>
</main>
<script>
const $ = id => document.getElementById(id);
const canvas = $('chart'), ctx = canvas.getContext('2d');
let lastAt = 0;

function fmt(v, d = 0) { return (v === null || v === undefined) ? '—' : Number(v).toFixed(d); }

function draw(series) {
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!series || series.length < 2) return;
  const t0 = series[series.length - 1][0] - 300, t1 = series[series.length - 1][0];
  const vals = series.map(p => p[1]);
  const lo = Math.max(30, Math.min(...vals) - 5), hi = Math.max(...vals) + 5;
  ctx.strokeStyle = '#2a3340'; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) { const y = 10 + (h - 20) * i / 4; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    ctx.fillStyle = '#8a94a3'; ctx.font = '12px sans-serif'; ctx.fillText(Math.round(hi - (hi - lo) * i / 4), 4, y - 3); }
  ctx.strokeStyle = '#19d3b5'; ctx.lineWidth = 2; ctx.beginPath();
  let started = false, prevT = null;
  for (const [t, v] of series) {
    const x = (t - t0) / (t1 - t0) * w, y = 10 + (h - 20) * (1 - (v - lo) / (hi - lo));
    if (!started || (prevT !== null && t - prevT > 5)) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
    prevT = t;
  }
  ctx.stroke();
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
