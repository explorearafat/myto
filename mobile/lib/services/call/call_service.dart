import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_tts/flutter_tts.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:speech_to_text/speech_to_text.dart' as stt;

/// ---------------------------------------------------------------------------
/// CallService — the phone side of a Myto Remote voice call.
///
/// Architecture (mirrors the desktop's main/call modules):
///  - Presence: `users/{uid}/config/desktop` says whether the PC is online /
///    busy / has calling enabled, and carries the TURN config to use.
///  - Signaling: `users/{uid}/calls/{callId}` (lifecycle) + a `signals`
///    subcollection (offer/answer/ICE). Firestore rules keep both strictly
///    owner-only, so "pairing" is the shared account itself.
///  - Media: WebRTC — the phone OFFERS for outgoing calls (caller offers) and
///    ANSWERS on callback calls; audio is a real WebRTC track, control messages
///    (STT text, barge-in, mute/hold, pings) ride the data channel as JSON.
///  - STT: the phone's on-device recognizer (streaming partials) — text goes to
///    the desktop, which runs the agent and streams Neerja's voice back.
/// ---------------------------------------------------------------------------
/// Phases of the state machine the UI renders.
enum CallPhase {
  idle,
  calling, // outgoing: ringing, desktop hasn't accepted yet
  connecting, // accepted; WebRTC negotiation in flight
  active, // peer connected; two-way voice live
  reconnecting, // ICE dropped; restarting
  incoming, // callback ringing on this phone
  ended, // finished (someone hung up)
  failed, // couldn't connect (offline / timeout / negotiation error)
  declined, // user declined a callback
}

/// A read of the desktop's presence document.
@immutable
class DesktopInfo {
  const DesktopInfo({
    required this.online,
    required this.busy,
    required this.callEnabled,
    required this.deviceName,
    required this.lastSeen,
  });

  final bool online;
  final bool busy;
  final bool callEnabled;
  final String deviceName;
  final int lastSeen;

  /// Freshness window — the desktop heartbeats every 15s.
  bool get isFresh => DateTime.now().millisecondsSinceEpoch - lastSeen < 45000;
  bool get reachable => online && isFresh && callEnabled;
}

/// One transcript line shown in the call UI.
@immutable
class TranscriptLine {
  const TranscriptLine({required this.role, required this.text});
  final String role; // 'user' | 'myto'
  final String text;
}

/// One log/status line shown in the call's connection info + log view.
@immutable
class CallLogLine {
  const CallLogLine({required this.stream, required this.text, required this.at});
  final String stream; // 'out' | 'err' | 'info' | 'status'
  final String text;
  final DateTime at;
}

/// A pending permission request from the desktop (voice-call approval flow).
@immutable
class CallApproval {
  const CallApproval({required this.id, required this.title, required this.detail, required this.tool});
  final String id;
  final String title;
  final String detail;
  final String tool;
}

class CallService extends ChangeNotifier {
  CallService._();
  static final CallService instance = CallService._();

  // ── State ────────────────────────────────────────────────────────────────
  CallPhase _phase = CallPhase.idle;
  CallPhase get phase => _phase;

  String? _callId;
  String? get callId => _callId;

  DesktopInfo? _desktop;
  DesktopInfo? get desktop => _desktop;

  bool _muted = false;
  bool get muted => _muted;
  bool _hold = false;
  bool get hold => _hold;
  bool _speaker = false;
  bool get speaker => _speaker;

  Duration _duration = Duration.zero;
  Duration get duration => _duration;
  int _rttMs = 0;
  int get rttMs => _rttMs;
  String _quality = 'unknown'; // 'direct' | 'relay' | 'unknown'
  String get quality => _quality;

  String _statusText = '';
  String get statusText => _statusText;

  final List<TranscriptLine> _transcript = <TranscriptLine>[];
  List<TranscriptLine> get transcript => List.unmodifiable(_transcript);
  final List<CallLogLine> _logs = <CallLogLine>[];
  List<CallLogLine> get logs => List.unmodifiable(_logs);

  CallApproval? _approval;
  CallApproval? get approval => _approval;
  ({String id, String title, List<String> options})? _question;
  ({String id, String title, List<String> options})? get question => _question;

  bool _desktopSpeaking = false;
  bool get desktopSpeaking => _desktopSpeaking;
  bool _userSpeaking = false;
  bool get userSpeaking => _userSpeaking;
  bool _taskInProgress = false;
  bool get taskInProgress => _taskInProgress;

  String _failReason = '';
  String get failReason => _failReason;

