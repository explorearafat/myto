import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../services/call/call_service.dart';
import '../services/call/call_sounds.dart';
import '../theme.dart';
import '../widgets/myto_mark.dart';

/// ---------------------------------------------------------------------------
/// CallScreen — the native-style calling experience.
///
/// States: calling (rings ~5–7s while the desktop answers for real) →
/// connecting → active (timer, voice-activity glow, 3×2 control grid) →
/// ended/failed. The More menu carries voice settings, audio output,
/// connection info (RTT + direct/relay) and the live log.
/// ---------------------------------------------------------------------------
class CallScreen extends StatefulWidget {
  const CallScreen({super.key});

  @override
  State<CallScreen> createState() => _CallScreenState();
}

class _CallScreenState extends State<CallScreen> with TickerProviderStateMixin {
  // Guards the one-shot auto-dial: without it, "Done" on the ended screen
  // → dismiss() → phase idle → postFrameCallback → startCall() again — a
  // phantom call ringing the desktop after the user already hung up.
  bool _autoStartDone = false;
  // Sound transitions: ringback loops while calling/connecting, the connect
  // chime plays once on active, everything stops on terminal states.
  CallPhase? _lastPhase;

  late final AnimationController _ring = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1800),
  )..repeat();

  late final AnimationController _pulse = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1200),
  )..repeat(reverse: true);

  @override
  void dispose() {
    _ring.dispose();
    _pulse.dispose();
    CallSounds.instance.stopAll();
    super.dispose();
  }

  void _syncSounds(CallPhase phase) {
    if (_lastPhase == phase) return;
    final wasActive = _lastPhase == CallPhase.active;
    _lastPhase = phase;
    switch (phase) {
      case CallPhase.calling:
      case CallPhase.connecting:
      case CallPhase.reconnecting:
        CallSounds.instance.startRingback();
        break;
      case CallPhase.active:
        CallSounds.instance.stopRingback();
        if (!wasActive) CallSounds.instance.playConnectChime();
        break;
      case CallPhase.incoming:
        break; // the incoming screen owns its own ringtone
      case CallPhase.ended:
      case CallPhase.failed:
      case CallPhase.declined:
      case CallPhase.idle:
        CallSounds.instance.stopAll();
        break;
    }
  }

  @override
  Widget build(BuildContext context) {
    final service = context.watch<CallService>();
    final palette = context.palette;
    _syncSounds(service.phase);

    // Kick the call off once, on first entry.
    if (service.phase == CallPhase.idle && !_autoStartDone) {
      _autoStartDone = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (context.mounted) service.startCall();
      });
    }

    return PopScope(
      // Back during a live call asks to hang up instead of silently leaving.
      canPop: service.phase == CallPhase.ended ||
          service.phase == CallPhase.failed ||
          service.phase == CallPhase.idle,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop) return;
        _confirmHangup(context, service);
      },
      child: Scaffold(
        backgroundColor: palette.bg,
        body: SafeArea(
          child: AnimatedSwitcher(
            duration: const Duration(milliseconds: 300),
            child: switch (service.phase) {
              CallPhase.calling => _CallingView(
                  key: const ValueKey('calling'),
                  ring: _ring,
                  status: service.statusText,
                  onCancel: () => service.cancelCalling(),
                ),
              CallPhase.connecting || CallPhase.reconnecting => _CallingView(
                  key: const ValueKey('connecting'),
                  ring: _ring,
                  status: service.statusText,
                  showRipples: false,
                  onCancel: service.phase == CallPhase.reconnecting
                      ? () => service.hangup()
                      : () => service.hangup(),
                ),
              CallPhase.active => _ActiveCallView(
                  key: const ValueKey('active'),
                  pulse: _pulse,
                  service: service,
                ),
              CallPhase.incoming => _EndedView(
                  key: const ValueKey('incoming'),
                  icon: Icons.call_received_rounded,
                  title: 'Incoming call',
                  detail: service.statusText,
                  actionLabel: 'Answer',
                  onAction: () => service.acceptIncoming(),
                ),
              CallPhase.failed => _EndedView(
                  key: const ValueKey('failed'),
                  icon: Icons.call_missed_rounded,
                  title: 'Call failed',
                  detail: service.failReason.isEmpty ? 'Myto could not be reached.' : service.failReason,
                  actionLabel: 'Try again',
                  onAction: () => service.startCall(),
                ),
                CallPhase.declined => _EndedView(
                  key: const ValueKey('declined'),
                  icon: Icons.call_missed_outgoing_rounded,
                  title: 'Declined',
                  detail: 'The callback was declined. Myto will try again shortly.',
                  actionLabel: 'Done',
                  onAction: () => service.dismiss(),
                ),
              CallPhase.ended => _EndedView(
                  key: const ValueKey('ended'),
                  icon: Icons.call_end_rounded,
                  title: 'Call ended',
                  detail: service.statusText,
                  actionLabel: 'Done',
                  onAction: () {
                    service.dismiss();
                    if (context.mounted) Navigator.of(context).pop();
                  },
                ),
              CallPhase.idle => _EndedView(
                  key: const ValueKey('idle'),
                  icon: Icons.call_rounded,
                  title: 'Calling Myto',
                  detail: 'Starting the call…',
                  actionLabel: 'Cancel',
                  onAction: () => service.cancelCalling(),
                ),
            },
          ),
        ),
      ),
    );
  }

  Future<void> _confirmHangup(BuildContext context, CallService service) async {
    final palette = context.palette;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: palette.surface,
        title: const Text('End the call?'),
        content: Text(
          service.taskInProgress
              ? 'Myto will keep working on your task and call you back when it finishes.'
              : 'This hangs up on both devices.',
          style: TextStyle(fontSize: 13.5, color: palette.muted),
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: Text('Keep talking', style: TextStyle(color: palette.accentText)),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: TeamlyColors.danger),
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('End call'),
          ),
        ],
      ),
    );
    if (confirmed == true) await service.hangup();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Calling / connecting: avatar + ripples + status
