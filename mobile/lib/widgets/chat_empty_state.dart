import 'dart:math';

import 'package:flutter/material.dart';

import '../theme.dart';
import 'myto_mark.dart';

/// The blank-chat hero: just the Myto mark and a single, centered greeting. The greeting is
/// picked once (in [initState]) from a time-of-day pool so it stays put across rebuilds instead
/// of flickering, and varies run-to-run for a little life. No starter cards — a clean slate.
class ChatEmptyState extends StatefulWidget {
  const ChatEmptyState({super.key, this.firstName});

  final String? firstName;

  @override
  State<ChatEmptyState> createState() => _ChatEmptyStateState();
}

class _ChatEmptyStateState extends State<ChatEmptyState> {
  // Comma-then-name safe: every phrase reads fine as either "Phrase" or "Phrase, Name".
  static const Map<_DayPart, List<String>> _pool = {
    _DayPart.morning: ['Good morning', 'Morning', 'Rise and shine', 'Bright and early', 'Hello'],
    _DayPart.afternoon: ['Good afternoon', 'Afternoon', 'Hope the day\'s going well', 'Hello', 'Hey'],
    _DayPart.evening: ['Good evening', 'Evening', 'Winding down', 'Hello', 'Hey'],
    _DayPart.night: ['Working late', 'Burning the midnight oil', 'Late one tonight', 'Good evening', 'Hello'],
  };

  late final String _greeting = _pickGreeting(widget.firstName);

  static String _pickGreeting(String? name) {
    final hour = DateTime.now().hour;
    final part = hour < 5
        ? _DayPart.night
        : hour < 12
            ? _DayPart.morning
            : hour < 17
                ? _DayPart.afternoon
                : hour < 22
                    ? _DayPart.evening
                    : _DayPart.night;
    final options = _pool[part]!;
    final phrase = options[Random().nextInt(options.length)];
    return (name != null && name.isNotEmpty) ? '$phrase, $name' : phrase;
  }

  @override
  Widget build(BuildContext context) {
    final palette = Theme.of(context).palette;
    return Center(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(24, 24, 24, 24),
        child: TweenAnimationBuilder<double>(
          tween: Tween(begin: 0, end: 1),
          duration: const Duration(milliseconds: 420),
          curve: Curves.easeOutCubic,
          builder: (context, t, child) => Opacity(
            opacity: t.clamp(0.0, 1.0),
            child: Transform.translate(offset: Offset(0, (1 - t) * 12), child: child),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const MytoMarkAura(auraSize: 132, starSize: 56),
              const SizedBox(height: 20),
              Text(
                _greeting,
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: palette.text,
                  fontSize: 22,
                  fontWeight: FontWeight.w600,
                  letterSpacing: -0.3,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

enum _DayPart { morning, afternoon, evening, night }
