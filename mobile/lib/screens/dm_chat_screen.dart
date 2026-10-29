import 'dart:async';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';

import '../services/dm_service.dart';
import '../services/notification_service.dart';
import '../theme.dart';

/// ---------------------------------------------------------------------------
/// DmChatScreen — a 1:1 WhatsApp-style text chat.
///
///   • bubbles (mine right / theirs left) with subtle entrance animation
///   • swipe a bubble → quote-reply (preview bar above the composer)
///   • typing indicator (live, stale-heartbeat aware) in the header + above input
///   • seen receipts: ✓ sent, ✓✓ read (blue) under my messages
///   • header shows online / last seen, driven by presence/{uid}
/// ---------------------------------------------------------------------------
class DmChatScreen extends StatefulWidget {
  const DmChatScreen({
    super.key,
    required this.otherUid,
    required this.otherName,
    required this.otherPhoto,
  });

  final String otherUid;
  final String otherName;
  final String otherPhoto;

  @override
  State<DmChatScreen> createState() => _DmChatScreenState();
}

class _DmChatScreenState extends State<DmChatScreen> {
  final TextEditingController _ctrl = TextEditingController();
  final ScrollController _scroll = ScrollController();
  final FocusNode _focus = FocusNode();
  DmMessage? _replyTo;
  bool _typingSent = false;
  Timer? _typingStop;
  List<DmMessage>? _messages;
  Timer? _markSeenDebounce;
  bool _removedNotice = false;
  bool _otherVerified = false;

  String get _me => FirebaseAuth.instance.currentUser?.uid ?? '';
  late final String _threadId = DmService.threadIdFor(_me, widget.otherUid);

  @override
  void initState() {
    super.initState();
    // 24h retention: delete my aged-out messages from the database, and let
    // the user know history was purged when the thread now sits empty.
    DmService.sweepExpired(_threadId, _me).then((removed) {
      if (removed > 0 && mounted) setState(() => _removedNotice = true);
    });
    NotificationService.markDmSeen(_threadId);
    _loadOtherVerified();
  }

  Future<void> _loadOtherVerified() async {
    try {
      final snap = await FirebaseFirestore.instance
          .collection('profiles')
          .doc(widget.otherUid)
          .get();
      if (!mounted) return;
      setState(() => _otherVerified = snap.data()?['verified'] == true);
    } on FirebaseException {
      // Badge is cosmetic — ignore.
    }
  }

  @override
  void dispose() {
    _typingStop?.cancel();
    _markSeenDebounce?.cancel();
    _flushTyping(false);
    _ctrl.dispose();
    _scroll.dispose();
    _focus.dispose();
    super.dispose();
  }

  void _onTextChanged(String v) {
    if (_me.isEmpty) return;
    if (v.trim().isNotEmpty) {
      if (!_typingSent) {
        _typingSent = true;
        DmService.setTyping(_threadId, _me, true);
      }
      _typingStop?.cancel();
      // Stop broadcasting typing shortly after the last keystroke.
      _typingStop = Timer(const Duration(seconds: 3), () => _flushTyping(false));
    } else {
      _flushTyping(false);
    }
    setState(() {});
  }

  void _flushTyping(bool typing) {
    _typingStop?.cancel();
    _typingStop = null;
    if (_typingSent == typing) return;
    _typingSent = typing;
    if (_me.isNotEmpty) DmService.setTyping(_threadId, _me, typing);
  }

