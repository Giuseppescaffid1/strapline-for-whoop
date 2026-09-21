// WHOOP 4.0 BLE protocol — framing, checksums and decoders.
//
// Pure functions, no Bluetooth: everything here can be unit-tested offline
// (see selfTest at the bottom, which replays frames captured from a real strap).
//
// Frame: [0xAA][size u16 LE][CRC-8 poly 0x07 over the size bytes]
//        [inner, zero-padded to 4 bytes][CRC-32 (zlib) LE over the padded inner]
//   size = padded inner length + 4 (it counts the trailing CRC-32)
//   inner = [packet type][sequence][opcode][payload…]

export const SERVICE = '61080001-8d6d-82b8-614a-1c8cb0f8dcc6';
export const CHAR_CMD_TO = '61080002-8d6d-82b8-614a-1c8cb0f8dcc6';
export const CHAR_CMD_FROM = '61080003-8d6d-82b8-614a-1c8cb0f8dcc6';
export const CHAR_EVENTS = '61080004-8d6d-82b8-614a-1c8cb0f8dcc6';
export const CHAR_DATA = '61080005-8d6d-82b8-614a-1c8cb0f8dcc6';

export const SOF = 0xaa;

export const PacketType = {
  COMMAND: 0x23,
  COMMAND_RESPONSE: 0x24,
  REALTIME_DATA: 0x28,
  HISTORICAL_DATA: 0x2f,
  EVENT: 0x30,
  METADATA: 0x31,
};

export const Cmd = {
  LINK_VALID: 0x01,
  TOGGLE_REALTIME_HR: 0x03,
  GET_BATTERY_LEVEL: 0x1a,
  GET_HELLO_HARVARD: 0x23,
};

// An ALLOWLIST, not a blocklist. Every opcode this page can send is a read or a
// session-scoped toggle that the strap clears when the link drops. Anything not
// listed is refused by the transport before it reaches the radio.
//
// Deliberately absent, though it would work:
//   0x0E SET_GENERIC_HR_PROFILE — wakes the standard Heart Rate service, but it
//        is a PERSISTENT config write; disconnecting does not undo it. The
//        realtime stream below already carries heart rate AND beat intervals.
// Never sendable, and why:
//   0x19 FORCE_TRIM              erases the strap's flash
//   0x21 SET_READ_POINTER        moves the flash read cursor past unsynced records
//   0x1D / 0x20 REBOOT / POWER_CYCLE
//   0x0F FORGET_BONDS            drops pairing; the user must re-pair by hand
//   0x9A / 0x99 persistent optical  green LED stuck on across reboots
//   0x94 WEAR_DETECT_OVERRIDE    sensors keep running off the body
//   0x24-0x26, 0x8E-0x90         firmware update paths
export const ALLOWED_OPCODES = new Set([
  Cmd.LINK_VALID,
  Cmd.TOGGLE_REALTIME_HR,
  Cmd.GET_BATTERY_LEVEL,
  Cmd.GET_HELLO_HARVARD,
]);

// ── checksums ──────────────────────────────────────────────────────────────