// ─────────────────────────────────────────────────────────────────────────────

class _CallingView extends StatelessWidget {
  const _CallingView({
    super.key,
    required this.ring,
    required this.status,
    required this.onCancel,
    this.showRipples = true,
  });

  final Animation<double> ring;
  final String status;
  final VoidCallback onCancel;
  final bool showRipples;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return Column(
      key: super.key,
      children: <Widget>[
        const Spacer(flex: 2),
        // Realistic ringing: expanding ripples behind the avatar.
        SizedBox(
          width: 220,
          height: 220,
          child: Stack(
            alignment: Alignment.center,
            children: <Widget>[
              if (showRipples)
                for (final delay in <double>[0.0, 0.33, 0.66])
                  AnimatedBuilder(
                    animation: ring,
                    builder: (context, _) {
                      final t = (ring.value + delay) % 1.0;
                      return Container(
                        width: 96 + t * 110,
                        height: 96 + t * 110,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          border: Border.all(
                            color: TeamlyColors.green500.withAlpha((255 * (1 - t) * 0.35).round()),
                            width: 2,
                          ),
                        ),
                      );
                    },
                  ),
              const MytoMark(size: 96),
            ],
          ),
        ),
        const SizedBox(height: TeamlySpace.s6),
        const Text('Myto', style: TextStyle(fontSize: 26, fontWeight: FontWeight.w800)),
        const SizedBox(height: 6),
        Text(status, style: TextStyle(fontSize: 14.5, color: palette.muted)),
        const Spacer(flex: 3),
        _RoundControl(
          icon: Icons.call_end_rounded,
          fill: TeamlyColors.danger,
          size: 68,
          onTap: () {
            HapticFeedback.mediumImpact();
            onCancel();
          },
        ),
        const SizedBox(height: TeamlySpace.s8),
      ],
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Active call: timer, voice activity, controls
// ─────────────────────────────────────────────────────────────────────────────

class _ActiveCallView extends StatelessWidget {
  const _ActiveCallView({super.key, required this.pulse, required this.service});
  final Animation<double> pulse;
  final CallService service;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final d = service.duration;
    final hh = d.inHours.toString().padLeft(2, '0');
    final mm = (d.inMinutes % 60).toString().padLeft(2, '0');
    final ss = (d.inSeconds % 60).toString().padLeft(2, '0');

