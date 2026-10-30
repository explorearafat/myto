import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../services/call/call_service.dart';
import '../theme.dart';
import '../widgets/myto_mark.dart';
import 'call_screen.dart';

/// ---------------------------------------------------------------------------
/// CallTab — the "Call" home: is the desktop reachable, one big Call button,
/// and the callback/call history. Tapping Call opens the native-style call
/// screen, which runs the whole lifecycle (calling → active → ended).
/// ---------------------------------------------------------------------------
class CallTab extends StatelessWidget {
  const CallTab({super.key});

  @override
  Widget build(BuildContext context) {
    final service = context.watch<CallService>();
    final palette = context.palette;
    final uid = FirebaseAuth.instance.currentUser?.uid;

    return Scaffold(
      backgroundColor: palette.bg,
      appBar: AppBar(
        title: const Text('Call'),
        backgroundColor: palette.bg,
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
          children: <Widget>[
            _DesktopCard(service: service),
            const SizedBox(height: TeamlySpace.s5),
            _CallButton(service: service),
            const SizedBox(height: TeamlySpace.s8),
            if (uid != null) const _HistorySection(),
          ],
        ),
      ),
    );
  }
}

class _DesktopCard extends StatelessWidget {
  const _DesktopCard({required this.service});
  final CallService service;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final d = service.desktop;

    Color dot;
    String label;
    String detail;
    if (d == null) {
      dot = palette.muted;
      label = 'No desktop paired';
      detail = 'Sign your PC into the Myto desktop app with this same account.';
    } else if (!d.online || !d.isFresh) {
      dot = TeamlyColors.danger;
      label = 'Myto is offline';
      detail = 'Open the Myto desktop app on your PC to bring it online.';
    } else if (!d.callEnabled) {
      dot = Colors.orange;
      label = 'Calling disabled';
      detail = 'Turn on Voice calls in the desktop app: Settings › Calls.';
    } else if (d.busy) {
      dot = Colors.orange;
      label = 'Myto is busy';
      detail = d.deviceName;
    } else {
      dot = TeamlyColors.green500;
      label = 'Myto is ready';
      detail = d.deviceName;
    }

