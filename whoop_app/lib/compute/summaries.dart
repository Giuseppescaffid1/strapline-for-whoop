/// What the app shows for one night. Every field is nullable: absent input
/// means absent output, never a placeholder number.
class NightSummary {
  final DateTime? onset;
  final DateTime? offset;
  final int? inBedSec;
  final int? tstSec;
  final int? lightSec;
  final int? deepSec;
  final int? remSec;
  final int? wakeSec;
  final double? efficiencyPct;
  final double? rhr;
  final double? rmssd;
  final double? respRate;
  final String? readinessBand; // 'suppressed' | 'normal' | 'elevated'
  final double? readinessZ;
  final List<String> notes;

  const NightSummary({
    this.onset,
    this.offset,
    this.inBedSec,
    this.tstSec,
    this.lightSec,
    this.deepSec,
    this.remSec,
    this.wakeSec,
    this.efficiencyPct,
    this.rhr,
    this.rmssd,
    this.respRate,
    this.readinessBand,
    this.readinessZ,
    this.notes = const [],
  });

  bool get hasSleep => tstSec != null;
}

class DayStrain {
  final double? strain;
  final double confidence;
  final String tier;
  final String? note;
  final int wornMinutes;
  const DayStrain({this.strain, required this.confidence, required this.tier, this.note, required this.wornMinutes});
}