  // ── Peers & plumbing ─────────────────────────────────────────────────────
  RTCPeerConnection? _pc;
  MediaStream? _mic;
  RTCDataChannel? _dc;
  final stt.SpeechToText _stt = stt.SpeechToText();
  bool _sttAvailable = false;
  bool _sttWanted = false;
  final FlutterTts _fallbackTts = FlutterTts();
  int _mobileSeq = 0;
  /// Signal documents already processed — Firestore re-delivers the whole
  /// subcollection as `added` after a listener reconnect, so every signal id
  /// must be applied exactly once.
  final Set<String> _seenSignals = <String>{};
  StreamSubscription<QuerySnapshot<Map<String, dynamic>>>? _signalSub;
  StreamSubscription<QuerySnapshot<Map<String, dynamic>>>? _callsSub;
  StreamSubscription<DocumentSnapshot<Map<String, dynamic>>>? _presenceSub;
  /// Watches OUR OWN call document for desktop-written terminal states (the
  /// desktop declines a busy call by writing `declined` — without this listener
  /// the phone would ring uselessly for the whole 35s window).
  StreamSubscription<DocumentSnapshot<Map<String, dynamic>>>? _callDocSub;
  Timer? _ringTimer;
  Timer? _negotiateTimer;
  Timer? _durationTimer;
  Timer? _pingTimer;
  Timer? _reconnectTimer;
  Timer? _listenRestartTimer;
  bool _everConnected = false;
  bool _incomingShown = false;
  bool _autoCallPending = false;
  bool _sttBlockedLogged = false;
  bool get autoCallPending => _autoCallPending;

  /// A `myto://call` deep link arrived (QR scan from the desktop) — start the
  /// call as soon as a screen can show it. Consumed by HomeShell, which pushes
  /// the CallScreen and clears the flag; pending survives sign-in.
  void requestAutoCall() {
    _autoCallPending = true;
    notifyListeners();
  }

  void consumeAutoCall() {
    _autoCallPending = false;
    notifyListeners();
  }

  /// Called by HomeShell to (re)bind everything to the signed-in user.
  void start(User user) {
    _watchPresence(user.uid);
    _watchIncomingCalls(user.uid);
  }

  // ── Presence ─────────────────────────────────────────────────────────────
  void _watchPresence(String uid) {
    _presenceSub?.cancel();
    _presenceSub = FirebaseFirestore.instance
        .collection('users')
        .doc(uid)
        .collection('config')
        .doc('desktop')
        .snapshots()
        .listen((snap) {
      final d = snap.data();
      if (d == null) {
        _desktop = null;
      } else {
        final turnMap = d['turn'] is Map<String, dynamic> ? d['turn'] as Map<String, dynamic> : null;
        final turnUrls = turnMap?['urls'];
        _turnUrls = turnUrls is List ? turnUrls.whereType<String>().toList() : const <String>[];
        _turnUsername = turnMap?['username'] as String? ?? '';
        _turnCredential = turnMap?['credential'] as String? ?? '';
        _desktop = DesktopInfo(
          online: d['online'] == true,
          busy: d['busy'] == true,
          callEnabled: d['callEnabled'] == true,
          deviceName: (d['deviceName'] as String?) ?? 'Myto Desktop',
          lastSeen: (d['ts'] as num?)?.toInt() ?? 0,
        );
      }
      notifyListeners();
    });
  }

  List<String> _turnUrls = const <String>[];
  String _turnUsername = '';
  String _turnCredential = '';

  // ── Incoming (callback) calls ────────────────────────────────────────────
  void _watchIncomingCalls(String uid) {
    _callsSub?.cancel();
    _callsSub = FirebaseFirestore.instance
        .collection('users')
        .doc(uid)
        .collection('calls')
        .orderBy('ts', descending: true)
        .limit(10)
        .snapshots()
        .listen((snap) {
      if (_phase == CallPhase.idle ||
          _phase == CallPhase.ended ||
          _phase == CallPhase.failed ||
          _phase == CallPhase.declined) {
        for (final change in snap.docChanges) {
          final d = change.doc.data();
          if (d == null) continue;
          if (d['dir'] == 'd2m' && d['state'] == 'incoming' && !_incomingShown) {
            _incomingShown = true;
            showIncoming(change.doc.id, (d['summary'] as String?) ?? '');
            break;
          }
        }
      }
    });
  }

  /// Entry point from an FCM push (app in background → notification tap) or the
  /// foreground listener above.
  Future<void> showIncoming(String id, String summary) async {
    if (_phase == CallPhase.active || _phase == CallPhase.calling || _phase == CallPhase.connecting) {
      return; // already on a call — the desktop marks this one missed itself
    }
    _callId = id;
    _phase = CallPhase.incoming;
    _failReason = '';
    _statusText = summary.isEmpty ? 'Myto wants to talk to you' : summary;
    notifyListeners();
  }