    return Container(
      padding: const EdgeInsets.all(TeamlySpace.cardPad),
      decoration: BoxDecoration(
        color: palette.surface,
        borderRadius: BorderRadius.circular(TeamlyRadius.md),
        border: Border.all(color: palette.border),
      ),
      child: Row(
        children: <Widget>[
          Stack(
            alignment: Alignment.bottomRight,
            children: <Widget>[
              const MytoMark(size: 44),
              Container(
                width: 13,
                height: 13,
                decoration: BoxDecoration(
                  color: dot,
                  shape: BoxShape.circle,
                  border: Border.all(color: palette.surface, width: 2.5),
                ),
              ),
            ],
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(label,
                    style: const TextStyle(fontSize: 15.5, fontWeight: FontWeight.w700)),
                const SizedBox(height: 3),
                Text(
                  detail,
                  style: TextStyle(fontSize: 12.5, color: palette.muted),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _CallButton extends StatelessWidget {
  const _CallButton({required this.service});
  final CallService service;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final onCall = service.phase == CallPhase.calling ||
        service.phase == CallPhase.connecting ||
        service.phase == CallPhase.active ||
        service.phase == CallPhase.reconnecting;
    final ready = service.desktop?.reachable == true;

    return Center(
      child: Column(
        children: <Widget>[
          GestureDetector(
            onTap: () {
              HapticFeedback.mediumImpact();
              if (!onCall) {
                Navigator.of(context).push(
                  MaterialPageRoute<void>(builder: (_) => const CallScreen()),
                );
              }
            },
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 220),
              width: 96,
              height: 96,
              decoration: BoxDecoration(
                color: onCall || ready ? TeamlyColors.green500 : palette.chip,
                shape: BoxShape.circle,
                boxShadow: <BoxShadow>[
                  if (ready || onCall)
                    BoxShadow(
                      color: TeamlyColors.green500.withAlpha(64),
                      blurRadius: 26,
                      offset: const Offset(0, 10),
                    ),
                ],
              ),
              child: Icon(
                Icons.call_rounded,
                size: 42,
                color: onCall || ready ? Colors.white : palette.muted,
              ),
            ),
          ),
          const SizedBox(height: 10),
          Text(
            onCall ? 'On the call' : 'Tap to call Myto',
            style: TextStyle(fontSize: 12.5, color: palette.muted),
          ),
        ],
      ),
    );
  }
}

class _HistorySection extends StatelessWidget {
  const _HistorySection();

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final uid = FirebaseAuth.instance.currentUser!.uid;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text('Recent calls',
            style: TextStyle(
                fontSize: 13, fontWeight: FontWeight.w700, color: palette.text)),
        const SizedBox(height: 10),
        StreamBuilder<QuerySnapshot<Map<String, dynamic>>>(
          stream: FirebaseFirestore.instance
              .collection('users')
              .doc(uid)
              .collection('calls')
              .orderBy('ts', descending: true)
              .limit(15)
              .snapshots(),
          builder: (context, snap) {
            if (!snap.hasData) {
              return const Padding(
                padding: EdgeInsets.all(12),
                child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
              );
            }
            final docs = snap.data!.docs;
            if (docs.isEmpty) {
              return Container(
                width: double.infinity,
                padding: const EdgeInsets.all(TeamlySpace.cardPad),
                decoration: BoxDecoration(
                  color: palette.surface,
                  borderRadius: BorderRadius.circular(TeamlyRadius.md),
                  border: Border.all(color: palette.border),
                ),
                child: Text(
                  'No calls yet. Your call history and task callbacks will show up here.',
                  style: TextStyle(fontSize: 12.5, color: palette.muted),
                ),
              );
            }
            return Column(
              children: <Widget>[
                for (final doc in docs) _HistoryTile(id: doc.id, data: doc.data()),
              ],
            );
          },
        ),
      ],
    );
  }
}

class _HistoryTile extends StatelessWidget {
  const _HistoryTile({required this.id, required this.data});
  final String id;
  final Map<String, dynamic> data;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final entry = CallHistoryEntry(id: id, data: data);
    final outgoing = entry.dir == 'm2d';
    final icon = <String, IconData>{
      'missed': Icons.call_missed_rounded,
      'declined': Icons.call_missed_rounded,
      'timeout': Icons.call_missed_outgoing_rounded,
      'error': Icons.call_missed_outgoing_rounded,
      'busy': Icons.call_missed_rounded,
      'hangup': outgoing ? Icons.call_made_rounded : Icons.call_received_rounded,
      'completed': Icons.call_received_rounded,
    }[entry.outcome] ??
        (outgoing ? Icons.call_made_rounded : Icons.call_received_rounded);
    final failed = <String>['missed', 'declined', 'timeout', 'error', 'busy'].contains(entry.outcome);
    final at = entry.at;
    final when = '${at.day}/${at.month} '
        '${at.hour.toString().padLeft(2, '0')}:${at.minute.toString().padLeft(2, '0')}';

    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: palette.surface,
        borderRadius: BorderRadius.circular(TeamlyRadius.sm),
        border: Border.all(color: palette.border),
      ),
      child: Row(
        children: <Widget>[
          Icon(icon, size: 19, color: failed ? TeamlyColors.danger : TeamlyColors.greenText),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  entry.summary.isNotEmpty
                      ? entry.summary
                      : (outgoing ? 'Called Myto' : 'Myto called you'),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600),
                ),
                const SizedBox(height: 2),
                Text(
                  '${entry.state}${entry.outcome.isEmpty ? '' : ' · ${entry.outcome}'} · $when',
                  style: TextStyle(fontSize: 11.5, color: palette.muted),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
