import 'dart:async';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/foundation.dart';
import 'package:vibration/vibration.dart';

/// ---------------------------------------------------------------------------
/// CallSounds — the call sound set, all bundled assets:
///
///  - incoming callback → a custom marimba ringtone LOOPING + a vibration
///    pattern, stopped on accept/decline/dismiss
///  - outgoing call     → a classic ringback tone LOOPING while it rings
///  - connected         → a short ascending chime, played once
///
/// Every call sound is fire-and-forget safe: a failed player never breaks the
/// call UI (some emulators ship without audio codecs).
/// ---------------------------------------------------------------------------
class CallSounds {
  CallSounds._();
  static final CallSounds instance = CallSounds._();

  AudioPlayer? _ring;
  AudioPlayer? _ringback;
  bool _vibrating = false;

  /// Incoming callback: loop the ringtone + vibrate until stopped.
  Future<void> startIncomingRing() async {
    await stopIncomingRing();
    try {
      final player = AudioPlayer();
      _ring = player;
      await player.setReleaseMode(ReleaseMode.loop);
      await player.play(AssetSource('audio/ringtone.wav'));
    } catch (e) {
      debugPrint('[sounds] ringtone unavailable: $e');
    }
    _vibrating = true;
    try {
      final has = await Vibration.hasVibrator();
      if (has == true) {
        // WhatsApp-like cadence: 600ms on / 500ms off, repeated.
        await Vibration.vibrate(pattern: const [600, 500, 600, 500, 600, 500, 600, 500, 600, 500, 600, 500, 600, 500, 600, 500, 600, 500, 600, 500, 600, 500, 600, 500]);
        _scheduleVibrationLoop();
      }
    } catch (e) {
      debugPrint('[sounds] vibration unavailable: $e');
    }
  }

  Timer? _vibTimer;
  void _scheduleVibrationLoop() {
    // The pattern list is finite; re-arm it until stopped.
    _vibTimer?.cancel();
    _vibTimer = Timer(const Duration(seconds: 14), () {
      if (!_vibrating) return;
      try {
        Vibration.vibrate(pattern: const [600, 500, 600, 500, 600, 500, 600, 500, 600, 500, 600, 500, 600, 500, 600, 500, 600, 500, 600, 500, 600, 500, 600, 500]);
        _scheduleVibrationLoop();
      } catch (_) {}
    });
  }

  Future<void> stopIncomingRing() async {
    _vibrating = false;
    _vibTimer?.cancel();
    try {
      await Vibration.cancel();
    } catch (_) {}
    try {
      await _ring?.stop();
      await _ring?.dispose();
    } catch (_) {}
    _ring = null;
  }

  /// Outgoing: loop the ringback while "Calling Myto…".
  Future<void> startRingback() async {
    await stopRingback();
    try {
      final player = AudioPlayer();
      _ringback = player;
      await player.setReleaseMode(ReleaseMode.loop);
      await player.play(AssetSource('audio/ringback.wav'));
    } catch (e) {
      debugPrint('[sounds] ringback unavailable: $e');
    }
  }

  Future<void> stopRingback() async {
    try {
      await _ringback?.stop();
      await _ringback?.dispose();
    } catch (_) {}
    _ringback = null;
  }

  /// Connected: a short ascending chime, once.
  Future<void> playConnectChime() async {
    try {
      final player = AudioPlayer();
      await player.play(AssetSource('audio/connect.wav'));
      player.onPlayerComplete.first.then((_) => player.dispose()).catchError((_) {});
    } catch (e) {
      debugPrint('[sounds] chime unavailable: $e');
    }
  }

  /// Stop everything (call ended / screen disposed).
  Future<void> stopAll() async {
    await stopIncomingRing();
    await stopRingback();
  }
}