    return Column(
      key: super.key,
      children: <Widget>[
        const Spacer(flex: 1),
        // Voice-activity glow behind the avatar while Myto speaks.
        AnimatedBuilder(
          animation: pulse,
          builder: (context, child) {
            final speaking = service.desktopSpeaking;
            final glow = speaking ? 0.35 + pulse.value * 0.4 : 0.0;
            return Container(
              width: 148,
              height: 148,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                boxShadow: <BoxShadow>[
                  if (glow > 0)
                    BoxShadow(
                      color: TeamlyColors.green500.withAlpha((255 * glow).round()),
                      blurRadius: 48 + pulse.value * 18,
                      spreadRadius: 2,
                    ),
                ],
              ),
              child: child,
            );
          },
          child: const Center(child: MytoMark(size: 92)),
        ),
        const SizedBox(height: TeamlySpace.s4),
        Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: <Widget>[
            const Text('Myto', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
            const SizedBox(width: 8),
            Icon(Icons.verified_rounded, size: 17, color: TeamlyColors.green500),
          ],
        ),
        const SizedBox(height: 4),
        Text(
          service.hold
              ? 'On hold'
              : service.muted
                  ? 'Muted · ${_stateLine(service)}'
                  : _stateLine(service),
          style: TextStyle(fontSize: 13.5, color: palette.muted),
        ),
        const SizedBox(height: 6),
        Text(
          '$hh:$mm:$ss',
          style: TextStyle(
            fontSize: 15,
            fontWeight: FontWeight.w600,
            fontFeatures: const <FontFeature>[FontFeature.tabularFigures()],
            color: palette.text,
          ),
        ),
        const Spacer(flex: 1),
        // Approval / question cards appear right above the controls.
        if (service.approval != null)
          _ApprovalCard(approval: service.approval!, service: service)
        else if (service.question != null)
          _QuestionCard(question: service.question!, service: service),
        // 3×2 native control grid.
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: TeamlySpace.s6),
          child: Column(
            children: <Widget>[
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                children: <Widget>[
                  _GridControl(
                    icon: Icons.mic_off_rounded,
                    label: 'Mute',
                    active: service.muted,
                    onTap: () {
                      HapticFeedback.selectionClick();
                      service.toggleMute();
                    },
                  ),
                  _GridControl(
                    icon: Icons.dialpad_rounded,
                    label: 'Keypad',
                    onTap: () {
                      HapticFeedback.selectionClick();
                      _showKeypad(context, service);
                    },
                  ),
                  _GridControl(
                    icon: Icons.volume_up_rounded,
                    label: 'Speaker',
                    active: service.speaker,
                    onTap: () {
                      HapticFeedback.selectionClick();
                      service.toggleSpeaker();
                    },
                  ),
                ],
              ),
              const SizedBox(height: TeamlySpace.s4),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                children: <Widget>[
                  _GridControl(
                    icon: Icons.pause_rounded,
                    label: 'Hold',
                    active: service.hold,
                    onTap: () {
                      HapticFeedback.selectionClick();
                      service.toggleHold();
                    },
                  ),
                  _RoundControl(
                    icon: Icons.call_end_rounded,
                    fill: TeamlyColors.danger,
                    size: 68,
                    onTap: () {
                      HapticFeedback.mediumImpact();
                      service.hangup();
                    },
                  ),
                  _GridControl(
                    icon: Icons.more_horiz_rounded,
                    label: 'More',
                    onTap: () {
                      HapticFeedback.selectionClick();
                      _showMoreMenu(context, service);
                    },
                  ),
                ],
              ),
            ],
          ),
        ),
        const SizedBox(height: TeamlySpace.s8),
      ],
    );
  }

  String _stateLine(CallService service) {
    if (service.desktopSpeaking) return 'Myto is speaking…';
    if (service.userSpeaking) return 'Listening…';
    return service.rttMs > 0 ? 'Connected · ${service.rttMs}ms' : 'Connected';
  }
}