  Future<void> acceptIncoming() async {
    if (_callId == null) return;
    final uid = _uid();
    if (uid == null) return;
    _seenSignals.clear();
    _phase = CallPhase.connecting;
    _statusText = 'Connecting…';
    notifyListeners();
    await _patchCall(<String, dynamic>{'state': 'accepted', 'acceptedAt': DateTime.now().millisecondsSinceEpoch});
    await _pushSignal('accept', '{}');
    // Desktop is the caller → it offers; we answer. Bound the wait in case the
    // desktop died between ringing us and offering.
    _negotiateTimer?.cancel();
    _negotiateTimer = Timer(const Duration(seconds: 35), () {
      if (_phase == CallPhase.connecting) {
        _failReason = 'Myto stopped responding during connection.';
        _endCallLocally(outcome: 'timeout', state: 'failed');
      }
    });
    await _setupPeer(role: 'answerer');
    _listenSignals();
    _watchCallDoc();
  }

  Future<void> declineIncoming() async {
    final uid = _uid();
    if (uid != null && _callId != null) {
      await _patchCall(<String, dynamic>{
        'state': 'declined',
        'endedAt': DateTime.now().millisecondsSinceEpoch,
      });
    }
    _incomingShown = false;
    _cleanup();
    _phase = CallPhase.declined;
    notifyListeners();
  }

  // ── Outgoing call ────────────────────────────────────────────────────────
  Future<bool> startCall() async {
    final uid = _uid();
    final resumable = _phase == CallPhase.idle ||
        _phase == CallPhase.ended ||
        _phase == CallPhase.failed ||
        _phase == CallPhase.declined;
    if (uid == null || !resumable) return false;
    if (_desktop == null || !_desktop!.reachable) {
      _failReason = _desktop == null
          ? 'No paired desktop found. Sign this PC into Myto first.'
          : _desktop!.online
              ? 'Calling is turned off on the desktop.'
              : 'Myto is offline on your PC right now.';
      _phase = CallPhase.failed;
      notifyListeners();
      return false;
    }

    final id = 'c-${DateTime.now().millisecondsSinceEpoch.toRadixString(36)}${Random().nextInt(999)}';
    _callId = id;
    _seenSignals.clear();
    _phase = CallPhase.calling;
    _failReason = '';
    _statusText = 'Calling Myto…';
    _duration = Duration.zero;
    _transcript.clear();
    _logs.clear();
    _everConnected = false;
    _incomingShown = false;
    notifyListeners();

    try {
      await FirebaseFirestore.instance
          .collection('users')
          .doc(uid)
          .collection('calls')
          .doc(id)
          .set(<String, dynamic>{
        'uid': uid,
        'dir': 'm2d',
        'state': 'ringing',
        'ts': DateTime.now().millisecondsSinceEpoch,
      });
    } on FirebaseException catch (e) {
      _failReason = 'Could not reach the call service: ${e.code}';
      _phase = CallPhase.failed;
      notifyListeners();
      return false;
    }

    // The caller offers — but only once the desktop ACCEPTS (the ring is real).
    await _setupPeer(role: 'offerer');
    _listenSignals();
    _watchCallDoc();

    _ringTimer?.cancel();
    _ringTimer = Timer(const Duration(seconds: 35), () {
      if (_phase == CallPhase.calling || _phase == CallPhase.connecting) {
        _failReason = 'Myto did not answer.';
        _endCallLocally(outcome: 'timeout', state: 'failed');
      }
    });
    return true;
  }

  // ── WebRTC ───────────────────────────────────────────────────────────────
  Future<void> _setupPeer({required String role}) async {
    await _disposePeer();
    // Sanitized ICE config, mirroring the desktop's buildIceServers: a turn:
    // URL without BOTH username and credential makes the peer construction
    // itself throw — a half-filled TURN must degrade to STUN-only instead.
    final stunUrls = _turnUrls
        .where((u) => u.trim().toLowerCase().startsWith('stun:'))
        .toList();
    final turnUrls = _turnUrls.where((u) {
      final s = u.trim().toLowerCase();
      return s.startsWith('turn:') || s.startsWith('turns:');
    }).toList();
    final servers = <Map<String, dynamic>>[
      if (stunUrls.isNotEmpty) <String, dynamic>{'urls': stunUrls},
      if (turnUrls.isNotEmpty && _turnUsername.trim().isNotEmpty && _turnCredential.trim().isNotEmpty)
        <String, dynamic>{
          'urls': turnUrls,
          'username': _turnUsername.trim(),
          'credential': _turnCredential.trim(),
        },
    ];
    if (servers.isEmpty) {
      servers.add(<String, dynamic>{'urls': 'stun:stun.l.google.com:19302'});
    }
    _pc = await createPeerConnection(<String, dynamic>{
      'iceServers': servers,
      'sdpSemantics': 'unified-plan',
    });

    try {
      _mic = await navigator.mediaDevices.getUserMedia(<String, dynamic>{
        'audio': true,
        'video': false,
      });
      for (final track in _mic!.getAudioTracks()) {
        await _pc!.addTrack(track, _mic!);
      }
    } catch (_) {
      // Mic denied: the call still connects (Myto can talk; the user replies
      // via the composer-less fallback? For now surface it in the log).
      _log('err', 'Microphone unavailable — check the RECORD_AUDIO permission.');
    }

    _pc!.onIceCandidate = (RTCIceCandidate candidate) {
      _pushSignal('ice', jsonEncode(candidate.toMap()));
    };
    _pc!.onConnectionState = (RTCPeerConnectionState state) {
      _log('info', 'peer: ${state.name}');
      switch (state) {
        case RTCPeerConnectionState.RTCPeerConnectionStateConnected:
          _onConnected();
          break;
        case RTCPeerConnectionState.RTCPeerConnectionStateDisconnected:
          _onDisconnected();
          break;
        case RTCPeerConnectionState.RTCPeerConnectionStateFailed:
          _onFailed();
          break;
        default:
          break;
      }
    };
    _pc!.onDataChannel = (RTCDataChannel channel) {
      _bindDataChannel(channel);
    };

    if (role == 'offerer') {
      final dc = await _pc!.createDataChannel(
        'myto-call',
        RTCDataChannelInit()..ordered = true,
      );
      _bindDataChannel(dc);
      // The offer is created when the desktop accepts (see _listenSignals).
    }
  }

