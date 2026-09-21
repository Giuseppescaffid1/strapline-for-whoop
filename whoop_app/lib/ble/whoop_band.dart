import 'dart:async';
import 'dart:typed_data';

import 'package:flutter_blue_plus/flutter_blue_plus.dart';
import 'package:openstrap_protocol/openstrap_protocol.dart';

enum BandPhase { idle, scanning, connecting, ready, syncing, disconnected }

class LiveHr {
  final DateTime at;
  final int bpm;
  final List<int> rrMs;
  final bool wearing;
  const LiveHr(this.at, this.bpm, this.rrMs, this.wearing);
}

class SyncResult {
  final int records;
  final int batches;
  final bool complete;
  const SyncResult(this.records, this.batches, this.complete);
}

/// One BLE session with a WHOOP 4.0: framing, request/response matching,
/// live heart rate and the historical flash drain.
class WhoopBand {
  static const _gatt = GattProfile.gen4;
  static const _writeTimeout = Duration(seconds: 8);

  BluetoothDevice? _device;
  BluetoothCharacteristic? _cmdTo;
  final _subs = <StreamSubscription<dynamic>>[];
  final _asm = <String, FrameReassembler>{};
  final _pending = <int, Completer<Uint8List>>{};

  // Live commands use the high range; batch ACKs continue after INIT's 0..4.
  int _liveSeq = 0xA0;
  int _syncSeq = 5;

  final _phases = StreamController<BandPhase>.broadcast();
  final _liveHr = StreamController<LiveHr>.broadcast();
  final _records = StreamController<R24>.broadcast();
  final _events = StreamController<EventInfo>.broadcast();
  final _logs = StreamController<String>.broadcast();

  BandPhase phase = BandPhase.idle;
  HelloInfo? hello;
  double? batteryPct;
  int syncRecords = 0;
  int syncBatches = 0;
  bool syncComplete = false;
  DateTime _lastSyncActivity = DateTime.now();
  Completer<void>? _syncDone;

  Stream<BandPhase> get phases => _phases.stream;
  Stream<LiveHr> get liveHr => _liveHr.stream;
  Stream<R24> get records => _records.stream;
  Stream<EventInfo> get events => _events.stream;
  Stream<String> get logs => _logs.stream;
  bool get isConnected => _device != null && phase != BandPhase.idle && phase != BandPhase.disconnected;

  // ── connection ───────────────────────────────────────────────────────────

  Future<BluetoothDevice?> scan({Duration timeout = const Duration(seconds: 12)}) async {
    _setPhase(BandPhase.scanning);
    BluetoothDevice? found;
    final sub = FlutterBluePlus.onScanResults.listen((results) {
      for (final r in results) {
        final name = r.device.platformName.toLowerCase();
        final advertised = r.advertisementData.serviceUuids.map((g) => g.str128.toLowerCase());
        final isWhoop = name.startsWith('whoop') || advertised.any((s) => s.startsWith(_gatt.servicePrefix));
        if (found == null && isWhoop) {
          found = r.device;
          _log('found ${r.device.platformName} (${r.device.remoteId.str}) rssi ${r.rssi}');
          unawaited(FlutterBluePlus.stopScan());
        }
      }
    });
    try {
      await FlutterBluePlus.startScan(withServices: [Guid(_gatt.service)], timeout: timeout);
      await FlutterBluePlus.isScanning.where((on) => !on).first;
    } finally {
      await sub.cancel();
    }
    if (found == null) _setPhase(BandPhase.idle);
    return found;
  }

