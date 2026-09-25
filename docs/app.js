import * as W from './whoop.js';
import * as M from './metrics.js';
import * as S from './storage.js';

const $ = (id) => document.getElementById(id);
const DEMO = new URLSearchParams(location.search).has('demo');
const hero = document.querySelector('.card.hero');

/** Circumference of the gauge ring (r = 56). The arc is a fraction of it. */
const GAUGE_C = 2 * Math.PI * 56;

// ── settings ───────────────────────────────────────────────────────────

const DEFAULTS = { age: 30, maxHr: 190, restHr: 60, sex: 'male' };
let settings = { ...DEFAULTS, ...readSettings() };

function readSettings() {
  try {
    return JSON.parse(localStorage.getItem('strapline.settings') ?? '{}');
  } catch {
    return {};
  }
}
function writeSettings() {
  try {
    localStorage.setItem('strapline.settings', JSON.stringify(settings));
  } catch {
    /* private browsing — settings just won't persist */
  }
}

// ── state ──────────────────────────────────────────────────────────────

const state = {
  device: null,
  zone: null,
  zoneApplied: null,
  cmdTo: null,
  seq: 0xa0,
  pending: new Map(),
  writeChain: Promise.resolve(),
  liveOn: false,
  hr: new Map(), // whole second -> bpm
  beats: [], // {t, rr}
  samples: [], // {t, hr, rr, wearing}
  session: null,
  battery: null,
  serial: null,
  wearing: null,
  lastSampleAt: 0,
  demoTimer: null,
  saveTimer: null,
};

/** Gradient pair per heart-rate zone, matching the bars in the zones card. */
const ZONE_RAMP = {
  1: ['#55627a', '#7c8aa3'],
  2: ['#4da3ff', '#6ac7ff'],
  3: ['#00e5b0', '#7ddc5b'],
  4: ['#f5b43f', '#ffd36e'],
  5: ['#ff5d5d', '#ff8f6b'],
};
/** Below zone 1 the page keeps its own colour rather than borrowing zone 1's
 *  slate: resting is the state the app is in most of the time, and a dashboard
 *  that goes grey whenever nothing is happening reads as switched off. The zone
 *  chip still says "Below zone 1", so nothing is claimed that was not measured. */
const REST_RAMP = ['#00e5b0', '#7ddc5b'];

/** Canvas cannot read CSS variables, so the ink the charts use is declared
 *  here and kept identical to design-tokens.md. */
const INK = {
  grid: 'rgba(255,255,255,.05)',
  gridStrong: 'rgba(255,255,255,.09)',
  axis: '#3b4454',
  dot: '#eef2f8',
  violet: '#8b7cf6',
};

const hexRgb = (hex) => {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};
const rgba = (hex, a) => `rgba(${hexRgb(hex).join(',')},${a})`;

const nowSec = () => Date.now() / 1000;
const series = () => [...state.hr.entries()].sort((a, b) => a[0] - b[0]);
const recentBeats = (span) => {
  const cut = nowSec() - span;
  return state.beats.filter((b) => b.t >= cut);
};

// ── transport ──────────────────────────────────────────────────────────

function nextSeq() {
  const s = state.seq;
  state.seq = state.seq >= 0xff ? 0xa0 : state.seq + 1;
  return s;
}

/** Serialised write. Refuses any opcode outside the allowlist in whoop.js. */
function send(opcode, payload = [0x00]) {
  if (!W.ALLOWED_OPCODES.has(opcode)) {
    return Promise.reject(new Error(`refused opcode 0x${opcode.toString(16)} — not on the allowlist`));
  }
  const seq = nextSeq();
  const frame = W.encodeCommand(seq, opcode, payload);
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(seq);
      reject(new Error(`no reply to 0x${opcode.toString(16)}`));
    }, 6000);
    state.pending.set(seq, { resolve, reject, timer });
  });
  state.writeChain = state.writeChain
    .then(() =>
      state.cmdTo.writeValueWithResponse
        ? state.cmdTo.writeValueWithResponse(frame)
        : state.cmdTo.writeValue(frame),
    )
    .catch((e) => console.warn('write failed', e));
  return result;
}

function onChunk(asm, bytes) {
  for (const frame of asm.feed(bytes)) {
    switch (frame.packetType) {
      case W.PacketType.COMMAND_RESPONSE: {
        const r = W.decodeResponse(frame.inner);
        if (!r) break;
        const p = state.pending.get(r.echoedSeq);
        if (p) {
          clearTimeout(p.timer);
          state.pending.delete(r.echoedSeq);
          p.resolve(r);
        }
        break;
      }
      case W.PacketType.REALTIME_DATA: {
        const s = W.parseRealtimeHr(frame.inner);
        if (s) pushSample(nowSec(), s.hr, s.rrMs, s.wearing);
        break;
      }
      case W.PacketType.EVENT: {
        const e = W.decodeEvent(frame.inner);
        if (e?.id === 9) state.wearing = true;
        if (e?.id === 10) state.wearing = false;
        break;
      }
    }
  }
}