  void _bindDataChannel(RTCDataChannel channel) {
    _dc = channel;
    channel.onMessage = (RTCDataChannelMessage message) {
      if (message.isBinary) return;
      _onDesktopMessage(message.text);
    };
    channel.onDataChannelState = (RTCDataChannelState state) {
      if (state == RTCDataChannelState.RTCDataChannelOpen) {
        _sendDc(<String, dynamic>{'t': 'hello', 'deviceName': 'Myto Phone'});
        _startPing();
        _startListening();
      }
    };
  }

  Future<void> _createAndSendOffer() async {
    final pc = _pc;
    if (pc == null) {
      _log('err', 'offer skipped — peer not ready');
      return;
    }
    try {
      final offer = await pc.createOffer(<String, dynamic>{'offerToReceiveAudio': 1});
      await pc.setLocalDescription(offer);
      await _pushSignal('offer', offer.sdp ?? '');
      _log('info', 'offer sent');
    } catch (e) {
      // Never swallow: a failed offer leaves both sides waiting forever, and
      // this log line is the only trace on the phone.
      _log('err', 'offer failed: $e');
    }
  }

  void _listenSignals() {
    final uid = _uid();
    final id = _callId;
    if (uid == null || id == null) return;
    _signalSub?.cancel();
    _signalSub = FirebaseFirestore.instance
        .collection('users')
        .doc(uid)
        .collection('calls')
        .doc(id)
        .collection('signals')
        .snapshots()
        .listen((snap) async {
      // Desktop signals only, deduped (listener reconnects re-deliver all
      // docs as `added`), and ordered by seq so ICE candidates can never
      // arrive before the answer that must precede them.
      final incoming = <(String, Map<String, dynamic>)>[];
      for (final change in snap.docChanges) {
        final d = change.doc.data();
        final id = change.doc.id;
        if (d == null || d['from'] != 'desktop' || _seenSignals.contains(id)) continue;
        _seenSignals.add(id);
        incoming.add((id, d));
      }
      incoming.sort((a, b) => ((a.$2['seq'] as num?) ?? 0).compareTo((b.$2['seq'] as num?) ?? 0));
      for (final (_, d) in incoming) {
        try {
          await _onDesktopSignal(
            (d['kind'] as String?) ?? '',
            (d['payload'] as String?) ?? '',
          );
        } catch (e) {
          // A throwing signal handler must never die silently — this log is
          // how the user can tell us where the call stuck.
          _log('err', 'signal ${(d['kind'] as String?) ?? '?'} failed: $e');
        }
      }
    });
  }

  /// Watch the call doc for desktop-written terminal states. Reacts ONLY while
  /// this side is still live — our own terminal writes echo back and are ignored.
  void _watchCallDoc() {
    final uid = _uid();
    final id = _callId;
    if (uid == null || id == null) return;
    _callDocSub?.cancel();
    _callDocSub = FirebaseFirestore.instance
        .collection('users')
        .doc(uid)
        .collection('calls')
        .doc(id)
        .snapshots()
        .listen((snap) {
      final d = snap.data();
      if (d == null) return;
      final state = d['state'] as String?;
      if (state == null) return;
      final live = _phase == CallPhase.calling ||
          _phase == CallPhase.connecting ||
          _phase == CallPhase.active ||
          _phase == CallPhase.reconnecting;
      if (!live) return;
      if (state == 'declined') {
        final detail = (d['detail'] as String?) ?? '';
        _failReason = detail.isNotEmpty ? detail : 'Myto was busy on another call.';
        _log('info', 'declined by desktop: $_failReason');
        _endCallLocally(outcome: 'declined', state: 'failed');
      } else if (state == 'ended' || state == 'failed' || state == 'missed' || state == 'cancelled') {
        _failReason = (d['detail'] as String?) ?? '';
        _log('info', 'desktop ended the call ($state)');
        _endCallLocally(
          outcome: d['outcome'] as String? ?? 'hangup',
          state: state == 'failed' ? 'failed' : 'ended',
        );
      }
    });
  }