export function crc8(bytes) {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC32_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

// ── framing ────────────────────────────────────────────────────────────────

export function pad4(data) {
  const out = new Uint8Array(data.length + ((4 - (data.length % 4)) % 4));
  out.set(data);
  return out;
}

export function buildFrame(inner) {
  const body = pad4(inner);
  const size = body.length + 4;
  const out = new Uint8Array(4 + body.length + 4);
  out[0] = SOF;
  out[1] = size & 0xff;
  out[2] = (size >> 8) & 0xff;
  out[3] = crc8(out.subarray(1, 3));
  out.set(body, 4);
  new DataView(out.buffer).setUint32(4 + body.length, crc32(body), true);
  return out;
}

export function encodeCommand(seq, opcode, payload = [0x00]) {
  return buildFrame(Uint8Array.from([PacketType.COMMAND, seq & 0xff, opcode & 0xff, ...payload]));
}

export function parseFrame(raw) {
  if (raw.length < 8 || raw[0] !== SOF) return null;
  if (crc8(raw.subarray(1, 3)) !== raw[3]) return null;
  const size = raw[1] | (raw[2] << 8);
  if (size < 4 || raw.length !== 4 + size) return null;
  const body = raw.subarray(4, 4 + size - 4);
  const stored = new DataView(raw.buffer, raw.byteOffset).getUint32(4 + body.length, true);
  if (crc32(body) !== stored) return null;
  return { packetType: body[0], seq: body[1], inner: body };
}

/// Length-based reassembly of frames split across BLE notifications.
/// Never resync on 0xAA alone — sensor payloads contain it and notification
/// boundaries land on it.
export class FrameReassembler {
  constructor() {
    this.buf = [];
    this.dropped = 0;
  }

  feed(chunk) {
    for (const b of chunk) this.buf.push(b);
    const out = [];
    while (this.buf.length >= 4) {
      if (this.buf[0] !== SOF || crc8(this.buf.slice(1, 3)) !== this.buf[3]) {
        this.buf.shift();
        this.dropped++;
        continue;
      }
      const size = this.buf[1] | (this.buf[2] << 8);
      const total = 4 + size;
      if (size < 4 || total > 4096) {
        this.buf.shift();
        this.dropped++;
        continue;
      }
      if (this.buf.length < total) break;
      const frame = parseFrame(Uint8Array.from(this.buf.slice(0, total)));
      this.buf.splice(0, total);
      if (frame) out.push(frame);
      else this.dropped++;
    }
    if (this.buf.length > 8192) this.buf.length = 0;
    return out;
  }
}

// ── decoders ───────────────────────────────────────────────────────────────

const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);

export function decodeResponse(inner) {
  if (inner[0] !== PacketType.COMMAND_RESPONSE || inner.length < 5) return null;
  return {
    opcode: inner[2],
    echoedSeq: inner[3],
    status: inner[4],
    ok: inner[4] === 1,
    payload: inner.subarray(5),
  };
}

export function decodeBattery(payload) {
  return payload.length < 2 ? null : view(payload).getUint16(0, true) / 10;
}

export function decodeHello(payload) {
  if (payload.length < 15) return null;
  const strings = [];
  let current = '';
  for (const b of payload.subarray(14)) {
    if (b === 0) {
      if (current) strings.push(current);
      current = '';
    } else if (b >= 32 && b < 127) {
      current += String.fromCharCode(b);
    }
  }
  if (current) strings.push(current);
  return {
    batteryPct: view(payload).getUint16(1, true) / 10,
    deviceClock: view(payload).getUint32(6, true),
    serial: strings[0] ?? null,
    firmwareCommit: strings[1] && /^[0-9a-f]{16,}$/.test(strings[1]) ? strings[1] : null,
  };
}

/// Live 1 Hz record: ts@2 u32, hr@8 u8, rr count@9, intervals from @10, wear@18.
export function parseRealtimeHr(inner) {
  if (inner.length < 10) return null;
  const dv = view(inner);
  const rrMs = [];
  for (let k = 0; k < Math.min(inner[9], 4); k++) {
    const off = 10 + 2 * k;
    if (off + 2 > inner.length) break;
    const v = dv.getInt16(off, true);
    if (v >= 200 && v <= 2500) rrMs.push(v);
  }
  return {
    ts: dv.getUint32(2, true),
    hr: inner[8],
    rrMs,
    wearing: inner.length > 18 ? inner[18] === 1 : null,
  };
}

const EVENT_NAMES = {
  3: 'battery level',
  7: 'charging started',
  8: 'charging stopped',
  9: 'on wrist',
  10: 'off wrist',
  13: 'clock lost',
  14: 'double tap',
  15: 'boot',
  21: 'charger connected',
  22: 'charger removed',
  31: 'bonded',
};

export function decodeEvent(inner) {
  if (inner.length < 12) return null;
  const dv = view(inner);
  const id = dv.getUint16(2, true);
  return { id, name: EVENT_NAMES[id] ?? `event ${id}`, ts: dv.getUint32(4, true) };
}

