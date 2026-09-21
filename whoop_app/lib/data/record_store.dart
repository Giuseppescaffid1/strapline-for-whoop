import 'dart:convert';

import 'package:openstrap_protocol/openstrap_protocol.dart' show R24;
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:sqflite/sqflite.dart';

/// One second of strap data as persisted locally.
class Sample {
  final int ts; // unix seconds (strap clock)
  final int hr; // bpm, 0 = off-wrist
  final List<int> rrMs;
  final double? ax;
  final double? ay;
  final double? az;
  const Sample(this.ts, this.hr, this.rrMs, this.ax, this.ay, this.az);

  bool get hasAccel => ax != null && ay != null && az != null;
}

class RecordStore {
  Database? _db;

  Future<void> open() async {
    final dir = await getApplicationSupportDirectory();
    _db = await openDatabase(
      p.join(dir.path, 'whoop.db'),
      version: 1,
      onCreate: (db, _) => db.execute('''
        CREATE TABLE samples (
          ts INTEGER PRIMARY KEY,
          hr INTEGER NOT NULL,
          rr TEXT NOT NULL,
          ax REAL, ay REAL, az REAL,
          version INTEGER NOT NULL,
          counter INTEGER NOT NULL
        )
      '''),
    );
  }

  Database get _d => _db ?? (throw StateError('RecordStore.open() not called'));

  Future<void> insertAll(List<R24> records) async {
    if (records.isEmpty) return;
    final batch = _d.batch();
    for (final r in records) {
      final accel = r.accelG.length == 3 ? r.accelG : null;
      batch.insert(
        'samples',
        {
          'ts': r.tsEpoch,
          'hr': r.hr,
          'rr': jsonEncode(r.rrIntervalsMs),
          'ax': accel?[0],
          'ay': accel?[1],
          'az': accel?[2],
          'version': r.histVersion,
          'counter': r.counter,
        },
        conflictAlgorithm: ConflictAlgorithm.replace,
      );
    }
    await batch.commit(noResult: true);
  }

  Future<int> count() async =>
      Sqflite.firstIntValue(await _d.rawQuery('SELECT COUNT(*) FROM samples')) ?? 0;

  Future<int?> maxTs() async => Sqflite.firstIntValue(await _d.rawQuery('SELECT MAX(ts) FROM samples'));

  Future<List<Sample>> between(int fromTs, int toTs) async {
    final rows = await _d.query(
      'samples',
      where: 'ts >= ? AND ts < ?',
      whereArgs: [fromTs, toTs],
      orderBy: 'ts ASC',
    );
    return [
      for (final row in rows)
        Sample(
          row['ts'] as int,
          row['hr'] as int,
          (jsonDecode(row['rr'] as String) as List<dynamic>).cast<int>(),
          row['ax'] as double?,
          row['ay'] as double?,
          row['az'] as double?,
        ),
    ];
  }
}