  Future<void> _send() async {
    final text = _ctrl.text.trim();
    if (text.isEmpty || _me.isEmpty) return;
    final reply = _replyTo;
    _ctrl.clear();
    setState(() => _replyTo = null);
    _flushTyping(false);
    try {
      await DmService.sendMessage(
        threadId: _threadId,
        from: _me,
        text: text,
        replyTo: reply,
      );
      _scrollToBottom();
    } on FirebaseException {
      if (mounted) {
        ScaffoldMessenger.of(context)
          ..hideCurrentSnackBar()
          ..showSnackBar(const SnackBar(content: Text('Message failed — try again.')));
      }
    }
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(
          0,
          duration: const Duration(milliseconds: 250),
          curve: Curves.easeOut,
        );
      }
    });
  }

  void _scheduleMarkSeen() {
    _markSeenDebounce?.cancel();
    _markSeenDebounce = Timer(const Duration(milliseconds: 600), () {
      if (mounted && _me.isNotEmpty) DmService.markSeen(_threadId, _me);
    });
  }

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return Scaffold(
      backgroundColor: palette.bg,
      appBar: AppBar(
        titleSpacing: 0,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_rounded),
          onPressed: () => Navigator.of(context).pop(),
        ),
        title: Row(
          children: <Widget>[
            _AvatarWithDot(photo: widget.otherPhoto, name: widget.otherName, uid: widget.otherUid),
            const SizedBox(width: TeamlySpace.s3),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: <Widget>[
                      Flexible(
                        child: Text(
                          widget.otherName,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.w700,
                            color: TeamlyColors.ink900,
                          ),
                        ),
                      ),
                      if (_otherVerified) ...<Widget>[
                        const SizedBox(width: 4),
                        const Icon(Icons.verified_rounded, size: 15, color: Color(0xFF1D9BF0)),
                      ],
                    ],
                  ),
                  _StatusLine(uid: widget.otherUid, threadId: _threadId),
                ],
              ),
            ),
          ],
        ),
      ),
      body: Column(
        children: <Widget>[
          if (_removedNotice)
            Container(
              width: double.infinity,
              color: palette.chip,
              padding: const EdgeInsets.symmetric(vertical: 6),
              child: const Text(
                'Due to security, we removed all your texts.',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 11.5, color: TeamlyColors.ink500),
              ),
            ),
          Expanded(
            child: StreamBuilder<List<DmMessage>>(
              stream: DmService.streamMessages(_threadId),
              builder: (context, snap) {
                final msgs = (snap.data ?? const <DmMessage>[]).reversed.toList();
                if (_messages != null && msgs.length != _messages!.length) {
                  _scrollToBottom();
                }
                // Opening (or staying in) the chat reads as "seen".
                if (msgs.any((m) => m.from != _me && !m.seen)) {
                  _scheduleMarkSeen();
                }
                _messages = msgs;
                if (msgs.isEmpty) {
                  return const _EmptyThread();
                }
                return ListView.builder(
                  controller: _scroll,
                  reverse: true,
                  padding: const EdgeInsets.symmetric(
                    horizontal: TeamlySpace.gutter,
                    vertical: TeamlySpace.s3,
                  ),
                  itemCount: msgs.length,
                  itemBuilder: (context, i) {
                    final m = msgs[i];
                    final mine = m.from == _me;
                    // Grouping: show the time chip above the first bubble of a batch.
                    final isNewBatch = i == 0 ||
                        msgs[i - 1].from != m.from ||
                        m.createdAtMs - msgs[i - 1].createdAtMs > 5 * 60 * 1000;
                    // The seen receipt rides under my most recent message.
                    final showSeen =
                        mine && (i == 0 || msgs.sublist(0, i).every((x) => x.from != _me));
                    return _Bubble(
                      key: ValueKey<String>(m.id),
                      message: m,
                      mine: mine,
                      showSeenBadge: showSeen,
                      newBatch: isNewBatch,
                      myUid: _me,
                      onReply: () => setState(() {
                        _replyTo = m;
                        _focus.requestFocus();
                      }),
                      onReact: (emoji) async {
                        final existing = m.reactions[_me];
                        await DmService.react(
                          _threadId,
                          m.id,
                          _me,
                          existing == emoji ? '' : emoji,
                        );
                      },
                      onUnsend: mine
                          ? () async {
                              await DmService.unsendMessage(_threadId, m.id);
                              setState(() => _removedNotice = false);
                            }
                          : null,
                    );
                  },
                );
              },
            ),
          ),
          _TypingBar(
            threadId: _threadId,
            otherUid: widget.otherUid,
            otherName: widget.otherName,
          ),
          _ComposerBar(
            ctrl: _ctrl,
            focus: _focus,
            replyTo: _replyTo,
            onChanged: _onTextChanged,
            onCancelReply: () => setState(() => _replyTo = null),
            onSend: _send,
          ),
        ],
      ),
    );
  }
}