  Future<void> _onDesktopSignal(String kind, String payload) async {
    final pc = _pc;
    if (pc == null) return;
    switch (kind) {
      case 'accept':
        if (_phase == CallPhase.calling) {
          _phase = CallPhase.connecting;
          _statusText = 'Connecting…';
          _ringTimer?.cancel();
          notifyListeners();
          // Bound the negotiation: if the desktop dies right after accepting,
          // no offer ever arrives and without this timer we hang forever.
          _negotiateTimer?.cancel();
          _negotiateTimer = Timer(const Duration(seconds: 35), () {
            if (_phase == CallPhase.connecting) {
              _failReason = 'The desktop stopped responding during connection.';
              _endCallLocally(outcome: 'timeout', state: 'failed');
            }
          });
          // We're the offerer (outgoing) — ALWAYS create the offer on accept.
          // (A getLocalDescription()==null guard here silently skipped the
          // offer on some devices: flutter_webrtc may return a non-null empty
          // description before setLocalDescription, leaving both sides hung.)
          await _createAndSendOffer();
        }
        break;
      case 'offer':
        // Desktop offers (callback calls): answer it.
        await pc.setRemoteDescription(RTCSessionDescription(payload, 'offer'));
        final answer = await pc.createAnswer(<String, dynamic>{});
        await pc.setLocalDescription(answer);
        await _pushSignal('answer', answer.sdp ?? '');
        _log('info', 'answer sent');
        break;
      case 'answer':
        final remote = await pc.getRemoteDescription();
        if (remote == null) {
          await pc.setRemoteDescription(RTCSessionDescription(payload, 'answer'));
          _log('info', 'answer received');
        }
        break;
      case 'ice':
        try {
          final map = jsonDecode(payload) as Map<String, dynamic>;
          await pc.addCandidate(RTCIceCandidate(
            map['candidate'] as String?,
            map['sdpMid'] as String?,
            (map['sdpMLineIndex'] as num?)?.toInt(),
          ));
        } catch (_) {
          // Malformed candidate — the next one usually works.
        }
        break;
      case 'hangup':
        _failReason = '';
        _endCallLocally(outcome: 'hangup', state: 'ended');
        break;
    }
  }

  void _onConnected() {
    _everConnected = true;
    _reconnectTimer?.cancel();
    _ringTimer?.cancel();
    _negotiateTimer?.cancel();
    if (_phase != CallPhase.active) {
      _phase = CallPhase.active;
      _statusText = 'Connected';
      _durationTimer?.cancel();
      _durationTimer = Timer.periodic(const Duration(seconds: 1), (_) {
        _duration += const Duration(seconds: 1);
        notifyListeners();
      });
      _patchCall(<String, dynamic>{'state': 'active'});
    }
    // After an ICE restart the recognizer's status loop is dead (the phase
    // left `active` while reconnecting) — resume the mic if we still want it.
    if (_sttWanted && !_muted && !_hold) _startListening();
    notifyListeners();
  }

  void _onDisconnected() {
    if (_phase == CallPhase.active) {
      _phase = CallPhase.reconnecting;
      _statusText = 'Reconnecting…';
      notifyListeners();
      _reconnectTimer?.cancel();
      _reconnectTimer = Timer(const Duration(seconds: 5), () {
        try {
          _pc?.restartIce();
        } catch (_) {}
      });
    }
  }

  void _onFailed() {
    if (_everConnected) {
      _failReason = 'The connection dropped.';
      _endCallLocally(outcome: 'error', state: 'failed');
    } else {
      _failReason = 'Could not reach the desktop. Check the network (a relayed connection may be needed).';
      _endCallLocally(outcome: 'error', state: 'failed');
    }
  }