  Future<void> connect(BluetoothDevice device) async {
    _setPhase(BandPhase.connecting);
    _device = device;
    await device.connect(timeout: const Duration(seconds: 20));
    final services = await device.discoverServices();

    BluetoothCharacteristic? find(String uuid) {
      for (final s in services) {
        for (final c in s.characteristics) {
          if (c.uuid.str128.toLowerCase() == uuid) return c;
        }
      }
      return null;
    }

    final cmdTo = find(_gatt.cmdTo);
    if (cmdTo == null) throw StateError('WHOOP command characteristic not found');
    _cmdTo = cmdTo;
    for (final uuid in [_gatt.cmdFrom, _gatt.events, _gatt.data]) {
      final c = find(uuid);
      if (c == null) {
        _log('missing characteristic ${uuid.substring(0, 8)}');
        continue;
      }
      _asm[uuid] = FrameReassembler();
      await c.setNotifyValue(true);
      _subs.add(c.onValueReceived.listen((v) => _onChunk(uuid, v)));
    }
    _subs.add(device.connectionState.listen((s) {
      if (s == BluetoothConnectionState.disconnected) {
        _failPending('disconnected');
        _syncDone?.complete();
        _setPhase(BandPhase.disconnected);
      }
    }));
    _log('connected, mtu ${device.mtuNow}');
    _setPhase(BandPhase.ready);
  }

  Future<void> disconnect() async {
    for (final s in _subs) {
      await s.cancel();
    }
    _subs.clear();
    _asm.clear();
    _failPending('disconnecting');
    try {
      await _device?.disconnect();
    } catch (e) {
      _log('disconnect: $e');
    }
    _device = null;
    _cmdTo = null;
    _setPhase(BandPhase.idle);
  }

  // ── commands ─────────────────────────────────────────────────────────────

  /// Sends a command frame and returns the inner bytes of its 0x24 response.
  Future<Uint8List> send(int opcode, [List<int> payload = const [0x00]]) {
    final seq = _nextLiveSeq();
    return _writeAwait(buildCommand(seq, opcode, payload), seq);
  }

  Future<HelloInfo> fetchHello() async {
    final inner = await send(Cmd.getHelloHarvard, const [0x00]);
    hello = parseHello(Uint8List.sublistView(inner, 3));
    return hello!;
  }

  Future<double?> fetchBattery() async {
    final inner = await send(Cmd.getBatteryLevel, const []);
    batteryPct = inner.length >= 7 ? _u16(inner, 5) / 10 : null;
    return batteryPct;
  }

  /// Strap RTC in unix seconds, or null when the reply is malformed.
  Future<int?> readClock() async {
    final inner = await send(Cmd.getClock, const []);
    return inner.length >= 9 ? _u32(inner, 5) : null;
  }

  Future<bool> setClock() async {
    final seq = _nextLiveSeq();
    final inner = await _writeAwait(cmdSetClock(seq), seq);
    if (inner.length < 5 || inner[4] != 1) return false;
    final back = await readClock();
    final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    final ok = back != null && (back - now).abs() <= 5;
    _log(ok ? 'clock set ($back)' : 'clock did not latch (read back $back)');
    return ok;
  }

  /// Proprietary 1 Hz live HR on the data characteristic (0x28 frames).
  Future<void> setLiveHr(bool on) => send(Cmd.toggleRealtimeHr, [on ? 1 : 0]);

  /// Wakes the dormant SIG Heart Rate service (0x180D) for generic BLE apps.
  Future<void> setStandardHrProfile(bool on) => send(Cmd.setGenericHrProfile, [on ? 1 : 0]);

  // ── historical drain ─────────────────────────────────────────────────────

  Future<SyncResult> syncHistory({
    Duration idle = const Duration(seconds: 8),
    Duration maxDuration = const Duration(minutes: 15),
  }) async {
    final cmdTo = _cmdTo;
    if (cmdTo == null) throw StateError('not connected');
    _setPhase(BandPhase.syncing);
    syncRecords = 0;
    syncBatches = 0;
    syncComplete = false;
    _syncSeq = 5;
    _syncDone = Completer<void>();
    final start = DateTime.now();
    _lastSyncActivity = start;

    // INIT is sent one packet at a time; seq 4 (SEND_HISTORICAL_DATA) starts the flood.
    for (final pkt in initPackets) {
      await _rawWrite(pkt);
      await Future<void>.delayed(const Duration(milliseconds: 120));
    }

    while (!syncComplete && phase == BandPhase.syncing) {
      await Future.any<void>([_syncDone!.future, Future<void>.delayed(const Duration(seconds: 1))]);
      if (syncComplete) break;
      final now = DateTime.now();
      if (now.difference(_lastSyncActivity) > idle || now.difference(start) > maxDuration) {
        _log('sync idle — sending ABORT_HISTORICAL_TRANSMITS');
        try {
          await send(Cmd.abortHistoricalTransmits);
        } catch (e) {
          _log('abort failed: $e');
        }
        break;
      }
    }
    _syncDone = null;
    if (phase == BandPhase.syncing) _setPhase(BandPhase.ready);
    return SyncResult(syncRecords, syncBatches, syncComplete);
  }