// ── Header bits ────────────────────────────────────────────────────────────────

class _AvatarWithDot extends StatelessWidget {
  const _AvatarWithDot({required this.photo, required this.name, required this.uid});

  final String photo;
  final String name;
  final String uid;

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<Presence?>(
      stream: uid.isEmpty ? const Stream<Presence?>.empty() : DmService.streamPresence(uid),
      builder: (context, snap) {
        final online = snap.data?.online ?? false;
        return Stack(
          clipBehavior: Clip.none,
          children: <Widget>[
            _ChatAvatar(photo: photo, name: name, size: 36),
            if (online)
              Positioned(
                right: -1,
                bottom: -1,
                child: Container(
                  width: 12,
                  height: 12,
                  decoration: BoxDecoration(
                    color: TeamlyColors.green500,
                    shape: BoxShape.circle,
                    border: Border.all(color: context.palette.surface, width: 2),
                  ),
                ),
              ),
          ],
        );
      },
    );
  }
}

class _StatusLine extends StatelessWidget {
  const _StatusLine({required this.uid, required this.threadId});

  final String uid;
  final String threadId;

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<bool>(
      stream: DmService.streamTyping(threadId, uid),
      builder: (context, typingSnap) {
        if (typingSnap.data == true) {
          return const Text(
            'typing…',
            style: TextStyle(
              fontSize: 11.5,
              fontWeight: FontWeight.w600,
              color: TeamlyColors.greenText,
            ),
          );
        }
        return StreamBuilder<Presence?>(
          stream: uid.isEmpty ? const Stream<Presence?>.empty() : DmService.streamPresence(uid),
          builder: (context, snap) {
            return Text(
              presenceLine(snap.data),
              style: const TextStyle(fontSize: 11.5, color: TeamlyColors.ink500),
            );
          },
        );
      },
    );
  }
}

// ── Bubbles ────────────────────────────────────────────────────────────────────

class _Bubble extends StatelessWidget {
  const _Bubble({
    super.key,
    required this.message,
    required this.mine,
    required this.showSeenBadge,
    required this.newBatch,
    required this.myUid,
    required this.onReply,
    required this.onReact,
    this.onUnsend,
  });

  final DmMessage message;
  final bool mine;
  final bool showSeenBadge;
  final bool newBatch;
  final String myUid;
  final VoidCallback onReply;
  final ValueChanged<String> onReact;
  final VoidCallback? onUnsend;

  static const List<String> _emojis = <String>['\u2764\uFE0F', '\uD83D\uDE02', '\uD83D\uDD25', '\uD83D\uDC4D', '\uD83D\uDE2E', '\uD83D\uDE22'];