  // ── Data channel (desktop messages) ──────────────────────────────────────
  void _onDesktopMessage(String json_) {
    Map<String, dynamic> msg;
    try {
      msg = jsonDecode(json_) as Map<String, dynamic>;
    } catch (_) {
      return;
    }
    final t = msg['t'] as String?;
    switch (t) {
      case 'speaking':
        _desktopSpeaking = msg['on'] == true;
        notifyListeners();
        break;
      case 'listening':
        _userSpeaking = false;
        break;
      case 'status':
        _statusText = (msg['text'] as String?) ?? '';
        _log('status', _statusText);
        notifyListeners();
        break;
      case 'transcript':
        _transcript.add(TranscriptLine(
          role: (msg['role'] as String?) ?? 'myto',
          text: (msg['text'] as String?) ?? '',
        ));
        if (_transcript.length > 60) _transcript.removeRange(0, _transcript.length - 60);
        notifyListeners();
        break;
      case 'log':
        _log((msg['stream'] as String?) ?? 'out', (msg['text'] as String?) ?? '');
        break;
      case 'command':
        _log('info', '${msg['status']}: ${msg['command']}');
        notifyListeners();
        break;
      case 'approval_request':
        _approval = CallApproval(
          id: (msg['id'] as String?) ?? '',
          title: (msg['title'] as String?) ?? 'Permission',
          detail: (msg['detail'] as String?) ?? '',
          tool: (msg['tool'] as String?) ?? '',
        );
        notifyListeners();
        break;
      case 'question':
        _question = (
          id: (msg['id'] as String?) ?? '',
          title: (msg['title'] as String?) ?? 'Question',
          options: ((msg['options'] as List?) ?? const []).whereType<String>().toList(),
        );
        notifyListeners();
        break;
      case 'task':
        _taskInProgress = msg['state'] == 'accepted' || msg['state'] == 'running';
        _log('info', 'task ${msg['state']}: ${msg['summary'] ?? ''}');
        notifyListeners();
        break;
      case 'latency':
        _rttMs = (msg['rttMs'] as num?)?.toInt() ?? _rttMs;
        _quality = (msg['quality'] as String?) ?? _quality;
        notifyListeners();
        break;
      case 'pong':
        final ts = (msg['ts'] as num?)?.toInt() ?? 0;
        if (ts > 0) {
          _rttMs = DateTime.now().millisecondsSinceEpoch - ts;
          notifyListeners();
        }
        break;
      case 'speak_text':
        // Desktop TTS failed — speak locally as the fallback.
        _speakLocally((msg['text'] as String?) ?? '');
        break;
      case 'bye':
        _endCallLocally(outcome: 'hangup', state: 'ended');
        break;
    }
  }

  // ── STT (on-device, streaming) ───────────────────────────────────────────
  Future<void> _startListening() async {
    _sttWanted = true;
    if (!_sttAvailable) {
      try {
        _sttAvailable = await _stt.initialize(
          onError: (error) => _log('err', 'STT: ${error.errorMsg}'),
          onStatus: (status) {
            if (status == 'done' || status == 'notListening') {
              _userSpeaking = false;
              notifyListeners();
              if (_sttWanted && !_muted && !_hold && _phase == CallPhase.active) {
                _listenRestartTimer?.cancel();
                _listenRestartTimer = Timer(const Duration(milliseconds: 250), () {
                  _startListening();
                });
              }
            }
          },
        );
      } catch (_) {
        _sttAvailable = false;
      }
      if (!_sttAvailable) {
        _log('err', 'On-device speech recognition unavailable on this phone.');
        return;
      }
    }
    if (!_sttWanted || _muted || _hold || _phase != CallPhase.active) {
      if (!_sttBlockedLogged && _sttWanted) {
        _sttBlockedLogged = true;
        _log('info', 'voice waiting for the active call (phase: ${_phase.name})');
      }
      return;
    }
    try {
      await _stt.listen(
        onResult: (result) {
          final words = result.recognizedWords.trim();
          if (words.isEmpty) return;
          _userSpeaking = true;
          if (result.finalResult) {
            _sendDc(<String, dynamic>{'t': 'stt_final', 'text': words});
            _transcript.add(TranscriptLine(role: 'user', text: words));
            if (_transcript.length > 60) _transcript.removeRange(0, _transcript.length - 60);
            notifyListeners();
          } else {
            // Partials drive barge-in on the desktop (it decides when to cut TTS).
            _sendDc(<String, dynamic>{'t': 'stt_partial', 'text': words});
          }
        },
          listenOptions: stt.SpeechListenOptions(
            partialResults: true,
            cancelOnError: false,
            listenMode: stt.ListenMode.dictation,
            localeId: 'en_IN',
          ),
        );
        _log('info', 'listening — speak now');
      } catch (_) {
        // The en_IN locale may be missing — retry with the device default.
        try {
          await _stt.listen(
            onResult: (result) {
              final words = result.recognizedWords.trim();
              if (words.isEmpty) return;
              if (result.finalResult) {
                _sendDc(<String, dynamic>{'t': 'stt_final', 'text': words});
              } else {
                _sendDc(<String, dynamic>{'t': 'stt_partial', 'text': words});
              }
            },
            listenOptions: stt.SpeechListenOptions(partialResults: true, cancelOnError: false),
          );
          _log('info', 'listening (device locale) — speak now');
        } catch (e) {
          _log('err', 'Speech recognition failed to start: $e');
        }
      }
  }

  void _stopListening() {
    _sttWanted = false;
    _listenRestartTimer?.cancel();
    try {
      _stt.stop();
    } catch (_) {}
  }

  Future<void> _speakLocally(String text) async {
    if (text.isEmpty) return;
    try {
      await _fallbackTts.setLanguage('en-IN');
      await _fallbackTts.setSpeechRate(0.48);
      await _fallbackTts.speak(text);
    } catch (_) {
      // No on-device TTS — the transcript still shows the text.
    }
  }

