// Derived metrics from the strap's live 1 Hz stream.
//
// Everything here is computed from two inputs only: per-second heart rate and
// beat-to-beat (RR) intervals. Published methods, named where they apply.
// Absent input returns null — never a filled-in guess.

/** Physiologically possible beat intervals (ms). */
const RR_MIN = 300;
const RR_MAX = 2000;

/**
 * Drop implausible beats and beats that jump too far from their neighbour.
 * A simplified Lipponen–Tarvainen gate: enough to stop one bad beat from
 * inventing 200 ms of HRV, without pretending to be the full algorithm.
 */
export function cleanRr(beats) {
  const ok = beats.filter((b) => b.rr >= RR_MIN && b.rr <= RR_MAX);
  if (ok.length < 3) return ok;
  const out = [];
  for (let i = 0; i < ok.length; i++) {
    const prev = out.length ? out[out.length - 1].rr : ok[i].rr;
    if (Math.abs(ok[i].rr - prev) / prev <= 0.25) out.push(ok[i]);
  }
  return out;
}

/** True when two beats are close enough in time to be successive. */
const successive = (a, b) => b.t - a.t <= 2.5;

/**
 * Time-domain heart-rate variability over the beats in `beats`
 * ({t: seconds, rr: ms}). Returns null when there are too few clean beats.
 */
export function hrv(beats) {
  const nn = cleanRr(beats);
  if (nn.length < 6) return null;
  const rr = nn.map((b) => b.rr);
  const mean = rr.reduce((a, b) => a + b, 0) / rr.length;
  const sdnn = Math.sqrt(rr.reduce((s, v) => s + (v - mean) ** 2, 0) / rr.length);

  const diffs = [];
  for (let i = 1; i < nn.length; i++) {
    if (successive(nn[i - 1], nn[i])) diffs.push(nn[i].rr - nn[i - 1].rr);
  }
  if (diffs.length < 5) return null;
  const rmssd = Math.sqrt(diffs.reduce((s, d) => s + d * d, 0) / diffs.length);
  const pnn50 = (diffs.filter((d) => Math.abs(d) > 50).length / diffs.length) * 100;

  // Poincaré descriptors: SD1 is beat-to-beat scatter (parasympathetic),
  // SD2 the long-axis spread. SD1 = RMSSD/√2 by definition.
  const sd1 = rmssd / Math.SQRT2;
  const sd2 = Math.sqrt(Math.max(0, 2 * sdnn * sdnn - sd1 * sd1));

  return { rmssd, sdnn, pnn50, meanRr: mean, sd1, sd2, beats: nn.length, meanHr: 60000 / mean };
}

/**
 * Respiratory rate from respiratory sinus arrhythmia: the breathing cycle
 * modulates beat intervals, so the dominant 0.1–0.4 Hz component of the
 * tachogram is the breathing rate. Needs ~2 minutes of clean beats.
 */
export function respiratoryRate(beats) {
  const nn = cleanRr(beats);
  if (nn.length < 60) return null;
  const span = nn[nn.length - 1].t - nn[0].t;
  if (span < 110) return null;

  // Resample the tachogram onto a uniform 4 Hz grid.
  const fs = 4;
  const n = Math.floor(span * fs);
  if (n < 128) return null;
  const grid = new Float64Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = nn[0].t + i / fs;
    while (j < nn.length - 2 && nn[j + 1].t < t) j++;
    const a = nn[j], b = nn[j + 1] ?? nn[j];
    const w = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
    grid[i] = a.rr + (b.rr - a.rr) * Math.min(1, Math.max(0, w));
  }
  const mean = grid.reduce((a, b) => a + b, 0) / n;
  for (let i = 0; i < n; i++) {
    // Hann window, so the peak is not smeared by the ends of the record.
    grid[i] = (grid[i] - mean) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  }

  // Naive DFT across the respiratory band only — a few dozen bins, so the
  // cost of not having an FFT here is irrelevant.
  let best = { power: 0, hz: 0 };
  for (let hz = 0.1; hz <= 0.45; hz += 0.002) {
    let re = 0, im = 0;
    for (let i = 0; i < n; i++) {
      const p = (2 * Math.PI * hz * i) / fs;
      re += grid[i] * Math.cos(p);
      im -= grid[i] * Math.sin(p);
    }
    const power = re * re + im * im;
    if (power > best.power) best = { power, hz };
  }
  if (best.power === 0) return null;
  return { brpm: best.hz * 60, hz: best.hz };
}

/** Five zones as a fraction of maximum heart rate (Garmin/ACSM convention). */
export const ZONES = [
  { n: 1, name: 'Warm up', from: 0.5, to: 0.6, color: 'var(--z1)' },
  { n: 2, name: 'Easy', from: 0.6, to: 0.7, color: 'var(--z2)' },
  { n: 3, name: 'Aerobic', from: 0.7, to: 0.8, color: 'var(--z3)' },
  { n: 4, name: 'Threshold', from: 0.8, to: 0.9, color: 'var(--z4)' },
  { n: 5, name: 'Maximum', from: 0.9, to: 1.4, color: 'var(--z5)' },
];

export function zoneFor(hr, maxHr) {
  if (!hr || !maxHr) return null;
  const frac = hr / maxHr;
  if (frac < ZONES[0].from) return null;
  return ZONES.find((z) => frac >= z.from && frac < z.to) ?? ZONES[ZONES.length - 1];
}

/** Seconds spent in each zone across a per-second heart-rate series. */
export function zoneSeconds(series, maxHr) {
  const secs = new Map(ZONES.map((z) => [z.n, 0]));
  let below = 0;
  for (const [, hr] of series) {
    const z = zoneFor(hr, maxHr);
    if (z) secs.set(z.n, secs.get(z.n) + 1);
    else below++;
  }
  return { secs, below };
}

/**
 * Banister TRIMP — training load weighted by how hard each minute was.
 * `sex` shifts the exponential weighting as in the original paper.
 */
export function trimp(series, { restHr, maxHr, sex = 'male' }) {
  if (!series.length || !restHr || !maxHr || maxHr <= restHr) return null;
  const k = sex === 'female' ? 1.67 : 1.92;
  const b = sex === 'female' ? 0.86 : 0.64;
  let total = 0;
  for (const [, hr] of series) {
    const reserve = (hr - restHr) / (maxHr - restHr);
    if (reserve <= 0) continue;
    const r = Math.min(reserve, 1.2);
    total += (1 / 60) * r * b * Math.exp(k * r);
  }
  return total;
}

/**
 * TRIMP on a 0–21 display scale, for a glanceable number.
 * NOT WHOOP's strain score: theirs is proprietary and differently derived.
 * 150 TRIMP ≈ a very hard day, which anchors the top of the scale.
 */
export function loadScore(trimpValue) {
  if (trimpValue == null) return null;
  return Math.min(21, 21 * Math.log1p(trimpValue) / Math.log1p(150));
}

/** Lowest sustained heart rate over `window` seconds — a resting-HR proxy. */
export function restingProxy(series, window = 60) {
  if (series.length < window) return null;
  let best = null;
  for (let i = 0; i + window <= series.length; i++) {
    let sum = 0;
    for (let k = 0; k < window; k++) sum += series[i + k][1];
    const avg = sum / window;
    if (best === null || avg < best) best = avg;
  }
  return best;
}