  Future<void> _actions(BuildContext context) async {
    await showModalBottomSheet<void>(
      context: context,
      backgroundColor: context.palette.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            // Emoji reactions — WhatsApp-style row.
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 14),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                children: <Widget>[
                  for (final e in _emojis)
                    GestureDetector(
                      onTap: () {
                        Navigator.pop(context);
                        onReact(e);
                      },
                      child: Text(e, style: const TextStyle(fontSize: 26)),
                    ),
                ],
              ),
            ),
            const Divider(height: 1),
            ListTile(
              leading: const Icon(Icons.reply_rounded, size: 20),
              title: const Text('Reply', style: TextStyle(fontSize: 14.5)),
              onTap: () {
                Navigator.pop(context);
                onReply();
              },
            ),
            if (onUnsend != null)
              ListTile(
                leading: const Icon(Icons.undo_rounded, size: 20, color: TeamlyColors.danger),
                title: const Text(
                  'Unsend',
                  style: TextStyle(fontSize: 14.5, color: TeamlyColors.danger),
                ),
                onTap: () {
                  Navigator.pop(context);
                  onUnsend!();
                },
              ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final bubbleColor = mine ? palette.accent : palette.surface;
    final textColor = mine ? palette.onAccent : TeamlyColors.ink900;
    final timeStyle = TextStyle(
      fontSize: 10.5,
      color: mine ? palette.onAccent.withValues(alpha: 0.75) : TeamlyColors.ink300,
    );

    return Padding(
      padding: EdgeInsets.only(top: newBatch ? TeamlySpace.s3 : 3),
      child: Column(
        crossAxisAlignment: mine ? CrossAxisAlignment.end : CrossAxisAlignment.start,
        children: <Widget>[
          Dismissible(
            key: ValueKey<String>('swipe:${message.id}'),
            direction: DismissDirection.startToEnd,
            // Swipe never dismisses — it only arms a reply.
            confirmDismiss: (_) async {
              onReply();
              return false;
            },
            background: Container(
              alignment: Alignment.centerLeft,
              padding: const EdgeInsets.only(left: TeamlySpace.s5),
              child: const Icon(Icons.reply_rounded, color: TeamlyColors.greenText),
            ),
            child: GestureDetector(
              onLongPress: () => _actions(context),
              onDoubleTap: onReply,
              child: Container(
                constraints: BoxConstraints(
                  maxWidth: MediaQuery.of(context).size.width * 0.76,
                ),
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                decoration: BoxDecoration(
                  color: bubbleColor,
                  borderRadius: BorderRadius.only(
                    topLeft: const Radius.circular(16),
                    topRight: const Radius.circular(16),
                    bottomLeft: Radius.circular(mine ? 16 : 4),
                    bottomRight: Radius.circular(mine ? 4 : 16),
                  ),
                  border: mine ? null : Border.all(color: palette.border),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    if (message.isReply) _ReplyQuote(message: message, mine: mine),
                    Text(
                      message.text,
                      style: TextStyle(fontSize: 14.5, height: 1.35, color: textColor),
                    ),
                    const SizedBox(height: 2),
                    Row(
                      mainAxisSize: MainAxisSize.min,
                      children: <Widget>[
                        Text(_clock(message.createdAtMs), style: timeStyle),
                        if (mine) ...<Widget>[
                          const SizedBox(width: 4),
                          _Ticks(message: message, palette: palette),
                        ],
                      ],
                    ),
                  ],
                ),
              ),
            ),
          ),
          // Reaction chips under the bubble.
          if (message.reactions.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 3),
              child: Wrap(
                spacing: 4,
                children: <Widget>[
                  for (final entry in message.reactions.entries)
                    GestureDetector(
                      onTap: () => onReact(entry.value),
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                        decoration: BoxDecoration(
                          color: palette.chip,
                          borderRadius: BorderRadius.circular(12),
                          border: entry.key == myUid
                              ? Border.all(color: TeamlyColors.green500, width: 1)
                              : null,
                        ),
                        child: Text(
                          entry.value,
                          style: const TextStyle(fontSize: 12),
                        ),
                      ),
                    ),
                ],
              ),
            ),
          if (mine && showSeenBadge)
            Padding(
              padding: const EdgeInsets.only(top: 2, right: 4),
              child: Text(
                message.seen ? 'Seen' : 'Delivered',
                style: const TextStyle(fontSize: 10.5, color: TeamlyColors.ink300),
              ),
            ),
        ],
      ),
    );
  }

  String _clock(int ms) {
    if (ms == 0) return '...';
    final d = DateTime.fromMillisecondsSinceEpoch(ms);
    final hh = d.hour % 12 == 0 ? 12 : d.hour % 12;
    final mm = d.minute.toString().padLeft(2, '0');
    return '$hh:$mm${d.hour < 12 ? ' AM' : ' PM'}';
  }
}

/// The WhatsApp-style receipt ticks: clock while the write is in flight,
/// one tick once sent, two grey ticks delivered, two blue ticks seen.
class _Ticks extends StatelessWidget {
  const _Ticks({required this.message, required this.palette});

  final DmMessage message;
  final MytoPalette palette;