  // ── Controls ─────────────────────────────────────────────────────────────
  Future<void> toggleMute() async {
    _muted = !_muted;
    try {
      _mic?.getAudioTracks().first.enabled = !_muted;
    } catch (_) {}
    _sendDc(<String, dynamic>{'t': 'mute', 'on': _muted});
    if (_muted) _stopListening();
    notifyListeners();
  }

  Future<void> toggleSpeaker() async {
    _speaker = !_speaker;
    try {
      await Helper.setSpeakerphoneOn(_speaker);
    } catch (_) {
      _log('err', 'Speaker routing not available on this device.');
    }
    notifyListeners();
  }

  Future<void> toggleHold() async {
    _hold = !_hold;
    _sendDc(<String, dynamic>{'t': 'hold', 'on': _hold});
    if (_hold) {
      _stopListening();
      _sendDc(<String, dynamic>{'t': 'interrupt'});
    } else if (_phase == CallPhase.active) {
      _startListening();
    }
    notifyListeners();
  }

  void sendKeypad(String digits) {
    if (digits.isEmpty) return;
    _sendDc(<String, dynamic>{'t': 'keypad', 'digits': digits});
  }

  /// Type to Myto mid-call — rides the exact same path as speech (stt_final),
  /// so the agent hears it and answers by voice + transcript.
  void sendTypedText(String text) {
    final clean = text.trim();
    if (clean.isEmpty) return;
    _sendDc(<String, dynamic>{'t': 'stt_final', 'text': clean});
    _transcript.add(TranscriptLine(role: 'user', text: clean));
    if (_transcript.length > 60) _transcript.removeRange(0, _transcript.length - 60);
    notifyListeners();
  }

  // ── Call history management ──────────────────────────────────────────────
  CollectionReference<Map<String, dynamic>>? _callsRef() {
    final uid = _uid();
    if (uid == null) return null;
    return FirebaseFirestore.instance.collection('users').doc(uid).collection('calls');
  }

  /// Delete ONE call-history entry (its signals first, then the doc).
  /// A live call is never deleted.
  Future<bool> deleteCallEntry(String callId) async {
    final calls = _callsRef();
    if (calls == null || callId == _callId) return false;
    try {
      final sigs = await calls.doc(callId).collection('signals').get();
      for (final s in sigs.docs) {
        await s.reference.delete();
      }
      await calls.doc(callId).delete();
      return true;
    } on FirebaseException {
      return false;
    }
  }

  /// Delete the ENTIRE call history (every call doc + its signals).
  /// A live call is never deleted.
  Future<int> clearCallHistory() async {
    final calls = _callsRef();
    if (calls == null) return 0;
    var n = 0;
    try {
      final snap = await calls.get();
      for (final d in snap.docs) {
        if (d.id == _callId) continue; // a live call stays
        final sigs = await d.reference.collection('signals').get();
        for (final s in sigs.docs) {
          await s.reference.delete();
        }
        await d.reference.delete();
        n++;
      }
    } on FirebaseException {
      // Best-effort — whatever was deleted stays deleted.
    }
    return n;
  }

  void setVoiceRate(String rate) {
    _sendDc(<String, dynamic>{'t': 'voice_rate', 'rate': rate});
  }

  void answerApproval(String id, String decision) {
    _sendDc(<String, dynamic>{'t': 'approval', 'id': id, 'decision': decision});
    _approval = null;
    notifyListeners();
  }

  void answerQuestion(String id, String answer) {
    _sendDc(<String, dynamic>{'t': 'question', 'id': id, 'answers': [answer]});
    _question = null;
    notifyListeners();
  }

  // ── Teardown ─────────────────────────────────────────────────────────────
  Future<void> hangup() async {
    await _patchCall(<String, dynamic>{
      'state': 'ended',
      'outcome': 'hangup',
      'endedAt': DateTime.now().millisecondsSinceEpoch,
    });
    await _pushSignal('hangup', '{}');
    _endCallLocally(outcome: 'hangup', state: 'ended');
  }

  Future<void> cancelCalling() async {
    await _patchCall(<String, dynamic>{
      'state': 'cancelled',
      'outcome': 'hangup',
      'endedAt': DateTime.now().millisecondsSinceEpoch,
    });
    _endCallLocally(outcome: 'hangup', state: 'idle');
  }

