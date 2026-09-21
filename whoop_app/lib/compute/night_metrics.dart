import 'dart:math' as math;

import 'package:openstrap_analytics/onehz.dart';

import '../data/record_store.dart';
import 'summaries.dart';

/// Sleep, nocturnal RHR, HRV and respiration for the most recent night found
/// in [samples] (1 Hz rows, ascending by time). Every metric comes from
/// openstrap_analytics; absent inputs surface as notes, never as numbers.
NightSummary computeLastNight(
  List<Sample> samples, {
  required int tzOffsetSec,
  List<double> priorNightsLnRmssd = const [],
}) {
  if (samples.length < 3600) {
    return NightSummary(notes: ['Need at least an hour of data (have ${samples.length ~/ 60} min).']);
  }

  final accel = <AccelSample>[];
  final hr = <double>[];
  for (final s in samples) {
    final ms = s.ts * 1000.0;
    accel.add(s.hasAccel ? AccelSample(ms, s.ax!, s.ay!, s.az!) : AccelSample(ms, 0, 0, 0, valid: false));
    hr.add(s.hr.toDouble());
  }
  final (rrMs, rrTsMs) = _rrStream(samples);

  final seg = segmentSleep(accel, hr, rrMs: rrMs, rrTsMs: rrTsMs, tzOffsetSec: tzOffsetSec);
  final window = seg.window;
  if (window == null || seg.tstSec == null) {
    return const NightSummary(notes: ['No sleep period detected in the stored data.']);
  }

  final onsetIdx = math.max(0, math.min(window.onsetIdx, samples.length - 1));
  final offsetIdx = math.max(onsetIdx + 1, math.min(window.offsetIdx, samples.length));
  final night = samples.sublist(onsetIdx, offsetIdx);
  final onsetMs = window.onsetMs ?? samples[onsetIdx].ts * 1000.0;
  final offsetMs = window.offsetMs ?? samples[offsetIdx - 1].ts * 1000.0;
  final notes = <String>[];

  final rhr = nocturnalRhr(
    [for (final s in night) s.hr.toDouble()],
    tsSec: [for (final s in night) s.ts.toDouble()],
  );
  _noteIfAbsent(notes, 'resting HR', rhr);

  final (nightRr, nightRrTs) = _rrStream(night);
  double? rmssd;
  double? respRate;
  Metric<ReadinessLnRmssd>? readiness;
  if (nightRr.length < 30) {
    notes.add('Too few beat intervals during sleep for HRV (${nightRr.length}).');
  } else {
    final corrected = correctRr(nightRr, rrTsMs: nightRrTs);
    final artifactFraction = (1 - corrected.cleanFraction).clamp(0.0, 1.0).toDouble();
    final rmssdM = nocturnalRmssd(corrected.nn, corrected.nnTimesMs);
    _noteIfAbsent(notes, 'HRV', rmssdM);
    rmssd = rmssdM.value;
    final resp = rsaRespRate(corrected.nn, corrected.nnTimesMs, artifactFraction: artifactFraction);
    _noteIfAbsent(notes, 'respiratory rate', resp);
    respRate = resp.value?.brpm;
    if (rmssd != null && rmssd > 0) {
      readiness = readinessLnRmssd([...priorNightsLnRmssd, math.log(rmssd)]);
      _noteIfAbsent(notes, 'readiness', readiness);
    }
  }

  return NightSummary(
    onset: DateTime.fromMillisecondsSinceEpoch(onsetMs.round()),
    offset: DateTime.fromMillisecondsSinceEpoch(offsetMs.round()),
    inBedSec: seg.inBedSec,
    tstSec: seg.tstSec,
    lightSec: seg.lightSec,
    deepSec: seg.deepSec,
    remSec: seg.remSec,
    wakeSec: seg.wakeSec,
    efficiencyPct: seg.efficiencyPct,
    rhr: rhr.value?.low30Mean,
    rmssd: rmssd,
    respRate: respRate,
    readinessBand: readiness?.value?.band,
    readinessZ: readiness?.value?.z,
    notes: notes,
  );
}

/// Banister TRIMP-based strain over the waking samples after [sinceTs]
/// (normally the last sleep offset), or over everything when null.
DayStrain computeDayStrain(List<Sample> samples, {double? restingHr, int? sinceTs}) {
  final day = sinceTs == null ? samples : samples.where((s) => s.ts >= sinceTs).toList();
  final worn = day.where((s) => s.hr > 0).toList();
  if (worn.length < 600) {
    return DayStrain(confidence: 0, tier: Tier.estimate, note: 'Need at least 10 worn minutes.', wornMinutes: worn.length ~/ 60);
  }
  final m = trimpStrain(
    [for (final s in worn) s.hr.toDouble()],
    [for (final s in worn) s.ts.toDouble()],
    restingHr: restingHr,
  );
  return DayStrain(
    strain: m.value,
    confidence: m.confidence,
    tier: m.tier,
    note: m.note,
    wornMinutes: worn.length ~/ 60,
  );
}

/// Beat intervals with whole-second epoch-ms timestamps, as the record stores them.
(List<double>, List<double>) _rrStream(List<Sample> samples) {
  final rr = <double>[];
  final ts = <double>[];
  for (final s in samples) {
    for (final v in s.rrMs) {
      rr.add(v.toDouble());
      ts.add(s.ts * 1000.0);
    }
  }
  return (rr, ts);
}

void _noteIfAbsent(List<String> notes, String label, Metric<Object?> m) {
  if (m.value == null) notes.add('$label unavailable${m.note == null ? '' : ' (${m.note})'}');
}
