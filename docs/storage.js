// Local session storage. Everything stays in this browser: no server, no
// account, no upload. The export buttons are the only way data leaves.

const DB_NAME = 'whoop-live';
const STORE = 'sessions';

let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(mode, fn) {
  return db().then(
    (d) =>
      new Promise((resolve, reject) => {
        const t = d.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        t.oncomplete = () => resolve(req?.result);
        t.onerror = () => reject(t.error);
      }),
  );
}

export const saveSession = (session) => tx('readwrite', (s) => s.put(session));
export const deleteSession = (id) => tx('readwrite', (s) => s.delete(id));
export const getSession = (id) => tx('readonly', (s) => s.get(id));

/**
 * Drop a session's per-second samples, keeping its summary.
 *
 * Roughly 145 bytes per recorded second on disk, so an hour is ~0.5 MB and a
 * full day ~12 MB. The summary is a few hundred bytes and keeps the session
 * visible in history forever. Deliberately NOT automatic: raw beats are the
 * only thing HRV can be recomputed from, so losing them is the user's call.
 */
export async function compactSession(id) {
  const s = await getSession(id);
  if (!s || !s.samples?.length) return null;
  s.samples = [];
  s.compacted = true;
  await saveSession(s);
  return s;
}

export async function listSessions() {
  const all = (await tx('readonly', (s) => s.getAll())) ?? [];
  return all.sort((a, b) => b.startedAt - a.startedAt);
}

/** Rough footprint, so the page can say how much room the data takes. */
export async function usage() {
  if (!navigator.storage?.estimate) return null;
  const { usage: used, quota } = await navigator.storage.estimate();
  return { used, quota };
}

/**
 * Ask the browser not to evict this data under storage pressure.
 *
 * Without it, sessions are "best effort" and can be cleared silently. It is a
 * request, not a guarantee: Chrome grants it based on engagement, and WebKit
 * still wipes script-writable storage after seven days of not opening the app
 * (a home-screen web app gets its own use counter, so regular use resets it).
 * Export remains the only durable copy.
 */
export async function requestPersistence() {
  if (!navigator.storage?.persist) return null;
  try {
    return (await navigator.storage.persisted()) || (await navigator.storage.persist());
  } catch {
    return null;
  }
}

// ── export ─────────────────────────────────────────────────────────────

function download(filename, mime, text) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const stamp = (ms) => new Date(ms).toISOString().replace(/[:.]/g, '-').slice(0, 19);

export function exportJson(session) {
  download(`whoop-${stamp(session.startedAt)}.json`, 'application/json', JSON.stringify(session, null, 2));
}

export function exportCsv(session) {
  const rows = ['timestamp,iso,heart_rate_bpm,rr_intervals_ms,on_wrist'];
  for (const s of session.samples) {
    rows.push([s.t.toFixed(1), new Date(s.t * 1000).toISOString(), s.hr, `"${(s.rr ?? []).join(' ')}"`, s.wearing ?? ''].join(','));
  }
  download(`whoop-${stamp(session.startedAt)}.csv`, 'text/csv', rows.join('\n'));
}
