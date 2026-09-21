import * as W from './whoop.js';
import * as M from './metrics.js';
import * as S from './storage.js';

const $ = (id) => document.getElementById(id);
const DEMO = new URLSearchParams(location.search).has('demo');

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
}

const fmt = (v, d = 0) => (v === null || v === undefined || Number.isNaN(v) ? '--' : Number(v).toFixed(d));

function hhmmss(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s % 60).padStart(2, '0')}`;
}

function ctxFor(canvas, height) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 600;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.height = `${height}px`;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, height);
  return { ctx, w, h: height };
}

function render() {
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
  $('hr').textContent = hr ?? '--';

  const pct = hr ? Math.min(1.1, hr / settings.maxHr) : 0;
  $('gaugeArc').setAttribute('stroke-dasharray', `${(pct * 352).toFixed(1)} 352`);
  $('gaugePct').textContent = hr ? `${Math.round(pct * 100)}%` : '--';

  const zone = M.zoneFor(hr, settings.maxHr);
  const chip = $('zoneChip');
  chip.querySelector('i').style.background = zone ? zone.color : 'var(--faint)';
  chip.querySelector('span').textContent = zone
    ? `Zone ${zone.n} · ${zone.name}`
    : hr
      ? 'Below zone 1'
      : 'waiting for beats';

  $('wristText').textContent =
    state.wearing === null ? '' : state.wearing ? 'on wrist' : 'off wrist';

  const hrvNow = M.hrv(recentBeats(300));
  $('rmssd').textContent = fmt(hrvNow?.rmssd, 1);
  $('sdnn').textContent = fmt(hrvNow?.sdnn, 1);
  $('pnn50').textContent = fmt(hrvNow?.pnn50, 1);
  $('hrvSub').textContent = hrvNow
    ? `${hrvNow.beats} beats · SD1 ${hrvNow.sd1.toFixed(1)} / SD2 ${hrvNow.sd2.toFixed(1)} ms`
    : `needs about 30 beats — have ${recentBeats(300).length}`;

  const resp = M.respiratoryRate(recentBeats(300));
  $('resp').textContent = fmt(resp?.brpm, 1);
  $('respSub').textContent = resp ? 'from beat rhythm (RSA)' : 'from beat rhythm · needs 2 min';

  $('restHr').textContent = fmt(M.restingProxy(all.map((x) => x)), 0);

  const trimpValue = M.trimp(all, settings);
  $('trimp').textContent = fmt(trimpValue, 1);
  $('load').textContent = fmt(M.loadScore(trimpValue), 1);
  $('loadSub').textContent = all.length ? `over ${hhmmss(all.length)} of data` : 'accumulating';

  $('maxHrLabel').textContent = `max ${settings.maxHr} bpm`;
  $('clockText').textContent = state.session ? hhmmss((Date.now() - state.session.startedAt) / 1000) : '00:00';
  $('deviceText').textContent =
    [state.device?.name ?? state.session?.device, state.serial, state.battery ? `${state.battery.toFixed(0)}%` : null]
      .filter(Boolean)
      .join(' · ') || 'demo';
  $('sessionMeta').textContent = `${state.samples.length} samples · ${state.beats.length} beats`;

  renderZones(all);
  drawWave(all);
  drawPoincare(recentBeats(600));
  drawLoad(all);
}

function renderZones(all) {
  const { secs, below } = M.zoneSeconds(all, settings.maxHr);
  const total = all.length || 1;
  const rows = M.ZONES.map((z) => {
    const s = secs.get(z.n);
    return `<div class="zrow"><b>Z${z.n}</b>
      <div class="ztrack"><div class="zfill" style="width:${((s / total) * 100).toFixed(1)}%;background:${z.color}"></div></div>
      <span>${s ? hhmmss(s) : '--'}</span></div>`;
  });
  rows.push(
    `<div class="zrow"><b style="color:var(--faint)">—</b>
      <div class="ztrack"><div class="zfill" style="width:${((below / total) * 100).toFixed(1)}%;background:rgba(255,255,255,.14)"></div></div>
      <span>${below ? hhmmss(below) : '--'}</span></div>`,
  );
  $('zones').innerHTML = rows.join('');
}

function drawWave(all) {
  const { ctx, w, h } = ctxFor($('wave'), 132);
  if (all.length < 2) return;
  const t1 = all[all.length - 1][0];
  // Use the real span until there is a full window, so the trace fills the card
  // from the first seconds instead of hugging the right edge.
  const t0 = Math.max(all[0][0], t1 - 180);
  const pts = all.filter(([t]) => t >= t0);
  if (pts.length < 2) return;
  const vals = pts.map(([, v]) => v);
  const lo = Math.min(...vals) - 4;
  const hi = Math.max(...vals) + 4;
  const x = (t) => ((t - t0) / (t1 - t0)) * w;
  const y = (v) => h - 12 - ((v - lo) / (hi - lo)) * (h - 26);

  ctx.strokeStyle = 'rgba(255,255,255,.05)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const gy = 12 + ((h - 26) * i) / 3;
    ctx.beginPath();
    ctx.moveTo(0, gy);
    ctx.lineTo(w, gy);
    ctx.stroke();
  }

  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(0,229,176,.30)');
  grad.addColorStop(1, 'rgba(0,229,176,0)');
  ctx.beginPath();
  ctx.moveTo(x(pts[0][0]), h);
  for (const [t, v] of pts) ctx.lineTo(x(t), y(v));
  ctx.lineTo(x(pts[pts.length - 1][0]), h);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  pts.forEach(([t, v], i) => (i ? ctx.lineTo(x(t), y(v)) : ctx.moveTo(x(t), y(v))));
  ctx.strokeStyle = '#00e5b0';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();

  const [lt, lv] = pts[pts.length - 1];
  ctx.beginPath();
  ctx.arc(x(lt), y(lv), 3.5, 0, Math.PI * 2);
  ctx.fillStyle = '#eef2f8';
  ctx.fill();

  ctx.fillStyle = '#4d5768';
  ctx.font = '11px -apple-system, sans-serif';
  ctx.fillText(`${Math.round(hi)}`, 2, 12);
  ctx.fillText(`${Math.round(lo)}`, 2, h - 2);
}

function drawPoincare(beats) {
  const { ctx, w, h } = ctxFor($('poincare'), 176);
  const nn = M.cleanRr(beats);
  if (nn.length < 8) {
    ctx.fillStyle = '#4d5768';
    ctx.font = '12px -apple-system, sans-serif';
    ctx.fillText('Poincaré plot appears once beats arrive', 4, h / 2);
    return;
  }
  const pairs = [];
  for (let i = 1; i < nn.length; i++) {
    if (nn[i].t - nn[i - 1].t <= 2.5) pairs.push([nn[i - 1].rr, nn[i].rr]);
  }
  if (!pairs.length) return;
  const flat = pairs.flat();
  const lo = Math.min(...flat) - 30;
  const hi = Math.max(...flat) + 30;
  const x = (v) => ((v - lo) / (hi - lo)) * (w - 8) + 4;
  const y = (v) => h - 4 - ((v - lo) / (hi - lo)) * (h - 8);

  ctx.strokeStyle = 'rgba(255,255,255,.10)';
  ctx.setLineDash([3, 4]);
  ctx.beginPath();
  ctx.moveTo(x(lo), y(lo));
  ctx.lineTo(x(hi), y(hi));
  ctx.stroke();
  ctx.setLineDash([]);

  pairs.forEach(([a, b], i) => {
    const fresh = i / pairs.length;
    ctx.beginPath();
    ctx.arc(x(a), y(b), 2.6, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(0,229,176,${0.18 + 0.72 * fresh})`;
    ctx.fill();
  });

  ctx.fillStyle = '#4d5768';
  ctx.font = '11px -apple-system, sans-serif';
  ctx.fillText('RRₙ →', w - 46, h - 5);
}