  // ── inbound ──────────────────────────────────────────────────────────────

  void _onChunk(String uuid, List<int> chunk) {
    final asm = _asm[uuid];
    if (asm == null) return;
    for (final f in asm.feed(chunk)) {
      if (!f.decodable) continue;
      switch (f.packetType) {
        case PacketType.commandResponse:
          _onResponse(f);
        case PacketType.historicalData:
          final r = parseR24(f.inner);
          if (r != null) {
            syncRecords++;
            _lastSyncActivity = DateTime.now();
            _records.add(r);
          }
        case PacketType.metadata:
          _onMetadata(f);
        case PacketType.realtimeData:
          final hr = parseRealtimeHr(f.inner);
          if (hr != null) _liveHr.add(LiveHr(DateTime.now(), hr.hrBpm, hr.rrMs, hr.wearing));
        case PacketType.event:
          final e = parseEvent(f.inner);
          if (e != null) _events.add(e);
        default:
          break;
      }
    }
  }

  void _onResponse(Frame f) {
    final inner = f.inner;
    if (inner.length < 5) return;
    if (inner[2] == Cmd.getHelloHarvard) {
      hello = parseHello(Uint8List.sublistView(inner, 3));
    }
    final echoedSeq = inner[3];
    Completer<Uint8List>? c = _pending.remove(echoedSeq);
    if (c == null && _pending.length == 1) c = _pending.remove(_pending.keys.first);
    if (c != null && !c.isCompleted) c.complete(inner);
  }

  void _onMetadata(Frame f) {
    final m = parseMetadata(f.inner);
    if (m == null) return;
    if (m.sub == SyncMeta.historyEnd && m.token != null) {
      syncBatches++;
      _lastSyncActivity = DateTime.now();
      final ack = buildBatchAck(_syncSeq, m.token!);
      _syncSeq = _syncSeq >= 0x9F ? 5 : _syncSeq + 1;
      unawaited(_rawWrite(ack).catchError((Object e) => _log('batch ack failed: $e')));
    } else if (m.sub == SyncMeta.historyComplete) {
      syncComplete = true;
      _syncDone?.complete();
    }
  }

  // ── plumbing ─────────────────────────────────────────────────────────────

  int _nextLiveSeq() {
    final seq = _liveSeq;
    _liveSeq = _liveSeq >= 0xFF ? 0xA0 : _liveSeq + 1;
    return seq;
  }

  Future<void> _rawWrite(Uint8List frame) async {
    final cmdTo = _cmdTo;
    if (cmdTo == null) throw StateError('not connected');
    await cmdTo.write(frame, withoutResponse: false, allowLongWrite: true).timeout(_writeTimeout);
  }

  Future<Uint8List> _writeAwait(Uint8List frame, int seq) async {
    final c = Completer<Uint8List>();
    _pending[seq] = c;
    try {
      await _rawWrite(frame);
      return await c.future.timeout(const Duration(seconds: 5));
    } on TimeoutException {
      _pending.remove(seq);
      throw TimeoutException('no response to command 0x${frame[6].toRadixString(16)} (seq $seq)');
    }
  }

  void _failPending(String why) {
    for (final c in _pending.values) {
      if (!c.isCompleted) c.completeError(StateError(why));
    }
    _pending.clear();
  }

  void _setPhase(BandPhase p) {
    phase = p;
    _phases.add(p);
  }

  void _log(String msg) => _logs.add(msg);

  static int _u16(Uint8List b, int o) => b[o] | (b[o + 1] << 8);
  static int _u32(Uint8List b, int o) => _u16(b, o) | (_u16(b, o + 2) << 16);
}
