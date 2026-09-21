import 'package:flutter/material.dart';

import '../app_state.dart';
import '../ble/whoop_band.dart';
import '../compute/summaries.dart';

class HomePage extends StatelessWidget {
  final AppState state;
  const HomePage(this.state, {super.key});

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: state,
      builder: (context, _) {
        final band = state.band;
        final connected = band.isConnected;
        return Scaffold(
          appBar: AppBar(
            title: const Text('WHOOP companion'),
            actions: [
              Padding(
                padding: const EdgeInsets.only(right: 12),
                child: Center(child: Text(_phaseLabel(band.phase))),
              ),
            ],
          ),
          body: ListView(
            padding: const EdgeInsets.all(16),
            children: [
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  FilledButton.icon(
                    onPressed: state.busy != null ? null : (connected ? state.disconnect : state.connect),
                    icon: Icon(connected ? Icons.bluetooth_disabled : Icons.bluetooth_searching),
                    label: Text(connected ? 'Disconnect' : 'Connect'),
                  ),
                  OutlinedButton.icon(
                    onPressed: connected && state.busy == null ? state.toggleLive : null,
                    icon: Icon(state.liveOn ? Icons.stop : Icons.favorite),
                    label: Text(state.liveOn ? 'Stop live HR' : 'Live HR'),
                  ),
                  OutlinedButton.icon(
                    onPressed: connected && state.busy == null && !state.liveOn ? state.sync : null,
                    icon: const Icon(Icons.sync),
                    label: const Text('Sync history'),
                  ),
                ],
              ),
              if (state.busy != null) ...[
                const SizedBox(height: 12),
                Row(children: [
                  const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)),
                  const SizedBox(width: 12),
                  Text(state.busy!),
                  if (band.phase == BandPhase.syncing)
                    Text('  ${band.syncRecords} records / ${band.syncBatches} batches'),
                ]),
              ],
              const SizedBox(height: 16),
              _LiveCard(state),
              const SizedBox(height: 12),
              _SleepCard(state.lastNight),
              const SizedBox(height: 12),
              _RecoveryCard(state.lastNight),
              const SizedBox(height: 12),
              _StrainCard(state.today),
              const SizedBox(height: 16),
              Text('${state.storedSamples} seconds of data stored locally',
                  style: Theme.of(context).textTheme.bodySmall),
              const SizedBox(height: 8),
              _LogPanel(state.log),
            ],
          ),
        );
      },
    );
  }

  String _phaseLabel(BandPhase p) => switch (p) {
        BandPhase.idle => 'Not connected',
        BandPhase.scanning => 'Scanning',
        BandPhase.connecting => 'Connecting',
        BandPhase.ready => 'Connected',
        BandPhase.syncing => 'Syncing',
        BandPhase.disconnected => 'Disconnected',
      };
}

class _LiveCard extends StatelessWidget {
  final AppState state;
  const _LiveCard(this.state);

  @override
  Widget build(BuildContext context) {
    final hr = state.liveHr;
    final band = state.band;
    return _Card(
      title: 'Strap',
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(hr == null ? '—' : '${hr.bpm}', style: Theme.of(context).textTheme.displayMedium),
                Text(hr == null
                    ? (state.liveOn ? 'waiting for the strap…' : 'live heart rate off')
                    : 'bpm · RR ${hr.rrMs.isEmpty ? '—' : hr.rrMs.join('/')} ms · ${hr.wearing ? 'on wrist' : 'off wrist'}'),
              ],
            ),
          ),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(band.batteryPct == null ? 'battery —' : 'battery ${band.batteryPct!.toStringAsFixed(0)}%'),
              Text(band.hello?.serial == null ? '' : 'serial ${band.hello!.serial}'),
            ],
          ),
        ],
      ),
    );
  }
}

class _SleepCard extends StatelessWidget {
  final NightSummary? night;
  const _SleepCard(this.night);

  @override
  Widget build(BuildContext context) {
    final n = night;
    if (n == null || !n.hasSleep) {
      return _Card(title: 'Sleep', child: Text(n == null ? 'No data yet — sync the strap.' : _notes(n)));
    }
    String h(int? sec) => sec == null ? '—' : '${sec ~/ 3600}h ${(sec % 3600) ~/ 60}m';
    return _Card(
      title: 'Sleep',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(h(n.tstSec), style: Theme.of(context).textTheme.headlineMedium),
          Text('${_clock(n.onset)} → ${_clock(n.offset)} · in bed ${h(n.inBedSec)} · '
              'efficiency ${n.efficiencyPct?.toStringAsFixed(0) ?? '—'}%'),
          const SizedBox(height: 8),
          Text('light ${h(n.lightSec)} · deep ${h(n.deepSec)} · REM ${h(n.remSec)} · awake ${h(n.wakeSec)}'),
          if (n.notes.isNotEmpty) Text(_notes(n), style: Theme.of(context).textTheme.bodySmall),
        ],
      ),
    );
  }
}

class _RecoveryCard extends StatelessWidget {
  final NightSummary? night;
  const _RecoveryCard(this.night);

  @override
  Widget build(BuildContext context) {
    final n = night;
    return _Card(
      title: 'Recovery',
      child: Row(
        children: [
          _Stat('HRV (RMSSD)', n?.rmssd == null ? '—' : '${n!.rmssd!.toStringAsFixed(0)} ms'),
          _Stat('Resting HR', n?.rhr == null ? '—' : '${n!.rhr!.toStringAsFixed(0)} bpm'),
          _Stat('Resp. rate', n?.respRate == null ? '—' : '${n!.respRate!.toStringAsFixed(1)} /min'),
          _Stat('Readiness', n?.readinessBand ?? '—'),
        ],
      ),
    );
  }
}

class _StrainCard extends StatelessWidget {
  final DayStrain? day;
  const _StrainCard(this.day);

  @override
  Widget build(BuildContext context) {
    final d = day;
    return _Card(
      title: 'Strain',
      child: Row(
        children: [
          _Stat('Strain (TRIMP)', d?.strain == null ? '—' : d!.strain!.toStringAsFixed(1)),
          _Stat('Worn today', d == null ? '—' : '${d.wornMinutes ~/ 60}h ${d.wornMinutes % 60}m'),
          _Stat('Confidence', d == null ? '—' : '${(d.confidence * 100).round()}% · ${d.tier}'),
        ],
      ),
    );
  }
}

class _LogPanel extends StatelessWidget {
  final List<String> lines;
  const _LogPanel(this.lines);

  @override
  Widget build(BuildContext context) {
    final tail = lines.length > 10 ? lines.sublist(lines.length - 10) : lines;
    return _Card(
      title: 'Log',
      child: Text(tail.isEmpty ? '—' : tail.join('\n'),
          style: Theme.of(context).textTheme.bodySmall?.copyWith(fontFamily: 'monospace')),
    );
  }
}

class _Card extends StatelessWidget {
  final String title;
  final Widget child;
  const _Card({required this.title, required this.child});

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 8),
            child,
          ],
        ),
      ),
    );
  }
}

class _Stat extends StatelessWidget {
  final String label;
  final String value;
  const _Stat(this.label, this.value);

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(value, style: Theme.of(context).textTheme.titleLarge),
          Text(label, style: Theme.of(context).textTheme.bodySmall),
        ],
      ),
    );
  }
}

String _clock(DateTime? t) => t == null ? '—' : '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';

String _notes(NightSummary n) => n.notes.isEmpty ? 'Not enough data for a night.' : n.notes.join(' · ');