  @override
  Widget build(BuildContext context) {
    if (message.createdAtMs == 0) {
      return Icon(Icons.schedule_rounded, size: 12, color: palette.onAccent.withValues(alpha: 0.75));
    }
    if (message.seen) {
      return const Icon(Icons.done_all_rounded, size: 13, color: Color(0xFF4FC3F7));
    }
    return Icon(
      Icons.done_all_rounded,
      size: 13,
      color: palette.onAccent.withValues(alpha: 0.75),
    );
  }
}

class _ReplyQuote extends StatelessWidget {
  const _ReplyQuote({required this.message, required this.mine});

  final DmMessage message;
  final bool mine;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return Container(
      margin: const EdgeInsets.only(bottom: 6),
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: mine
            ? Colors.white.withValues(alpha: 0.18)
            : context.palette.chip,
        borderRadius: BorderRadius.circular(8),
        border: Border(
          left: BorderSide(
            color: mine ? palette.onAccent : TeamlyColors.greenText,
            width: 3,
          ),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            message.replyFrom == message.from ? 'You' : message.replyFrom,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontSize: 11.5,
              fontWeight: FontWeight.w700,
              color: mine ? palette.onAccent : TeamlyColors.greenText,
            ),
          ),
          Text(
            message.replyText,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontSize: 12.5,
              color: mine
                  ? palette.onAccent.withValues(alpha: 0.85)
                  : TeamlyColors.ink700,
            ),
          ),
        ],
      ),
    );
  }
}

// ── Typing + composer ──────────────────────────────────────────────────────────

class _TypingBar extends StatelessWidget {
  const _TypingBar({
    required this.threadId,
    required this.otherUid,
    required this.otherName,
  });

  final String threadId;
  final String otherUid;
  final String otherName;

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<bool>(
      stream: otherUid.isEmpty ? const Stream<bool>.empty() : DmService.streamTyping(threadId, otherUid),
      builder: (context, snap) {
        final typing = snap.data == true;
        return AnimatedSize(
          duration: const Duration(milliseconds: 180),
          curve: Curves.easeOut,
          child: SizedBox(
            height: typing ? 24 : 0,
            child: typing
                ? Padding(
                    padding: const EdgeInsets.only(left: TeamlySpace.gutter, bottom: 2),
                    child: Row(
                      children: <Widget>[
                        const _TypingDots(),
                        const SizedBox(width: 6),
                        Text(
                          '$otherName is typing…',
                          style: const TextStyle(
                            fontSize: 11.5,
                            color: TeamlyColors.ink500,
                          ),
                        ),
                      ],
                    ),
                  )
                : const SizedBox.shrink(),
          ),
        );
      },
    );
  }
}

class _TypingDots extends StatefulWidget {
  const _TypingDots();

  @override
  State<_TypingDots> createState() => _TypingDotsState();
}

class _TypingDotsState extends State<_TypingDots> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 900),
  )..repeat();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _c,
      builder: (context, _) {
        return Row(
          children: <Widget>[
            for (var i = 0; i < 3; i++)
              Container(
                width: 5,
                height: 5,
                margin: const EdgeInsets.symmetric(horizontal: 1.5),
                decoration: BoxDecoration(
                  color: TeamlyColors.greenText
                      .withValues(alpha: 0.35 + 0.55 * _wave(i)),
                  shape: BoxShape.circle,
                ),
              ),
          ],
        );
      },
    );
  }

  double _wave(int i) {
    final t = (_c.value - i * 0.18) % 1.0;
    return t < 0.5 ? t * 2 : (1 - t) * 2;
  }
}

class _ComposerBar extends StatelessWidget {
  const _ComposerBar({
    required this.ctrl,
    required this.focus,
    required this.replyTo,
    required this.onChanged,
    required this.onCancelReply,
    required this.onSend,
  });