String _titleCase(String s) {
  if (s.isEmpty) return s;
  return s[0].toUpperCase() + s.substring(1);
}

class _ApprovalCard extends StatelessWidget {
  const _ApprovalCard({required this.approval, required this.service});
  final CallApproval approval;
  final CallService service;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 0, 16, 12),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: palette.surface,
        borderRadius: BorderRadius.circular(TeamlyRadius.sm),
        border: Border.all(color: Colors.orange.withAlpha(120)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Icon(Icons.admin_panel_settings_outlined, size: 16, color: Colors.orange),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  'Permission · ${_titleCase(approval.tool)}',
                  style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700),
                ),
              ),
            ],
          ),
          if (approval.detail.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                approval.detail,
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 12, color: palette.muted),
              ),
            ),
          const SizedBox(height: 10),
          Row(
            children: <Widget>[
              Expanded(
                child: OutlinedButton(
                  onPressed: () {
                    HapticFeedback.selectionClick();
                    service.answerApproval(approval.id, 'deny');
                  },
                  child: const Text('Deny'),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: FilledButton(
                  style: FilledButton.styleFrom(backgroundColor: TeamlyColors.green500),
                  onPressed: () {
                    HapticFeedback.selectionClick();
                    service.answerApproval(approval.id, 'allow');
                  },
                  child: const Text('Allow'),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _QuestionCard extends StatelessWidget {
  const _QuestionCard({required this.question, required this.service});
  final ({String id, String title, List<String> options}) question;
  final CallService service;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 0, 16, 12),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: palette.surface,
        borderRadius: BorderRadius.circular(TeamlyRadius.sm),
        border: Border.all(color: palette.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(question.title, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700)),
          const SizedBox(height: 10),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: <Widget>[
              for (final option in question.options)
                ActionChip(
                  label: Text(option, style: const TextStyle(fontSize: 12)),
                  onPressed: () {
                    HapticFeedback.selectionClick();
                    service.answerQuestion(question.id, option);
                  },
                ),
            ],
          ),
        ],
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Controls & sheets
// ─────────────────────────────────────────────────────────────────────────────

class _GridControl extends StatelessWidget {
  const _GridControl({
    required this.icon,
    required this.label,
    required this.onTap,
    this.active = false,
  });
  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final bool active;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Container(
            width: 62,
            height: 62,
            decoration: BoxDecoration(
              color: active ? palette.text : palette.surface2,
              shape: BoxShape.circle,
              border: Border.all(color: palette.border),
            ),
            child: Icon(icon, size: 25, color: active ? palette.surface : palette.text),
          ),
          const SizedBox(height: 7),
          Text(
            label,
            style: TextStyle(
              fontSize: 11.5,
              fontWeight: FontWeight.w600,
              color: palette.muted,
            ),
          ),
        ],
      ),
    );
  }
}

class _RoundControl extends StatelessWidget {
  const _RoundControl({
    required this.icon,
    required this.onTap,
    this.fill,
    this.size = 62,
  });
  final IconData icon;
  final VoidCallback onTap;
  final Color? fill;
  final double size;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: size,
        height: size,
        decoration: BoxDecoration(
          color: fill ?? palette.surface2,
          shape: BoxShape.circle,
          border: fill == null ? Border.all(color: palette.border) : null,
        ),
        child: Icon(icon, size: size * 0.42, color: fill != null ? Colors.white : palette.text),
      ),
    );
  }
}

