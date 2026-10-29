import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../services/auth_service.dart';
import '../services/social_service.dart';
import '../theme.dart';
import 'discover_profile.dart' show DiscoverProfileSetup, DiscoverProfileView;

/// ---------------------------------------------------------------------------
/// ProfileScreen — the user's public Discover profile (setup flow when
/// absent, Instagram-style view once created, with working Edit profile),
/// plus one-tap access to the tools that used to be bottom-nav tabs
/// (Helper / Agents / Memory / Artifacts) and sign-out.
/// ---------------------------------------------------------------------------
class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key});

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  DiscoverProfile? _profile;
  bool _loaded = false;
  bool _editing = false;
  final Set<String> _savedIds = <String>{};

  User? get _user => FirebaseAuth.instance.currentUser;
  String get _uid => _user?.uid ?? '';

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    // Resilient on purpose: a failed lookup (offline, rules hiccup, expired
    // session) must never leave the screen on its loading spinner — which
    // read as a "blank profile page".
    try {
      if (_uid.isEmpty) {
        if (mounted) setState(() => _loaded = true);
        return;
      }
      final saved = await SocialService.listSavedIds(_uid);
      final p = await SocialService().getProfile(_uid);
      if (!mounted) return;
      setState(() {
        _savedIds.addAll(saved);
        _profile = p;
        _loaded = true;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() => _loaded = true);
    }
  }

  Future<void> _toast(String message) async {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message), duration: const Duration(seconds: 2)));
  }

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final name = _profile?.name ??
        _user?.displayName ??
        (context.read<AuthService>().displayName.isNotEmpty
            ? context.read<AuthService>().displayName
            : 'Myto user');
    return Scaffold(
      backgroundColor: palette.bg,
      appBar: AppBar(
        // The IG-style header: the username, centred.
        title: _editing || _profile == null
            ? const Text('Profile')
            : Text(
                '@${_profile!.username}',
                style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w800, color: TeamlyColors.ink900),
              ),
        centerTitle: true,
        actions: <Widget>[
          IconButton(
            tooltip: 'Sign out',
            icon: const Icon(Icons.logout_rounded, size: 20),
            onPressed: () async {
              final ok = await showDialog<bool>(
                context: context,
                builder: (ctx) => AlertDialog(
                  backgroundColor: palette.surface,
                  title: const Text('Sign out?'),
                  actions: <Widget>[
                    TextButton(
                      onPressed: () => Navigator.pop(ctx, false),
                      child: const Text('Cancel', style: TextStyle(color: TeamlyColors.ink500)),
                    ),
                    TextButton(
                      onPressed: () => Navigator.pop(ctx, true),
                      child: const Text('Sign out', style: TextStyle(color: TeamlyColors.danger)),
                    ),
                  ],
                ),
              );
              if (ok == true && context.mounted) {
                await context.read<AuthService>().signOut();
              }
            },
          ),
        ],
      ),
      body: !_loaded
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: () async {
                final p = await SocialService().getProfile(_uid);
                if (mounted) setState(() => _profile = p);
              },
              child: ListView(
                padding: const EdgeInsets.all(TeamlySpace.gutter),
                children: <Widget>[
                  if (_uid.isEmpty)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 60),
                      child: Column(
                        children: <Widget>[
                          const Icon(Icons.account_circle_outlined, size: 44, color: TeamlyColors.ink300),
                          const SizedBox(height: TeamlySpace.s3),
                          const Text(
                            'You are signed out',
                            style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: TeamlyColors.ink900),
                          ),
                          const SizedBox(height: 6),
                          const Text(
                            'Sign in again to see and edit your profile.',
                            style: TextStyle(fontSize: 13, color: TeamlyColors.ink500),
                          ),
                          const SizedBox(height: TeamlySpace.s3),
                          OutlinedButton(
                            onPressed: () async {
                              await context.read<AuthService>().signOut();
                            },
                            child: const Text('Go to sign in'),
                          ),
                        ],
                      ),
                    )
                  else if (_profile == null)
                    DiscoverProfileSetup(
                      uid: _uid,
                      defaultName: name,
                      defaultPhoto: _user?.photoURL ?? '',
                      onDone: (p) => setState(() => _profile = p),
                    )
                  else if (_editing)
                    DiscoverProfileSetup(
                      uid: _uid,
                      defaultName: name,
                      defaultPhoto: _user?.photoURL ?? '',
                      existing: _profile,
                      onDone: (p) => setState(() {
                        _profile = p;
                        _editing = false;
                      }),
                    )
                  else
                    DiscoverProfileView(
                      uid: _uid,
                      profile: _profile,
                      savedIds: _savedIds,
                      onUnsave: (id) async {
                        await SocialService.unsaveFromProfile(id, _uid);
                        if (!mounted) return;
                        setState(() => _savedIds.remove(id));
                        await _toast('Removed from your profile.');
                      },
                      onDelete: (id) async {
                        await SocialService.deletePost(id);
                        await _toast('Post deleted.');
                      },
                      onComment: (post, text) async {
                        await SocialService.addComment(
                          post.id,
                          uid: _uid,
                          name: _profile?.name ?? name,
                          photo: _user?.photoURL ?? '',
                          text: text,
                        );
                        await _toast('Comment added.');
                      },
                      onEdit: () => setState(() => _editing = true),
                    ),
                ],
              ),
            ),
    );
  }

}

