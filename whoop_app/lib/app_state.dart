import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:openstrap_protocol/openstrap_protocol.dart' show R24;

import 'ble/whoop_band.dart';
import 'compute/night_metrics.dart';
import 'compute/summaries.dart';
import 'data/record_store.dart';

class AppState extends ChangeNotifier {
  final band = WhoopBand();
  final store = RecordStore();
  final log = <String>[];

  LiveHr? liveHr;
  bool liveOn = false;
  String? busy;
  int storedSamples = 0;
  NightSummary? lastNight;
  DayStrain? today;

  final _buffer = <R24>[];
  Timer? _flushTimer;

  AppState() {
    band.logs.listen(addLog);
    band.phases.listen((_) => notifyListeners());
    band.events.listen((e) => addLog('event ${e.name}'));
    band.liveHr.listen((s) {
      liveHr = s;
      notifyListeners();
    });
    band.records.listen(_onRecord);
  }

  Future<void> init() async {
    await store.open();
    storedSamples = await store.count();
    await recompute();
  }

  void addLog(String msg) {
    log.add('${DateTime.now().toIso8601String().substring(11, 19)}  $msg');
    if (log.length > 200) log.removeAt(0);
    notifyListeners();
  }

  Future<void> connect() => _run('Scanning…', () async {
        final device = await band.scan();
        if (device == null) {
          addLog('No WHOOP found. The strap can only hold one connection — free it up on your phone and retry.');
          return;
        }
        busy = 'Connecting…';
        notifyListeners();
        await band.connect(device);
        final hello = await band.fetchHello();
        final battery = await band.fetchBattery();
        addLog('Connected: serial ${hello.serial ?? '?'}, battery ${battery?.toStringAsFixed(1) ?? '?'}%');
        final clock = await band.readClock();
        final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
        if (clock == null || (clock - now).abs() > 60) {
          addLog('Strap clock is off by ${clock == null ? '?' : (now - clock)}s — setting it');
          await band.setClock();
        }
      });

  Future<void> disconnect() => _run('Disconnecting…', () async {
        if (liveOn) {
          try {
            await band.setLiveHr(false);
          } catch (_) {}
          liveOn = false;
        }
        await band.disconnect();
        liveHr = null;
      });

  Future<void> toggleLive() => _run(liveOn ? 'Stopping live HR…' : 'Starting live HR…', () async {
        await band.setLiveHr(!liveOn);
        liveOn = !liveOn;
        if (!liveOn) liveHr = null;
      });

  Future<void> sync() => _run('Syncing history…', () async {
        final result = await band.syncHistory();
        await _flush();
        addLog('Sync: ${result.records} records in ${result.batches} batches, '
            '${result.complete ? 'complete' : 'stopped on idle'}');
        await recompute();
      });

  Future<void> recompute() async {
    final end = await store.maxTs();
    if (end == null) {
      lastNight = null;
      today = null;
      notifyListeners();
      return;
    }
    final samples = await store.between(end - 36 * 3600, end + 1);
    lastNight = computeLastNight(samples, tzOffsetSec: DateTime.now().timeZoneOffset.inSeconds);
    final wakeTs = lastNight?.offset?.millisecondsSinceEpoch;
    today = computeDayStrain(samples, restingHr: lastNight?.rhr, sinceTs: wakeTs == null ? null : wakeTs ~/ 1000);
    notifyListeners();
  }

  void _onRecord(R24 r) {
    _buffer.add(r);
    _flushTimer ??= Timer(const Duration(seconds: 2), _flush);
  }

  Future<void> _flush() async {
    _flushTimer?.cancel();
    _flushTimer = null;
    if (_buffer.isEmpty) return;
    final pending = List<R24>.of(_buffer);
    _buffer.clear();
    await store.insertAll(pending);
    storedSamples = await store.count();
    notifyListeners();
  }

  Future<void> _run(String label, Future<void> Function() body) async {
    if (busy != null) return;
    busy = label;
    notifyListeners();
    try {
      await body();
    } catch (e) {
      addLog('$label failed: $e');
    } finally {
      busy = null;
      notifyListeners();
    }
  }
}