Future<void> _showKeypad(BuildContext context, CallService service) async {
  final palette = context.palette;
  final buffer = StringBuffer();
  await showModalBottomSheet<void>(
    context: context,
    backgroundColor: palette.bg,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(TeamlyRadius.lg)),
    ),
    builder: (ctx) {
      return StatefulBuilder(
        builder: (ctx, setSheet) {
          return SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(TeamlySpace.s5),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  Container(
                    height: 44,
                    alignment: Alignment.center,
                    child: Text(
                      buffer.isEmpty ? 'Send digits to Myto' : buffer.toString(),
                      style: TextStyle(
                        fontSize: 20,
                        fontWeight: FontWeight.w700,
                        fontFeatures: const <FontFeature>[FontFeature.tabularFigures()],
                        color: buffer.isEmpty ? palette.muted : palette.text,
                      ),
                    ),
                  ),
                  const SizedBox(height: TeamlySpace.s3),
                  for (final row in <List<String>>[
                    <String>['1', '2', '3'],
                    <String>['4', '5', '6'],
                    <String>['7', '8', '9'],
                    <String>['*', '0', '#'],
                  ])
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                      children: <Widget>[
                        for (final digit in row)
                          GestureDetector(
                            onTap: () {
                              HapticFeedback.selectionClick();
                              setSheet(() => buffer.write(digit));
                            },
                            child: Container(
                              width: 66,
                              height: 58,
                              alignment: Alignment.center,
                              decoration: BoxDecoration(
                                color: palette.surface,
                                shape: BoxShape.circle,
                                border: Border.all(color: palette.border),
                              ),
                              child: Text(
                                digit,
                                style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w600),
                              ),
                            ),
                          ),
                      ],
                    ),
                  const SizedBox(height: TeamlySpace.s4),
                  Row(
                    children: <Widget>[
                      Expanded(
                        child: OutlinedButton(
                          onPressed: () {
                            final text = buffer.toString();
                            if (text.isNotEmpty) {
                              HapticFeedback.selectionClick();
                              setSheet(() {
                                buffer
                                  ..clear()
                                  ..write(text.substring(0, text.length - 1));
                              });
                            }
                          },
                          child: const Text('Delete'),
                        ),
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        flex: 2,
                        child: FilledButton(
                          style: FilledButton.styleFrom(backgroundColor: TeamlyColors.green500),
                          onPressed: buffer.isEmpty
                              ? null
                              : () {
                                  HapticFeedback.mediumImpact();
                                  service.sendKeypad(buffer.toString());
                                  Navigator.of(ctx).pop();
                                },
                          child: const Text('Send'),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          );
        },
      );
    },
  );
}