function drawLoad(all) {
  const { ctx, w, h } = ctxFor($('loadChart'), 86);
  if (all.length < 5) return;
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
  const x = (t) => ((t - t0) / Math.max(1, t1 - t0)) * w;
  const y = (v) => h - 6 - (v / max) * (h - 14);

  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(139,124,246,.42)');
  grad.addColorStop(1, 'rgba(139,124,246,0)');
  ctx.beginPath();
  ctx.moveTo(x(t0), h);
  for (const [t, v] of pts) ctx.lineTo(x(t), y(v));
  ctx.lineTo(x(t1), h);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.beginPath();
  pts.forEach(([t, v], i) => (i ? ctx.lineTo(x(t), y(v)) : ctx.moveTo(x(t), y(v))));
  ctx.strokeStyle = '#8b7cf6';
  ctx.lineWidth = 2;
  ctx.stroke();
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
      return `<tr>
        <td>${new Date(s.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
        <td class="n">${hhmmss(dur)}</td>
        <td class="n">${fmt(s.summary?.avgHr, 0)} bpm</td>
        <td class="n">${fmt(s.summary?.rmssd, 1)} ms</td>
        <td class="n">${fmt(s.summary?.trimp, 1)}</td>
        <td class="n">${s.compacted ? 'summary only' : `${((s.samples?.length ?? 0) * 145 / 1e6).toFixed(1)} MB`}</td>
        <td><button class="btn small ghost" data-csv="${s.id}">CSV</button>
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

if (!navigator.bluetooth && !DEMO) {
  $('unsupported').classList.remove('hidden');
  $('connect').disabled = true;
}

window.addEventListener('resize', () => render());
setInterval(render, 1000);
renderSessions();
if (DEMO) startDemo();

// Exposed for the offline protocol check in the console: whoopSelfTest()
window.whoopSelfTest = W.selfTest;