  void _endCallLocally({required String outcome, required String state}) {
    _ringTimer?.cancel();
    _negotiateTimer?.cancel();
    _durationTimer?.cancel();
    _pingTimer?.cancel();
    _reconnectTimer?.cancel();
    _stopListening();
    _disposePeer();
    _incomingShown = false;
    _desktopSpeaking = false;
    _userSpeaking = false;
    _taskInProgress = false;
    _approval = null;
    _question = null;
    // TELL the desktop we're gone — a phone-side timeout that stays silent
    // leaves the desktop session alive forever, and then EVERY later call is
    // declined as 'busy'. The signal is idempotent on the desktop.
    if (_callId != null && state != 'idle') {
      _patchCall(<String, dynamic>{
        'state': state,
        'outcome': outcome,
        'endedAt': DateTime.now().millisecondsSinceEpoch,
      });
      _pushSignal('hangup', '{"by":"phone","outcome":"$outcome"}');
    }
    _signalSub?.cancel();
    _signalSub = null;
    _callDocSub?.cancel();
    _callDocSub = null;
    if (state == 'failed') {
      _phase = CallPhase.failed;
    } else if (state == 'idle') {
      _phase = CallPhase.idle;
    } else {
      _phase = CallPhase.ended;
    }
    _statusText = _failReason.isNotEmpty ? _failReason : 'Call ended';
    notifyListeners();
  }

  Future<void> _disposePeer() async {
    try {
      _dc?.close();
    } catch (_) {}
    _dc = null;
    try {
      await _pc?.close();
    } catch (_) {}
    _pc = null;
    try {
      await _mic?.dispose();
    } catch (_) {}
    _mic = null;
  }

  void _cleanup() {
    _signalSub?.cancel();
    _signalSub = null;
    _callDocSub?.cancel();
    _callDocSub = null;
    _ringTimer?.cancel();
    _negotiateTimer?.cancel();
    _durationTimer?.cancel();
    _pingTimer?.cancel();
    _reconnectTimer?.cancel();
    _stopListening();
    _disposePeer();
    _callId = null;
  }

  /// Reset back to idle (dismiss the "call ended" screen).
  void dismiss() {
    _cleanup();
    _phase = CallPhase.idle;
    _statusText = '';
    _failReason = '';
    notifyListeners();
  }

  // ── Small helpers ────────────────────────────────────────────────────────
  String? _uid() => FirebaseAuth.instance.currentUser?.uid;

  Future<void> _patchCall(Map<String, dynamic> patch) async {
    final uid = _uid();
    final id = _callId;
    if (uid == null || id == null) return;
    try {
      await FirebaseFirestore.instance
          .collection('users')
          .doc(uid)
          .collection('calls')
          .doc(id)
          .set(patch, SetOptions(merge: true));
    } on FirebaseException {
      // Lifecycle writes are best-effort; the desktop's own state machine converges.
    }
  }

  Future<void> _pushSignal(String kind, String payload) async {
    final uid = _uid();
    final id = _callId;
    if (uid == null || id == null) return;
    final seq = _mobileSeq++;
    try {
      await FirebaseFirestore.instance
          .collection('users')
          .doc(uid)
          .collection('calls')
          .doc(id)
          .collection('signals')
          // Zero-padded id: Firestore lists by lexicographic document id, and
          // without padding `sig-m-10` would sort BEFORE `sig-m-2` — ICE
          // candidates could then overtake the offer they belong to.
          .doc('sig-m-${seq.toString().padLeft(4, '0')}')
          .set(<String, dynamic>{
        'from': 'mobile',
        'seq': seq,
        'kind': kind,
        'payload': payload,
        'ts': DateTime.now().millisecondsSinceEpoch,
      });
    } on FirebaseException {
      _log('err', 'Signaling write failed ($kind).');
    }
  }

  void _sendDc(Map<String, dynamic> msg) {
    try {
      _dc?.send(RTCDataChannelMessage(jsonEncode(msg)));
    } catch (_) {
      // Channel not open yet — desktop state still converges via the doc.
    }
  }

  void _startPing() {
    _pingTimer?.cancel();
    _pingTimer = Timer.periodic(const Duration(seconds: 3), (_) {
      _sendDc(<String, dynamic>{'t': 'ping', 'ts': DateTime.now().millisecondsSinceEpoch});
    });
  }

  void _log(String stream, String text) {
    if (text.trim().isEmpty) return;
    _logs.add(CallLogLine(stream: stream, text: text.trim(), at: DateTime.now()));
    if (_logs.length > 200) _logs.removeRange(0, _logs.length - 200);
    notifyListeners();
  }

  @override
  void dispose() {
    _cleanup();
    _presenceSub?.cancel();
    _callsSub?.cancel();
    super.dispose();
  }
}

/// Call history entry for the Call tab (read straight from Firestore).
class CallHistoryEntry {
  CallHistoryEntry({required this.id, required this.data});
  final String id;
  final Map<String, dynamic> data;

  String get dir => (data['dir'] as String?) ?? 'm2d';
  String get state => (data['state'] as String?) ?? 'ended';
  String get outcome => (data['outcome'] as String?) ?? '';
  String get summary => (data['summary'] as String?) ?? '';
  int get ts => (data['ts'] as num?)?.toInt() ?? 0;
  DateTime get at => DateTime.fromMillisecondsSinceEpoch(ts);
}