Future<void> _showMoreMenu(BuildContext context, CallService service) async {
  final palette = context.palette;
  double rate = _rateFromService(service);
  await showModalBottomSheet<void>(
    context: context,
    backgroundColor: palette.bg,
    isScrollControlled: true,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(TeamlyRadius.lg)),
    ),
    builder: (ctx) {
      return SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(TeamlySpace.s5),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              // Connection info.
              Text('Connection',
                  style: TextStyle(fontSize: 13, fontWeight: FontWeight.w800, color: palette.text)),
              const SizedBox(height: 8),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(
                  color: palette.surface,
                  borderRadius: BorderRadius.circular(TeamlyRadius.sm),
                  border: Border.all(color: palette.border),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    _kv('Latency', service.rttMs > 0 ? '${service.rttMs} ms' : 'measuring…', palette),
                    _kv('Path', _qualityLabel(service.quality), palette),
                    _kv('Desktop', service.desktop?.deviceName ?? '—', palette),
                    _kv('Audio', 'WebRTC · en-IN-NeerjaNeural', palette),
                  ],
                ),
              ),
              const SizedBox(height: TeamlySpace.s5),
              // Voice settings.
              Text('Voice speed',
                  style: TextStyle(fontSize: 13, fontWeight: FontWeight.w800, color: palette.text)),
              StatefulBuilder(
                builder: (ctx, setSheet) {
                  return Row(
                    children: <Widget>[
                      Expanded(
                        child: Slider(
                          value: rate,
                          min: -30,
                          max: 30,
                          divisions: 12,
                          label: '${rate.round() > 0 ? '+' : ''}${rate.round()}%',
                          onChanged: (v) {
                            setSheet(() => rate = v);
                            final r = v.round();
                            service.setVoiceRate(r == 0 ? 'default' : '${r > 0 ? '+' : ''}$r%');
                          },
                        ),
                      ),
                      SizedBox(
                        width: 56,
                        child: Text(
                          '${rate.round() > 0 ? '+' : ''}${rate.round()}%',
                          textAlign: TextAlign.end,
                          style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 13),
                        ),
                      ),
                    ],
                  );
                },
              ),
              const SizedBox(height: TeamlySpace.s3),
              // Call log (live command/output stream from the desktop).
              Text('Call log',
                  style: TextStyle(fontSize: 13, fontWeight: FontWeight.w800, color: palette.text)),
              const SizedBox(height: 8),
              Container(
                width: double.infinity,
                constraints: const BoxConstraints(maxHeight: 220),
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: palette.surface,
                  borderRadius: BorderRadius.circular(TeamlyRadius.sm),
                  border: Border.all(color: palette.border),
                ),
                child: service.logs.isEmpty
                    ? Text('Commands and their output will stream here.',
                        style: TextStyle(fontSize: 12, color: palette.muted))
                    : ListView.builder(
                        shrinkWrap: true,
                        itemCount: service.logs.length,
                        itemBuilder: (ctx, i) {
                          final line = service.logs[i];
                          return Padding(
                            padding: const EdgeInsets.symmetric(vertical: 1.5),
                            child: Text(
                              line.text,
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                fontSize: 11,
                                fontFamily: 'monospace',
                                color: line.stream == 'err' ? TeamlyColors.danger : palette.muted,
                              ),
                            ),
                          );
                        },
                      ),
              ),
              const SizedBox(height: TeamlySpace.s4),
            ],
          ),
        ),
      );
    },
  );
}

double _rateFromService(CallService service) => 0; // rate lives on the desktop; slider starts neutral

String _qualityLabel(String q) => switch (q) {
      'direct' => 'Direct peer-to-peer',
      'relay' => 'Via TURN relay',
      _ => 'Negotiating…',
    };

Widget _kv(String k, String v, MytoPalette palette) {
  return Padding(
    padding: const EdgeInsets.symmetric(vertical: 2),
    child: Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: <Widget>[
        Text(k, style: TextStyle(fontSize: 12.5, color: palette.muted)),
        Flexible(
          child: Text(
            v,
            textAlign: TextAlign.end,
            style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600),
          ),
        ),
      ],
    ),
  );
}

class _EndedView extends StatelessWidget {
  const _EndedView({
    super.key,
    required this.icon,
    required this.title,
    required this.detail,
    required this.actionLabel,
    required this.onAction,
  });
  final IconData icon;
  final String title;
  final String detail;
  final String actionLabel;
  final VoidCallback onAction;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return Column(
      key: super.key,
      mainAxisAlignment: MainAxisAlignment.center,
      children: <Widget>[
        Container(
          width: 96,
          height: 96,
          decoration: BoxDecoration(
            color: palette.surface2,
            shape: BoxShape.circle,
            border: Border.all(color: palette.border),
          ),
          child: Icon(icon, size: 40, color: palette.muted),
        ),
        const SizedBox(height: TeamlySpace.s5),
        Text(title, style: const TextStyle(fontSize: 21, fontWeight: FontWeight.w800)),
        const SizedBox(height: 8),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 32),
          child: Text(
            detail,
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 13.5, color: palette.muted),
          ),
        ),
        const SizedBox(height: TeamlySpace.s6),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 40),
          child: SizedBox(
            width: double.infinity,
            child: FilledButton(
              style: FilledButton.styleFrom(
                backgroundColor: TeamlyColors.green500,
                padding: const EdgeInsets.symmetric(vertical: 14),
              ),
              onPressed: onAction,
              child: Text(actionLabel),
            ),
          ),
        ),
      ],
    );
  }
}
