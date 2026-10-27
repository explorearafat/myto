import 'dart:async';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';

import '../services/social_service.dart';
import '../theme.dart';
import '../widgets/teamly/kit.dart';

/// ---------------------------------------------------------------------------
/// PostComposerPage — the full-screen composer behind the nav's center Post
/// button: text, topic chips, link preview, then createPost.
/// ---------------------------------------------------------------------------
class PostComposerPage extends StatefulWidget {
  const PostComposerPage({super.key, required this.onPosted});

  final VoidCallback onPosted;

  @override
  State<PostComposerPage> createState() => _PostComposerPageState();
}

class _PostComposerPageState extends State<PostComposerPage> {
  final TextEditingController _ctrl = TextEditingController();
  final FocusNode _focus = FocusNode();
  bool _busy = false;
  String _error = '';
  final List<String> _topics = <String>[];
  Map<String, String>? _meta;
  Timer? _debounce;
  String _lastUrl = '';

  @override
  void dispose() {
    _debounce?.cancel();
    _ctrl.dispose();
    _focus.dispose();
    super.dispose();
  }

  void _onTextChanged(String value) {
    final url = SocialService.firstUrl(value);
    if (url == null) {
      _debounce?.cancel();
      if (_meta != null) setState(() => _meta = null);
      _lastUrl = '';
      return;
    }
    if (url == _lastUrl) return;
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 700), () async {
      _lastUrl = url;
      final meta = await SocialService.fetchLinkMeta(url);
      if (!mounted) return;
      setState(() => _meta = <String, String>{'url': url, ...meta});
    });
  }

  Future<void> _post() async {
    final text = _ctrl.text.trim();
    final user = FirebaseAuth.instance.currentUser;
    if (text.isEmpty || _busy || user == null) return;
    setState(() {
      _busy = true;
      _error = '';
    });
    try {
      final url = _meta?['url'] ?? SocialService.firstUrl(text) ?? '';
      await SocialService.createPost(
        uid: user.uid,
        name: _authorName,
        photo: _authorPhoto,
        text: text,
        topics: _topics,
        link: url,
        linkMeta: _meta ?? const <String, String>{},
      );
      if (mounted) Navigator.of(context).pop();
      widget.onPosted();
    } on FirebaseException catch (e) {
      if (mounted) {
        setState(() {
          _error = e.code.contains('permission-denied')
              ? 'Sign in (and set up a profile) to post.'
              : 'Could not post. Try again.';
        });
      }
    } catch (_) {
      if (mounted) setState(() => _error = 'Could not post. Try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  String get _authorName {
    final u = FirebaseAuth.instance.currentUser;
    return (u?.displayName?.trim().isNotEmpty ?? false) ? u!.displayName!.trim() : 'Anonymous';
  }

  String get _authorPhoto => FirebaseAuth.instance.currentUser?.photoURL ?? '';

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final remaining = SocialService.maxPostChars - _ctrl.text.length;
    final canPost = _ctrl.text.trim().isNotEmpty &&
        remaining >= 0 &&
        !_busy &&
        FirebaseAuth.instance.currentUser != null;

    return Scaffold(
      backgroundColor: palette.bg,
      appBar: AppBar(
        leading: IconButton(
          icon: const Icon(Icons.close_rounded),
          onPressed: () => Navigator.of(context).pop(),
        ),
        title: const Text('New post'),
        actions: <Widget>[
          Padding(
            padding: const EdgeInsets.only(right: TeamlySpace.s4),
            child: Center(
              child: GestureDetector(
                onTap: canPost ? _post : null,
                child: Container(
                  height: 34,
                  padding: const EdgeInsets.symmetric(horizontal: 18),
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: canPost ? palette.accent : palette.chip,
                    borderRadius: BorderRadius.circular(TeamlyRadius.pill),
                  ),
                  child: Text(
                    _busy ? 'Posting…' : 'Post',
                    style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                      color: canPost ? palette.onAccent : TeamlyColors.ink300,
                    ),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(TeamlySpace.gutter),
        children: <Widget>[
          Row(
            children: <Widget>[
              _ComposerAvatar(photo: _authorPhoto, name: _authorName),
              const SizedBox(width: TeamlySpace.s3),
              Text(
                _authorName,
                style: const TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.w700,
                  color: TeamlyColors.ink900,
                ),
              ),
            ],
          ),
          const SizedBox(height: TeamlySpace.s3),
          TextField(
            controller: _ctrl,
            focusNode: _focus,
            autofocus: true,
            minLines: 5,
            maxLines: 10,
            maxLength: SocialService.maxPostChars + 50,
            style: const TextStyle(fontSize: 15.5, height: 1.45, color: TeamlyColors.ink900),
            decoration: const InputDecoration(
              border: InputBorder.none,
              hintText: 'Share something about AI, Myto, crypto…\nPaste a link and its preview shows up.',
              hintStyle: TextStyle(color: TeamlyColors.ink300, fontSize: 15, height: 1.45),
            ),
            onChanged: (v) {
              setState(() {});
              _onTextChanged(v);
            },
          ),
          Wrap(
            spacing: 6,
            children: <Widget>[
              for (final t in kDiscoverTopics)
                GestureDetector(
                  onTap: () => setState(() {
                    _topics.contains(t) ? _topics.remove(t) : _topics.add(t);
                    if (_topics.length > 4) _topics.removeAt(0);
                  }),
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                    decoration: BoxDecoration(
                      color: _topics.contains(t) ? palette.accent : palette.chip,
                      borderRadius: BorderRadius.circular(TeamlyRadius.pill),
                    ),
                    child: Text(
                      '#$t',
                      style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                        color: _topics.contains(t) ? palette.onAccent : TeamlyColors.ink700,
                      ),
                    ),
                  ),
                ),
            ],
          ),
          if (_meta != null && (_meta!['title']!.isNotEmpty || _meta!['image']!.isNotEmpty))
            Container(
              margin: const EdgeInsets.only(top: TeamlySpace.s3),
              padding: const EdgeInsets.all(TeamlySpace.s3),
              decoration: BoxDecoration(
                color: palette.chip,
                borderRadius: BorderRadius.circular(TeamlyRadius.md),
              ),
              child: Row(
                children: <Widget>[
                  if (_meta!['image']!.isNotEmpty)
                    ClipRRect(
                      borderRadius: BorderRadius.circular(TeamlyRadius.sm),
                      child: Image.network(
                        _meta!['image']!,
                        width: 64,
                        height: 46,
                        fit: BoxFit.cover,
                        errorBuilder: (_, __, ___) => const SizedBox(width: 64, height: 46),
                      ),
                    ),
                  const SizedBox(width: TeamlySpace.s3),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Text(
                          _meta!['title']!.isEmpty ? _meta!['url']! : _meta!['title']!,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 13,
                            fontWeight: FontWeight.w600,
                            color: TeamlyColors.ink900,
                          ),
                        ),
                        Text(
                          _meta!['site']!.isEmpty ? _meta!['url']! : _meta!['site']!,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontSize: 11.5, color: TeamlyColors.ink500),
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    visualDensity: VisualDensity.compact,
                    onPressed: () => setState(() {
                      _ctrl.text = _ctrl.text.replaceFirst(_meta?['url'] ?? '', '').trim();
                      _meta = null;
                      _lastUrl = '';
                    }),
                    icon: const Icon(Icons.close_rounded, size: 16, color: TeamlyColors.ink500),
                  ),
                ],
              ),
            ),
          const SizedBox(height: TeamlySpace.s2),
          Row(
            children: <Widget>[
              const Spacer(),
              Text(
                '${remaining.clamp(0, SocialService.maxPostChars)} / ${SocialService.maxPostChars}',
                style: TextStyle(
                  fontSize: 11.5,
                  fontFamily: 'monospace',
                  color: remaining < 0 ? TeamlyColors.danger : TeamlyColors.ink300,
                ),
              ),
            ],
          ),
          if (_error.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: TeamlySpace.s2),
              child: Text(_error, style: const TextStyle(color: TeamlyColors.danger, fontSize: 12.5)),
            ),
        ],
      ),
    );
  }
}

class _ComposerAvatar extends StatelessWidget {
  const _ComposerAvatar({required this.photo, required this.name});

  final String photo;
  final String name;

  @override
  Widget build(BuildContext context) {
    if (photo.isNotEmpty) {
      return ClipRRect(
        borderRadius: BorderRadius.circular(20),
        child: Image.network(
          photo,
          width: 40,
          height: 40,
          fit: BoxFit.cover,
          errorBuilder: (_, __, ___) => _initial(),
        ),
      );
    }
    return _initial();
  }

  Widget _initial() {
    return Container(
      width: 40,
      height: 40,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: const Color(0xFFE8F3EE),
        shape: BoxShape.circle,
        border: Border.all(color: const Color(0xFFD3E6DD)),
      ),
      child: Text(
        (name.trim().isEmpty ? '?' : name.trim().substring(0, 1).toUpperCase()),
        style: const TextStyle(
          fontSize: 16,
          fontWeight: FontWeight.w700,
          color: Color(0xFF1A6B52),
        ),
      ),
    );
  }
}