// ── offline self-test ──────────────────────────────────────────────────────

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s) => Uint8Array.from(s.match(/../g).map((x) => parseInt(x, 16)));

/// Replays frames captured from a real WHOOP 4.0. Returns [{name, pass, detail}].
export function selfTest() {
  const results = [];
  const check = (name, pass, detail = '') => results.push({ name, pass, detail });

  // Command frames, byte-for-byte against sniffer captures.
  const built = [
    ['hello', 0x00, 0x23, [0x00], 'aa0800a823002300ada86a2d'],
    ['realtime HR on', 0x8c, 0x03, [0x01], 'aa0800a8238c03017d5ec627'],
    ['realtime HR off', 0x8d, 0x03, [0x00], 'aa0800a8238d0300dc040351'],
    ['padded payload', 0x6d, 0x42, [...unhex('01d036656600000000')], 'aa100057236d4201d036656600000000f62deb81'],
  ];
  for (const [name, seq, op, payload, want] of built) {
    const got = hex(encodeCommand(seq, op, payload));
    check(`build ${name}`, got === want, got === want ? '' : `got ${got}`);
  }

  // A real response frame, with the device serial replaced by a placeholder and
  // the CRC-32 recomputed — the byte layout every offset below depends on is
  // untouched, but no real hardware identifier is published.
  const helloFrame = parseFrame(unhex(
    'aa8c004a2400230001049e03000000eee7e201085500004558414d504c453031003865323738326237346634303238' +
    '3463336634373631386238393235393230396665396264396265383137343834656232313339633906000000020000' +
    '001000000029000000110000000600000000000000080600010000000000110000000200000002000000000000' +
    '0055109302'));
  check('parse hello frame', helloFrame !== null);
  if (helloFrame) {
    const h = decodeHello(decodeResponse(helloFrame.inner).payload);
    check('hello battery 92.6%', h.batteryPct === 92.6, `got ${h?.batteryPct}`);
    check('hello serial', h.serial === 'EXAMPLE01', `got ${h?.serial}`);
    check('hello clock', h.deviceClock === 31647726, `got ${h?.deviceClock}`);
  }

  const batteryFrame = parseFrame(unhex('aa10005724011a01019e0300000000001b835273'));
  check('parse battery frame', batteryFrame !== null);
  if (batteryFrame) {
    const r = decodeResponse(batteryFrame.inner);
    check('battery 92.6%', r.ok && decodeBattery(r.payload) === 92.6);
  }

  // Corruption must be rejected, not mis-decoded.
  check('reject bad CRC-32', parseFrame(unhex('aa0800a8238c03017d5ec628')) === null);
  check('reject bad CRC-8', parseFrame(unhex('aa0800a9238c03017d5ec627')) === null);

  // Reassembly across notification splits, with 0xAA inside the payload.
  const frame = encodeCommand(1, Cmd.LINK_VALID, [0xaa, 0xaa, 0x01]);
  const asm = new FrameReassembler();
  check('split frame buffers', asm.feed(frame.subarray(0, 5)).length === 0);
  const rejoined = asm.feed(new Uint8Array([...frame.subarray(5), ...frame]));
  check('rejoins and finds both', rejoined.length === 2 && asm.dropped === 0, `got ${rejoined.length}`);

  // Live record decode.
  const rt = new Uint8Array(20);
  rt[0] = PacketType.REALTIME_DATA;
  new DataView(rt.buffer).setUint32(2, 1790025550, true);
  rt[8] = 61;
  rt[9] = 2;
  new DataView(rt.buffer).setInt16(10, 1007, true);
  new DataView(rt.buffer).setInt16(12, 9999, true); // out of range, must be dropped
  rt[18] = 1;
  const live = parseRealtimeHr(parseFrame(buildFrame(rt)).inner);
  check('realtime HR', live.hr === 61 && live.rrMs.length === 1 && live.rrMs[0] === 1007 && live.wearing === true);

  check('allowlist blocks reboot', !ALLOWED_OPCODES.has(0x1d));
  check('allowlist blocks flash erase', !ALLOWED_OPCODES.has(0x19));
  return results;
}
