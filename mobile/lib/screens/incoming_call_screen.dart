import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../services/call/call_service.dart';
import '../services/call/call_sounds.dart';
import '../theme.dart';
import '../widgets/myto_mark.dart';

/// ---------------------------------------------------------------------------
/// IncomingCallScreen — the WhatsApp-style full-screen ring for a callback
/// from Myto. Shown as an overlay by HomeShell whenever the service reports an
/// incoming call (foreground) or the FCM full-screen intent deep-links in.
/// A custom marimba ringtone loops with a vibration pattern for as long as
/// this screen is up; accept/decline pops it and the sound stops with it.
/// ---------------------------------------------------------------------------
class IncomingCallScreen extends StatefulWidget {
  const IncomingCallScreen({super.key});

  @override
  State<IncomingCallScreen> createState() => _IncomingCallScreenState();
}

class _IncomingCallScreenState extends State<IncomingCallScreen> {
  @override
  void initState() {
    super.initState();
    CallSounds.instance.startIncomingRing();
  }

  @override
  void dispose() {
    CallSounds.instance.stopIncomingRing();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final service = context.watch<CallService>();
    final palette = context.palette;
    final summary = service.statusText;

    return Scaffold(
      backgroundColor: palette.bg,
      body: SafeArea(
        child: Column(
          children: <Widget>[
            const Spacer(flex: 2),
            const _RingingAvatar(),
            const SizedBox(height: TeamlySpace.s6),
            const Text('Myto', style: TextStyle(fontSize: 27, fontWeight: FontWeight.w800)),
            const SizedBox(height: 6),
            Text(
              'Myto · Desktop call',
              style: TextStyle(fontSize: 13.5, color: palette.muted),
            ),
            if (summary.isNotEmpty) ...<Widget>[
              const SizedBox(height: 14),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 36),
                child: Text(
                  summary,
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 13.5, color: palette.text, height: 1.4),
                ),
              ),
            ],
            const Spacer(flex: 3),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceEvenly,
              children: <Widget>[
                _CallAction(
                  icon: Icons.call_end_rounded,
                  label: 'Decline',
                  color: TeamlyColors.danger,
                  onTap: () {
                    HapticFeedback.mediumImpact();
                    service.declineIncoming();
                  },
                ),
                _CallAction(
                  icon: Icons.call_rounded,
                  label: 'Answer',
                  color: TeamlyColors.green500,
                  onTap: () {
                    HapticFeedback.mediumImpact();
                    service.acceptIncoming();
                  },
                ),
              ],
            ),
            const SizedBox(height: TeamlySpace.s8),
          ],
        ),
      ),
    );
  }
}

/// Pulsing halo behind the avatar while it rings.
class _RingingAvatar extends StatefulWidget {
  const _RingingAvatar();

  @override
  State<_RingingAvatar> createState() => _RingingAvatarState();
}

class _RingingAvatarState extends State<_RingingAvatar> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1600),
  )..repeat();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 220,
      height: 220,
      child: Stack(
        alignment: Alignment.center,
        children: <Widget>[
          for (final delay in <double>[0.0, 0.5])
            AnimatedBuilder(
              animation: _c,
              builder: (context, _) {
                final t = (_c.value + delay) % 1.0;
                return Container(
                  width: 104 + t * 104,
                  height: 104 + t * 104,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    border: Border.all(
                      color: TeamlyColors.green500.withAlpha((255 * (1 - t) * 0.4).round()),
                      width: 2,
                    ),
                  ),
                );
              },
            ),
          const MytoMark(size: 100),
        ],
      ),
    );
  }
}

class _CallAction extends StatelessWidget {
  const _CallAction({
    required this.icon,
    required this.label,
    required this.color,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final Color color;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        GestureDetector(
          onTap: onTap,
          child: Container(
            width: 74,
            height: 74,
            decoration: BoxDecoration(color: color, shape: BoxShape.circle),
            child: Icon(icon, size: 34, color: Colors.white),
          ),
        ),
        const SizedBox(height: 8),
        Text(
          label,
          style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
        ),
      ],
    );
  }
}