async function connect() {
  const device = await navigator.bluetooth.requestDevice({
    filters: [{ services: [W.SERVICE] }, { namePrefix: 'WHOOP' }],
    optionalServices: [W.SERVICE],
  });
  state.device = device;
  device.addEventListener('gattserverdisconnected', onDisconnected);
  showDash(device.name ?? 'WHOOP');
  setStatus('connecting', false);

  const server = await device.gatt.connect();
  const svc = await server.getPrimaryService(W.SERVICE);
  state.cmdTo = await svc.getCharacteristic(W.CHAR_CMD_TO);
  for (const uuid of [W.CHAR_CMD_FROM, W.CHAR_EVENTS, W.CHAR_DATA]) {
    const ch = await svc.getCharacteristic(uuid);
    const asm = new W.FrameReassembler();
    await ch.startNotifications();
    ch.addEventListener('characteristicvaluechanged', (e) => {
      const v = e.target.value;
      onChunk(asm, new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    });
  }

  startSession(device.name ?? 'WHOOP');

  try {
    const hello = W.decodeHello((await send(W.Cmd.GET_HELLO_HARVARD, [0x00])).payload);
    if (hello) {
      state.serial = hello.serial;
      state.battery = hello.batteryPct;
      state.session.serial = hello.serial;
    }
  } catch (e) {
    console.warn('hello failed', e);
  }
  try {
    state.battery = W.decodeBattery((await send(W.Cmd.GET_BATTERY_LEVEL, [])).payload) ?? state.battery;
  } catch (e) {
    console.warn('battery failed', e);
  }

  await send(W.Cmd.TOGGLE_REALTIME_HR, [0x01]).catch((e) => console.warn('live on', e));
  state.liveOn = true;
  setStatus('live', true);
  holdScreen();

  setInterval(() => send(W.Cmd.LINK_VALID, [0x00]).catch(() => {}), 10000);
  setInterval(async () => {
    try {
      state.battery = W.decodeBattery((await send(W.Cmd.GET_BATTERY_LEVEL, [])).payload) ?? state.battery;
    } catch {
      /* a missed battery poll is not worth surfacing */
    }
  }, 60000);
}

async function disconnect() {
  if (state.demoTimer) clearInterval(state.demoTimer);
  if (state.liveOn) {
    try {
      await send(W.Cmd.TOGGLE_REALTIME_HR, [0x00]);
    } catch {
      /* going away anyway */
    }
    state.liveOn = false;
  }
  releaseScreen();
  await persist();
  try {
    state.device?.gatt?.disconnect();
  } catch {
    /* already gone */
  }
  onDisconnected();
}

function onDisconnected() {
  setStatus('disconnected', false);
  persist();
}

// ── session ────────────────────────────────────────────────────────────

function startSession(deviceName) {
  state.session = {
    id: `s-${Date.now()}`,
    startedAt: Date.now(),
    endedAt: null,
    device: deviceName,
    serial: null,
    samples: state.samples,
    summary: {},
  };
  clearInterval(state.saveTimer);
  state.saveTimer = setInterval(persist, 15000);
}

async function persist() {
  if (!state.session || !state.samples.length) return;
  const hrv = M.hrv(state.beats);
  const all = series();
  state.session.endedAt = Date.now();
  state.session.samples = state.samples;
  state.session.summary = {
    samples: state.samples.length,
    avgHr: all.length ? all.reduce((s, [, v]) => s + v, 0) / all.length : null,
    minHr: all.length ? Math.min(...all.map(([, v]) => v)) : null,
    maxHr: all.length ? Math.max(...all.map(([, v]) => v)) : null,
    rmssd: hrv?.rmssd ?? null,
    trimp: M.trimp(all, settings),
  };
  try {
    await S.saveSession(state.session);
    await renderSessions();
  } catch (e) {
    console.warn('save failed', e);
  }
}

function pushSample(t, hr, rr, wearing) {
  if (hr > 0) state.hr.set(Math.floor(t), hr);
  for (const v of rr) state.beats.push({ t, rr: v });
  if (wearing !== null && wearing !== undefined) state.wearing = wearing;
  state.samples.push({ t, hr, rr, wearing });
  state.lastSampleAt = t;
  render();
}

// ── rendering ──────────────────────────────────────────────────────────

function setStatus(text, live) {
  $('statusText').textContent = text;
  $('statusPill').className = `pill${live ? ' live' : ''}`;
}

function showDash(deviceName) {
  $('gate').classList.add('hidden');
  $('dash').classList.remove('hidden');
  $('devicePill').classList.remove('hidden');
  $('deviceText').textContent = deviceName;
  // Arms the zone-tinted wash behind the page; on the landing page there is no
  // zone to report and the tint would be decoration.
  document.body.classList.add('armed');
  drawGaugeTicks();
  render();
}

const fmt = (v, d = 0) => (v === null || v === undefined || Number.isNaN(v) ? '--' : Number(v).toFixed(d));

function hhmmss(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s % 60).padStart(2, '0')}`;
}

// ── number animation ───────────────────────────────────────────────────
//
// Readings arrive once a second and snapping between them looks mechanical.
// Each figure eases toward its target instead, which also makes a changing
// value legible as movement out of the corner of the eye.

const tweens = new Map();

function setNum(id, target, decimals = 0) {
  const el = $(id);
  if (target === null || target === undefined || Number.isNaN(target)) {
    tweens.delete(id);
    if (el.textContent !== '--') el.textContent = '--';
    // A value that has never arrived shimmers in its own footprint, so the card
    // does not jump sideways when the first reading lands.
    el.classList.add('waiting');
    return;
  }
  el.classList.remove('waiting');
  const t = tweens.get(id);
  if (!t) {
    tweens.set(id, { current: target, target, decimals });
    el.textContent = target.toFixed(decimals);
  } else {
    t.target = target;
    t.decimals = decimals;
    startNumbers();
  }
}

// The tween loop runs only while something is actually moving. Left running it
// wakes the compositor sixty times a second to write the same string.
let numbersRunning = false;

function startNumbers() {
  if (numbersRunning || document.hidden) return;
  numbersRunning = true;
  requestAnimationFrame(animateNumbers);
}

function animateNumbers() {
  let moving = false;
  for (const [id, t] of tweens) {
    const delta = t.target - t.current;
    if (Math.abs(delta) < 0.005) {
      t.current = t.target;
    } else {
      t.current += delta * 0.18;
      moving = true;
    }
    const text = t.current.toFixed(t.decimals);
    const el = $(id);
    if (el.textContent !== text) el.textContent = text;
  }
  numbersRunning = moving;
  if (moving) requestAnimationFrame(animateNumbers);
}

/**
 * Stroke a path through `pts` using Catmull-Rom control points, so the trace
 * curves through every sample instead of showing the polygon corners a
 * straight-segment path would. `pts` is [[x, y, breakBefore], …].
 */
function smoothPath(ctx, pts) {
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < pts.length; i++) {
    const [x, y, brk] = pts[i];
    if (!started || brk) {
      ctx.moveTo(x, y);
      started = true;
      continue;
    }
    const p0 = pts[i - 2] ?? pts[i - 1];
    const p1 = pts[i - 1];
    const p2 = pts[i];
    const p3 = pts[i + 1] ?? pts[i];
    // A gap either side means there is no meaningful tangent; fall back to a line.
    if (p2[2] || (pts[i + 1] && pts[i + 1][2])) {
      ctx.lineTo(x, y);
      continue;
    }
    ctx.bezierCurveTo(
      p1[0] + (p2[0] - p0[0]) / 6,
      p1[1] + (p2[1] - p0[1]) / 6,
      p2[0] - (p3[0] - p1[0]) / 6,
      p2[1] - (p3[1] - p1[1]) / 6,
      p2[0],
      p2[1],
    );
  }
}

// Contexts and gradients are kept rather than rebuilt: at one sample a second
// across four charts, re-acquiring a context and re-describing three gradients
// every frame is work that produces an identical result.
const ctxCache = new WeakMap();

/**
 * Prepare a canvas for drawing at device resolution.
 *
 * Height comes from the element as the stylesheet laid it out, so chart heights
 * stay a layout decision (style.css) instead of magic numbers spread through
 * the drawing code. The backing store is capped at 3× — above that the extra
 * pixels cost fill rate on a phone and show nothing a human eye can resolve.
 */
function ctxFor(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const w = canvas.clientWidth || 600;
  const h = canvas.clientHeight || 120;
  let ctx = ctxCache.get(canvas);
  if (!ctx) {
    ctx = canvas.getContext('2d');
    ctxCache.set(canvas, ctx);
  }
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

/** A hairline lands on a half-pixel or it renders as a two-pixel smear. */
const crisp = (v) => Math.round(v) + 0.5;

function emptyNote(ctx, w, h, lines) {
  ctx.fillStyle = INK.axis;
  ctx.font = '12px -apple-system, system-ui, sans-serif';
  lines.forEach((line, i) => ctx.fillText(line, 2, h / 2 - 7 + i * 18));
}

// One redraw per animation frame, never one per sample.
//
// Readings arrive once a second, the clock ticks once a second and a resize can
// fire dozens of times: without coalescing, the same four charts are drawn
// several times for one visible change. Nothing is drawn at all while the
// document is hidden — a phone with the screen off was redrawing four canvases
// a second, which is a battery bug with no observer.
let renderQueued = false;

function render() {
  if (renderQueued || document.hidden) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (!document.hidden) renderNow();
  });
}

function renderNow() {
  const all = series();
  const age = nowSec() - state.lastSampleAt;
  const last = state.samples[state.samples.length - 1];

  if (state.lastSampleAt && age > 6 && state.liveOn) {
    $('statusPill').className = 'pill stale';
    $('statusText').textContent = `no data ${Math.round(age)}s`;
  } else if (state.liveOn) {
    setStatus('live', true);
  }

  const hr = last?.hr > 0 ? last.hr : null;
  setNum('hr', hr, 0);

  // Pulse the figure at the rate it is reporting. Idle animation would be
  // decoration; driven by the measurement it is a second read of the number.
  const hrEl = $('hr');
  if (hr) {
    hrEl.style.setProperty('--beat', `${(60 / hr).toFixed(2)}s`);
    hrEl.classList.add('beating');
  } else {
    hrEl.classList.remove('beating');
  }

  const pct = hr ? Math.min(1.1, hr / settings.maxHr) : 0;
  $('gaugeArc').setAttribute(
    'stroke-dasharray',
    `${(pct * GAUGE_C).toFixed(1)} ${GAUGE_C.toFixed(1)}`,
  );
  $('gaugePct').textContent = hr ? `${Math.round(pct * 100)}%` : '--';

  const zone = M.zoneFor(hr, settings.maxHr);
  // The gauge takes the colour of the zone it is reporting, so effort is
  // readable from across a room without parsing the number. Published once as
  // a custom property, it also tints the page wash, the hero glow, the live
  // dot and the trace — one assignment instead of six repaints.
  const [c1, c2] = zone ? ZONE_RAMP[zone.n] : REST_RAMP;
  state.zone = { c1, c2, n: zone?.n ?? 0 };
  if (state.zoneApplied !== c1) {
    state.zoneApplied = c1;
    document.documentElement.style.setProperty('--zone', c1);
    document.documentElement.style.setProperty('--zone-rgb', hexRgb(c1).join(', '));
    $('gaugeStop1').setAttribute('stop-color', c1);
    $('gaugeStop2').setAttribute('stop-color', c2);
    $('gaugeArc').style.filter = `drop-shadow(0 0 7px ${rgba(c1, 0.45)})`;
  }
  // The ring expands once per measured beat, at the measured rate.
  hero.classList.toggle('beating-ring', Boolean(hr));

  const chip = $('zoneChip');
  chip.querySelector('i').style.background = zone ? c1 : 'var(--faint)';
  chip.style.borderColor = zone ? `${c1}55` : '';
  chip.querySelector('span').textContent = zone
    ? `Zone ${zone.n} · ${zone.name}`
    : hr
      ? 'Below zone 1'
      : 'waiting for beats';

  $('wristText').textContent =
    state.wearing === null ? '' : state.wearing ? 'on wrist' : 'off wrist';
  hero.classList.toggle('off-wrist', state.wearing === false);

  const window5 = recentBeats(300);
  const hrvNow = M.hrv(window5);
  setNum('rmssd', hrvNow?.rmssd ?? null, 1);
  setNum('sdnn', hrvNow?.sdnn ?? null, 1);
  setNum('pnn50', hrvNow?.pnn50 ?? null, 1);
  $('hrvSub').textContent = hrvNow
    ? `${hrvNow.beats} beats · SD1 ${hrvNow.sd1.toFixed(1)} / SD2 ${hrvNow.sd2.toFixed(1)} ms`
    : `needs about 30 beats — have ${window5.length}`;

  const resp = M.respiratoryRate(window5);
  setNum('resp', resp?.brpm ?? null, 1);
  $('respSub').textContent = resp ? 'from beat rhythm (RSA)' : 'from beat rhythm · needs 2 min';

  setNum('restHr', M.restingProxy(all), 0);

  const trimpValue = M.trimp(all, settings);
  setNum('trimp', trimpValue, 1);
  setNum('load', M.loadScore(trimpValue), 1);
  $('loadSub').textContent = all.length ? `over ${hhmmss(all.length)} of data` : 'accumulating';

  $('maxHrLabel').textContent = `max ${settings.maxHr} bpm`;
  $('clockText').textContent = state.session ? hhmmss((Date.now() - state.session.startedAt) / 1000) : '00:00';
  $('deviceText').textContent =
    [state.device?.name ?? state.session?.device, state.serial]
      .filter(Boolean)
      .join(' · ') || 'demo';
  renderBattery();
  $('sessionMeta').textContent = `${state.samples.length} samples · ${state.beats.length} beats`;

  renderZones(all, zone);
  drawWave(all);
  drawPoincare(recentBeats(600));
  drawLoad(all);
}

// The zone rows are rebuilt as markup on every render, but only the widths and
// the highlighted row ever change, so the DOM is written once per build and the
// result is compared before it is assigned. Re-parsing identical HTML at 1 Hz
// throws away the CSS transition on every bar.
let zonesHtml = '';

function renderZones(all, currentZone) {
  const { secs, below } = M.zoneSeconds(all, settings.maxHr);
  const total = all.length || 1;
  const bpm = (frac) => Math.round(frac * settings.maxHr);
  const rows = M.ZONES.map((z) => {
    const s = secs.get(z.n);
    const here = currentZone?.n === z.n ? ' now' : '';
    // Naming the zone and its bpm range makes the card useful before any time
    // has been spent in it: it answers "what would zone 4 feel like" as well
    // as "how long was I there".
    const range = z.n === 5 ? `${bpm(z.from)}+` : `${bpm(z.from)}–${bpm(z.to) - 1}`;
    return `<div class="zrow${here}${s ? '' : ' empty'}">
      <div class="zname"><b>Z${z.n} ${z.name}</b><span class="zrange">${range} bpm</span></div>
      <span class="ztime">${s ? hhmmss(s) : '--'}</span>
      <div class="ztrack"><div class="zfill" style="width:${((s / total) * 100).toFixed(1)}%;background:${z.color}"></div></div>
    </div>`;
  });
  rows.push(
    `<div class="zrow${below ? '' : ' empty'}">
      <div class="zname"><b style="color:var(--faint)">Below Z1</b><span class="zrange">under ${bpm(0.5)} bpm</span></div>
      <span class="ztime">${below ? hhmmss(below) : '--'}</span>
      <div class="ztrack"><div class="zfill" style="width:${((below / total) * 100).toFixed(1)}%;background:rgba(255,255,255,.14)"></div></div>
    </div>`,
  );
  const html = rows.join('');
  if (html !== zonesHtml) {
    zonesHtml = html;
    $('zones').innerHTML = html;
  }
}

/** Battery as a cell that fills, because a percentage alone is a number to
 *  read and a cell is a thing to glance at. */
function renderBattery() {
  const pill = $('battPill');
  if (state.battery === null || state.battery === undefined) {
    pill.classList.add('hidden');
    return;
  }
  const pct = Math.max(0, Math.min(100, state.battery));
  pill.classList.remove('hidden');
  pill.classList.toggle('low', pct <= 25 && pct > 10);
  pill.classList.toggle('critical', pct <= 10);
  pill.querySelector('i').style.setProperty('--lvl', `${pct.toFixed(0)}%`);
  const text = `${pct.toFixed(0)}%`;
  if ($('battText').textContent !== text) $('battText').textContent = text;
}

/** Zone boundaries on the gauge ring, drawn once: at 50, 60, 70, 80 and 90% of
 *  maximum heart rate, which is where the five zones start. */
function drawGaugeTicks() {
  const g = $('gaugeTicks');
  g.innerHTML = M.ZONES.map((z) => {
    const a = z.from * 2 * Math.PI - Math.PI / 2;
    const x1 = 66 + Math.cos(a) * 51;
    const y1 = 66 + Math.sin(a) * 51;
    const x2 = 66 + Math.cos(a) * 61;
    const y2 = 66 + Math.sin(a) * 61;
    return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
  }).join('');
}

function drawWave(all) {
  const { ctx, w, h } = ctxFor($('wave'));
  if (all.length < 2) {
    emptyNote(ctx, w, h, ['waiting for the first readings']);
    return;
  }
  const t1 = all[all.length - 1][0];
  // Use the real span until there is a full window, so the trace fills the card
  // from the first seconds instead of hugging the right edge.
  const t0 = Math.max(all[0][0], t1 - 180);
  const pts = all.filter(([t]) => t >= t0);
  if (pts.length < 2) return;
  const vals = pts.map(([, v]) => v);
  const lo = Math.min(...vals) - 4;
  const hi = Math.max(...vals) + 4;
  const padT = 16;
  const padB = 18;
  // Inset the right edge so the leading dot and its halo are not clipped.
  const x = (t) => 2 + ((t - t0) / Math.max(1, t1 - t0)) * (w - 14);
  const y = (v) => h - padB - ((v - lo) / Math.max(1, hi - lo)) * (h - padT - padB);

  ctx.strokeStyle = INK.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= 3; i++) {
    const gy = crisp(padT + ((h - padT - padB) * i) / 3);
    ctx.moveTo(0, gy);
    ctx.lineTo(w, gy);
  }
  ctx.stroke();

  // A pause in the readings (off wrist, a dropped notification) must break the
  // trace — joining across it would draw a heart rate that was never measured.
  const screen = pts.map(([t, v], i) => [x(t), y(v), i > 0 && t - pts[i - 1][0] > 5]);

  const runs = [];
  let run = [];
  for (const p of screen) {
    if (p[2] && run.length) {
      runs.push(run);
      run = [];
    }
    run.push([p[0], p[1], false]);
  }
  if (run.length) runs.push(run);

  // The trace is coloured by the zone each reading was in, so the shape of the
  // session carries its intensity: a stop is added only where the zone changes,
  // which is a handful of stops for a three-minute window.
  const line = ctx.createLinearGradient(0, 0, w, 0);
  let lastColour = null;
  pts.forEach(([t, v], i) => {
    const z = M.zoneFor(v, settings.maxHr);
    const colour = (z ? ZONE_RAMP[z.n] : REST_RAMP)[0];
    if (colour === lastColour) return;
    const at = Math.min(1, Math.max(0, (x(t) - 2) / Math.max(1, w - 14)));
    if (lastColour !== null) line.addColorStop(Math.max(0, at - 0.001), lastColour);
    line.addColorStop(at, colour);
    lastColour = colour;
    if (i === 0) line.addColorStop(0, colour);
  });

  const tint = state.zone?.c1 ?? '#00e5b0';
  const fill = ctx.createLinearGradient(0, padT, 0, h);
  fill.addColorStop(0, rgba(tint, 0.3));
  fill.addColorStop(0.7, rgba(tint, 0.05));
  fill.addColorStop(1, rgba(tint, 0));

  for (const r of runs) {
    if (r.length < 2) continue;
    smoothPath(ctx, r);
    ctx.lineTo(r[r.length - 1][0], h);
    ctx.lineTo(r[0][0], h);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();

    smoothPath(ctx, r);
    ctx.strokeStyle = line;
    ctx.lineWidth = 2.4;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.shadowColor = rgba(tint, 0.45);
    ctx.shadowBlur = 10;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  const [lx, ly] = screen[screen.length - 1];
  ctx.beginPath();
  ctx.arc(lx, ly, 9, 0, Math.PI * 2);
  ctx.fillStyle = rgba(tint, 0.14);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(lx, ly, 3.4, 0, Math.PI * 2);
  ctx.fillStyle = INK.dot;
  ctx.shadowColor = rgba(tint, 0.9);
  ctx.shadowBlur = 9;
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.fillStyle = INK.axis;
  ctx.font = '10.5px -apple-system, system-ui, sans-serif';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(`${Math.round(hi)}`, 2, 11);
  ctx.fillText(`${Math.round(lo)}`, 2, h - 4);
  const mins = (t1 - t0) / 60;
  if (mins >= 1) {
    const label = `${Math.round(mins)} min`;
    ctx.fillText(label, w - ctx.measureText(label).width - 2, h - 4);
  }
}

function drawPoincare(beats) {
  const { ctx, w, h } = ctxFor($('poincare'));
  const nn = M.cleanRr(beats);
  const pairs = [];
  for (let i = 1; i < nn.length; i++) {
    if (nn[i].t - nn[i - 1].t <= 2.5) pairs.push([nn[i - 1].rr, nn[i].rr]);
  }
  if (pairs.length < 4) {
    emptyNote(ctx, w, h, ['each beat against the one before it', `${pairs.length} of 4 beat pairs so far`]);
    return;
  }

  // RR against RR: both axes are the same quantity, so the plot has to be
  // square or the SD1/SD2 spread it exists to show would be distorted.
  const side = Math.min(w - 26, h - 16);
  const ox = 22 + (w - 26 - side) / 2;
  const oy = (h - 16 - side) / 2;
  const flat = pairs.flat();
  const lo = Math.min(...flat) - 25;
  const hi = Math.max(...flat) + 25;
  const span = Math.max(1, hi - lo);
  const x = (v) => ox + ((v - lo) / span) * side;
  const y = (v) => oy + side - ((v - lo) / span) * side;
  const perMs = side / span;

  // A frame, so the square reads as a plot with axes rather than a cloud of
  // dots floating in a card.
  ctx.strokeStyle = INK.grid;
  ctx.lineWidth = 1;
  ctx.strokeRect(crisp(ox), crisp(oy), Math.round(side), Math.round(side));

  ctx.strokeStyle = INK.gridStrong;
  ctx.setLineDash([3, 4]);
  ctx.beginPath();
  ctx.moveTo(x(lo), y(lo));
  ctx.lineTo(x(hi), y(hi));
  ctx.stroke();
  ctx.setLineDash([]);

  // The SD1/SD2 ellipse is the standard reading of this plot: width along the
  // identity line is long-term variability, thickness across it is beat-to-beat.
  const stats = M.hrv(beats);
  if (stats) {
    const mean = stats.meanRr;
    ctx.save();
    ctx.translate(x(mean), y(mean));
    ctx.rotate(-Math.PI / 4);
    ctx.beginPath();
    ctx.ellipse(0, 0, stats.sd2 * perMs, stats.sd1 * perMs, 0, 0, Math.PI * 2);
    ctx.fillStyle = rgba(INK.violet, 0.08);
    ctx.fill();
    ctx.strokeStyle = rgba(INK.violet, 0.65);
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.restore();
  }

  // Age fades the dots, so the cloud shows where the beats are going, not only
  // where they have been. The most recent beat is drawn last and brightest.
  pairs.forEach(([a, b], i) => {
    const fresh = i / pairs.length;
    ctx.beginPath();
    ctx.arc(x(a), y(b), 2.5, 0, Math.PI * 2);
    ctx.fillStyle = rgba(state.zone?.c1 ?? '#00e5b0', 0.12 + 0.7 * fresh);
    ctx.fill();
  });
  const [la, lb] = pairs[pairs.length - 1];
  ctx.beginPath();
  ctx.arc(x(la), y(lb), 3.6, 0, Math.PI * 2);
  ctx.fillStyle = INK.dot;
  ctx.shadowColor = rgba(state.zone?.c1 ?? '#00e5b0', 0.9);
  ctx.shadowBlur = 8;
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.fillStyle = INK.axis;
  ctx.font = '10.5px -apple-system, system-ui, sans-serif';
  const xLabel = 'RR\u2099 \u2192';
  ctx.fillText(xLabel, ox + side - ctx.measureText(xLabel).width, h - 3);
  // Up the empty left margin beside the square plot, reading bottom-to-top.
  ctx.save();
  ctx.translate(11, oy + side);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('RR\u2099\u208a\u2081 \u2192', 0, 0);
  ctx.restore();
}

function drawLoad(all) {
  const { ctx, w, h } = ctxFor($('loadChart'));
  if (all.length < 5) {
    emptyNote(ctx, w, h, ['load builds once the session has a few minutes in it']);
    return;
  }
  const pts = [];
  let acc = 0;
  for (const [t, hr] of all) {
    const reserve = (hr - settings.restHr) / (settings.maxHr - settings.restHr);
    if (reserve > 0) {
      const k = settings.sex === 'female' ? 1.67 : 1.92;
      const b = settings.sex === 'female' ? 0.86 : 0.64;
      acc += (1 / 60) * Math.min(reserve, 1.2) * b * Math.exp(k * Math.min(reserve, 1.2));
    }
    pts.push([t, acc]);
  }
  const t0 = pts[0][0];
  const t1 = pts[pts.length - 1][0] || t0 + 1;
  const max = acc || 1;
  const padR = 8;
  const x = (t) => ((t - t0) / Math.max(1, t1 - t0)) * (w - padR);
  const y = (v) => h - 7 - (v / max) * (h - 18);

  ctx.strokeStyle = INK.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= 2; i++) {
    const gy = crisp(11 + ((h - 18) * i) / 2);
    ctx.moveTo(0, gy);
    ctx.lineTo(w, gy);
  }
  ctx.stroke();

  // Thin the series before drawing: a long session holds thousands of seconds
  // and the curve cannot show more detail than there are pixels.
  const step = Math.max(1, Math.floor(pts.length / Math.max(60, w)));
  const screen = pts.filter((_, i) => i % step === 0 || i === pts.length - 1).map(([t, v]) => [x(t), y(v), false]);

  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, rgba(INK.violet, 0.44));
  grad.addColorStop(1, rgba(INK.violet, 0));
  smoothPath(ctx, screen);
  ctx.lineTo(x(t1), h);
  ctx.lineTo(x(t0), h);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  smoothPath(ctx, screen);
  ctx.strokeStyle = INK.violet;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.shadowColor = rgba(INK.violet, 0.5);
  ctx.shadowBlur = 8;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Where the load has got to, so the curve has a reading and not just a shape.
  const [ex, ey] = screen[screen.length - 1];
  ctx.beginPath();
  ctx.arc(ex, ey, 3, 0, Math.PI * 2);
  ctx.fillStyle = INK.dot;
  ctx.fill();
}

async function renderSessions() {
  let list = [];
  try {
    list = await S.listSessions();
  } catch {
    return;
  }
  const use = await S.usage().catch(() => null);
  const durable = await S.requestPersistence();
  const pct = use?.quota ? (use.used / use.quota) * 100 : null;
  $('storageText').textContent = [
    `${list.length} saved`,
    use ? `${(use.used / 1e6).toFixed(1)} MB of ${(use.quota / 1e9).toFixed(1)} GB` : null,
    pct !== null && pct > 70 ? `${pct.toFixed(0)}% full — export and compact` : null,
    durable === false ? 'may be cleared by the browser — export to keep' : null,
  ]
    .filter(Boolean)
    .join(' · ');

  if (!list.length) {
    $('sessionTable').innerHTML = '';
    return;
  }
  const rows = list
    .slice(0, 8)
    .map((s) => {
      const dur = s.endedAt ? (s.endedAt - s.startedAt) / 1000 : 0;
      // data-label feeds the phone layout, where each row becomes a card and
      // the stylesheet renders these as the field names (style.css, ≤719px).
      return `<tr>
        <td data-label="Started">${new Date(s.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
        <td class="n" data-label="Duration">${hhmmss(dur)}</td>
        <td class="n" data-label="Avg HR">${fmt(s.summary?.avgHr, 0)} bpm</td>
        <td class="n" data-label="RMSSD">${fmt(s.summary?.rmssd, 1)} ms</td>
        <td class="n" data-label="TRIMP">${fmt(s.summary?.trimp, 1)}</td>
        <td class="n" data-label="Size">${s.compacted ? 'summary only' : `${((s.samples?.length ?? 0) * 145 / 1e6).toFixed(1)} MB`}</td>
        <td class="act"><button class="btn small ghost" data-csv="${s.id}">CSV</button>
            ${s.compacted ? '' : `<button class="btn small ghost" data-compact="${s.id}">Compact</button>`}
            <button class="btn small ghost" data-del="${s.id}">Delete</button></td>
      </tr>`;
    })
    .join('');
  $('sessionTable').innerHTML =
    `<thead><tr><th>Started</th><th>Duration</th><th>Avg HR</th><th>RMSSD</th><th>TRIMP</th><th>Size</th><th></th></tr></thead><tbody>${rows}</tbody>`;
}

// ── demo ───────────────────────────────────────────────────────────────

/** Synthetic strap: a wandering heart rate whose beat intervals carry a real
 *  0.25 Hz respiratory modulation, so the derived metrics exercise properly. */
function startDemo() {
  showDash('Demo strap');
  setStatus('live', true);
  state.serial = 'DEMO';
  state.battery = 87;
  state.wearing = true;
  state.liveOn = true;
  startSession('Demo strap');
  holdScreen();
  const t0 = nowSec();
  let carry = 0;
  state.demoTimer = setInterval(() => {
    const t = nowSec();
    const el = t - t0;
    const hr = Math.round(62 + 11 * Math.sin(el / 55) + 4 * Math.sin(el / 7) + (Math.random() - 0.5) * 2);
    const base = 60000 / hr;
    const rr = [];
    carry += 1;
    const beatsThisSecond = Math.random() < base / 1000 ? 1 : 2;
    for (let i = 0; i < beatsThisSecond; i++) {
      rr.push(Math.round(base + 38 * Math.sin(2 * Math.PI * 0.25 * (el + i * 0.5)) + (Math.random() - 0.5) * 8));
    }
    pushSample(t, hr, rr, true);
  }, 1000);
}

// ── wiring ─────────────────────────────────────────────────────────────

function openSettings() {
  $('ageInput').value = settings.age;
  $('maxHrInput').value = settings.maxHr;
  $('restInput').value = settings.restHr;
  $('sexInput').value = settings.sex;
  $('settings').showModal();
}

$('ageInput')?.addEventListener('input', (e) => {
  const age = Number(e.target.value);
  if (age >= 10 && age <= 99) $('maxHrInput').value = 220 - age;
});

$('settingsClose').addEventListener('click', () => {
  settings = {
    age: Number($('ageInput').value) || DEFAULTS.age,
    maxHr: Number($('maxHrInput').value) || DEFAULTS.maxHr,
    restHr: Number($('restInput').value) || DEFAULTS.restHr,
    sex: $('sexInput').value,
  };
  writeSettings();
  $('settings').close();
  render();
});

$('settingsBtn').addEventListener('click', openSettings);
$('stopBtn').addEventListener('click', () => (DEMO ? location.reload() : disconnect()));
$('exportCsv').addEventListener('click', () => state.session && S.exportCsv(state.session));
$('exportJson').addEventListener('click', () => state.session && S.exportJson(state.session));

$('sessionTable').addEventListener('click', async (e) => {
  const csv = e.target.dataset?.csv;
  const del = e.target.dataset?.del;
  if (csv) {
    const s = await S.getSession(csv);
    if (s) S.exportCsv(s);
  }
  const compact = e.target.dataset?.compact;
  if (compact && confirm('Drop the per-second readings and keep only this session\'s summary?\n\nHeart-rate variability cannot be recomputed afterwards. Export first if you want the detail.')) {
    await S.compactSession(compact);
    await renderSessions();
  }
  if (del && confirm('Delete this session permanently?')) {
    await S.deleteSession(del);
    await renderSessions();
  }
});

$('connect').addEventListener('click', async () => {
  try {
    $('connect').disabled = true;
    await connect();
  } catch (e) {
    console.error(e);
    $('connect').disabled = false;
    if (e?.name !== 'NotFoundError') {
      // NotFoundError just means the chooser was dismissed.
      alert(`Could not connect: ${e.message}`);
    }
  }
});

// Connecting stays blocked until the terms are ticked. A repository cannot
// gate `git clone`, so this is the one point where acceptance is actually
// recorded before the software touches anyone's device.
const ACK_KEY = 'strapline.accepted.v1';
const ackBox = $('ackBox');
const supported = Boolean(navigator.bluetooth) || DEMO;

function syncAck() {
  $('connect').disabled = !ackBox.checked || !supported;
  try {
    if (ackBox.checked) localStorage.setItem(ACK_KEY, new Date().toISOString());
    else localStorage.removeItem(ACK_KEY);
  } catch {
    /* private browsing — the tick just won't be remembered next visit */
  }
}

try {
  ackBox.checked = Boolean(localStorage.getItem(ACK_KEY));
} catch {
  /* nothing remembered; the user ticks again */
}
ackBox.addEventListener('change', syncAck);

// iOS is not "an unsupported browser"; it is a device with exactly one browser
// that can do this. Telling an iPhone owner to use Chrome on Windows wastes the
// only moment they are paying attention.
const IOS =
  /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

if (!supported) $(IOS ? 'iosRoute' : 'unsupported').classList.remove('hidden');

$('copyLink').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  try {
    await navigator.clipboard.writeText(location.href);
    btn.textContent = 'Link copied';
  } catch {
    // Clipboard access can be refused; show the link so it can be copied by hand.
    btn.textContent = location.host + location.pathname;
  }
  setTimeout(() => {
    btn.textContent = "Copy this page's link";
  }, 2500);
});

syncAck();

// A canvas has no intrinsic size, so a redraw has to follow the element rather
// than the window: rotating a phone, opening the keyboard, or the bar
// collapsing in a standalone install all resize the cards without a resize
// event that means anything on its own.
if (window.ResizeObserver) {
  const ro = new ResizeObserver(() => render());
  for (const id of ['wave', 'poincare', 'loadChart']) ro.observe($(id));
} else {
  window.addEventListener('resize', () => render());
}

// Nothing is drawn while the document is hidden. Coming back, everything is
// redrawn once — the charts are recomputed from state, so there is no gap to
// repair, only a frame to catch up.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    render();
    startNumbers();
  }
});

// The bar earns its border once content has gone under it.
const topbar = document.querySelector('.topbar');
let scrolled = false;
addEventListener(
  'scroll',
  () => {
    const now = window.scrollY > 4;
    if (now !== scrolled) {
      scrolled = now;
      topbar.classList.toggle('scrolled', now);
    }
  },
  { passive: true },
);

// Full-screen the reading for a set: a phone propped on a bench is two feet
// away, and at that distance the dashboard is one number and a trace.
const focusBtn = $('focusBtn');
function setFocus(on) {
  document.body.classList.toggle('focus', on);
  focusBtn.setAttribute('aria-pressed', String(on));
  focusBtn.setAttribute('aria-label', on ? 'Leave full screen' : 'Full-screen the heart rate');
  render();
}
focusBtn.addEventListener('click', () => setFocus(!document.body.classList.contains('focus')));
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.classList.contains('focus')) setFocus(false);
});

// A sheet that cannot be dismissed by tapping beside it reads as stuck; the
// dialog element gives light dismiss to neither form, so it is wired here.
$('settings').addEventListener('click', (e) => {
  if (e.target === $('settings')) $('settingsClose').click();
});

setInterval(render, 1000);
renderSessions();
if (DEMO) startDemo();

// ── the phone stays awake while it is showing live readings ────────────
//
// A dashboard that blanks after thirty seconds is not a dashboard, and a phone
// propped against a water bottle mid-set cannot be tapped to wake. The lock is
// dropped the moment the tab is hidden (the browser drops it anyway) and taken
// again on return, because a lock is not reacquired automatically.

let wakeLock = null;

async function holdScreen() {
  if (!('wakeLock' in navigator) || document.hidden || !state.liveOn) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch {
    /* denied, low battery, or unsupported — the dashboard still works */
  }
}

function releaseScreen() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) releaseScreen();
  else holdScreen();
});

// ── install to the home screen ─────────────────────────────────────────
//
// Offered rather than nagged: the browser fires this only when the app is
// actually installable, and the button appears on the landing page, never on
// top of live readings.

let installPrompt = null;
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  $('installBtn').classList.remove('hidden');
});
$('installBtn').addEventListener('click', async () => {
  if (!installPrompt) return;
  $('installBtn').classList.add('hidden');
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => {});
  installPrompt = null;
});

// Exposed for the offline protocol check in the console: whoopSelfTest()
window.whoopSelfTest = W.selfTest;

// Offline support. Registered after load so it never competes with the first
// paint, and skipped on file:// where service workers are unavailable.
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('offline support unavailable', e));
  });
}