  final TextEditingController ctrl;
  final FocusNode focus;
  final DmMessage? replyTo;
  final ValueChanged<String> onChanged;
  final VoidCallback onCancelReply;
  final VoidCallback onSend;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final canSend = ctrl.text.trim().isNotEmpty;
    return Container(
      decoration: BoxDecoration(
        color: palette.surface,
        border: Border(top: BorderSide(color: palette.border)),
      ),
      child: SafeArea(
        top: false,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            if (replyTo != null)
              Container(
                padding: const EdgeInsets.fromLTRB(
                  TeamlySpace.s4, TeamlySpace.s2, TeamlySpace.s2, 0,
                ),
                child: Row(
                  children: <Widget>[
                    Expanded(
                      child: Container(
                        padding: const EdgeInsets.all(8),
                        decoration: BoxDecoration(
                          color: palette.chip,
                          borderRadius: BorderRadius.circular(8),
                          border: const Border(
                            left: BorderSide(
                              color: TeamlyColors.greenText,
                              width: 3,
                            ),
                          ),
                        ),
                        child: Text(
                          replyTo!.text,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 12.5,
                            color: TeamlyColors.ink700,
                          ),
                        ),
                      ),
                    ),
                    IconButton(
                      onPressed: onCancelReply,
                      icon: const Icon(
                        Icons.close_rounded,
                        size: 18,
                        color: TeamlyColors.ink500,
                      ),
                    ),
                  ],
                ),
              ),
            Padding(
              padding: const EdgeInsets.fromLTRB(
                TeamlySpace.s3, TeamlySpace.s2, TeamlySpace.s3, TeamlySpace.s2,
              ),
              child: Row(
                children: <Widget>[
                  Expanded(
                    child: TextField(
                      controller: ctrl,
                      focusNode: focus,
                      minLines: 1,
                      maxLines: 4,
                      textInputAction: TextInputAction.newline,
                      style: const TextStyle(
                        fontSize: 14.5,
                        color: TeamlyColors.ink900,
                      ),
                      decoration: InputDecoration(
                        isCollapsed: false,
                        contentPadding: const EdgeInsets.symmetric(
                          horizontal: 16,
                          vertical: 10,
                        ),
                        filled: true,
                        fillColor: palette.chip,
                        hintText: 'Message…',
                        hintStyle: const TextStyle(
                          color: TeamlyColors.ink300,
                          fontSize: 14,
                        ),
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(TeamlyRadius.lg),
                          borderSide: BorderSide.none,
                        ),
                      ),
                      onChanged: onChanged,
                    ),
                  ),
                  const SizedBox(width: TeamlySpace.s2),
                  GestureDetector(
                    onTap: canSend ? onSend : null,
                    child: Container(
                      width: 42,
                      height: 42,
                      decoration: BoxDecoration(
                        color: canSend ? palette.accent : palette.chip,
                        shape: BoxShape.circle,
                      ),
                      child: Icon(
                        Icons.send_rounded,
                        size: 20,
                        color: canSend ? palette.onAccent : TeamlyColors.ink300,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ── Shared bits ────────────────────────────────────────────────────────────────

class _ChatAvatar extends StatelessWidget {
  const _ChatAvatar({required this.photo, required this.name, required this.size});

  final String photo;
  final String name;
  final double size;

  @override
  Widget build(BuildContext context) {
    if (photo.isNotEmpty) {
      return ClipRRect(
        borderRadius: BorderRadius.circular(size),
        child: Image.network(
          photo,
          width: size,
          height: size,
          fit: BoxFit.cover,
          errorBuilder: (_, __, ___) => _initial(),
        ),
      );
    }
    return _initial();
  }

  Widget _initial() {
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: const Color(0xFFE8F3EE),
        shape: BoxShape.circle,
        border: Border.all(color: const Color(0xFFD3E6DD)),
      ),
      child: Text(
        (name.trim().isEmpty ? '?' : name.trim().substring(0, 1).toUpperCase()),
        style: const TextStyle(
          fontSize: 15,
          fontWeight: FontWeight.w700,
          color: Color(0xFF1A6B52),
        ),
      ),
    );
  }
}

class _EmptyThread extends StatelessWidget {
  const _EmptyThread();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(Icons.chat_bubble_outline_rounded, size: 40, color: context.palette.muted),
          const SizedBox(height: 12),
          const Text(
            'Say hi — this is the start of your conversation.',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 13.5, color: TeamlyColors.ink500),
          ),
        ],
      ),
    );
  }
}
