import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../services/auth_service.dart';
import '../services/social_service.dart';
import '../theme.dart';
import '../widgets/teamly/kit.dart';
import 'agents_screen.dart';
import 'artifacts_screen.dart';
import 'assistant_screen.dart';
import 'chat_screen.dart';
import 'discover_profile.dart' show DiscoverProfileSetup, DiscoverProfileView;
import 'memory_screen.dart';

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
    if (_uid.isEmpty) return;
    final saved = await SocialService.listSavedIds(_uid);
    final p = await SocialService().getProfile(_uid);
    if (!mounted) return;
    setState(() {
      _savedIds.addAll(saved);
      _profile = p;
      _loaded = true;
    });
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
                  if (_profile == null)
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
                  if (!_editing) ...<Widget>[
                    const SizedBox(height: TeamlySpace.s5),
                    const TeamlyGroupHeader(label: 'Myto tools'),
                    const SizedBox(height: TeamlySpace.s2),
                    _ToolTile(
                      icon: Icons.chat_bubble_outline_rounded,
                      title: 'AI Chat',
                      subtitle: 'Talk with your models',
                      onTap: () => _push(const ChatScreen()),
                    ),
                    _ToolTile(
                      icon: Icons.assistant_outlined,
                      title: 'Helper',
                      subtitle: 'Your AI assistant',
                      onTap: () => _push(const AssistantScreen()),
                    ),
                    _ToolTile(
                      icon: Icons.smart_toy_outlined,
                      title: 'Agents',
                      subtitle: 'Create and run agents',
                      onTap: () => _push(const AgentsScreen()),
                    ),
                    _ToolTile(
                      icon: Icons.psychology_outlined,
                      title: 'Memory',
                      subtitle: 'What Myto remembers',
                      onTap: () => _push(const MemoryScreen()),
                    ),
                    _ToolTile(
                      icon: Icons.layers_outlined,
                      title: 'Artifacts',
                      subtitle: 'Generated media & files',
                      onTap: () => _push(const ArtifactsScreen()),
                    ),
                  ],
                ],
              ),
            ),
    );
  }

  void _push(Widget screen) {
    Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => screen));
  }
}

class _ToolTile extends StatelessWidget {
  const _ToolTile({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.onTap,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return Padding(
      padding: const EdgeInsets.only(bottom: TeamlySpace.s2),
      child: TeamlyCard(
        onTap: onTap,
        padding: const EdgeInsets.all(TeamlySpace.s3),
        child: Row(
          children: <Widget>[
            Container(
              width: 40,
              height: 40,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: palette.tagBg,
                borderRadius: BorderRadius.circular(TeamlyRadius.sm),
              ),
              child: Icon(icon, size: 20, color: palette.tagFg),
            ),
            const SizedBox(width: TeamlySpace.s3),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    title,
                    style: const TextStyle(
                      fontSize: 14.5,
                      fontWeight: FontWeight.w700,
                      color: TeamlyColors.ink900,
                    ),
                  ),
                  Text(
                    subtitle,
                    style: const TextStyle(fontSize: 12.5, color: TeamlyColors.ink500),
                  ),
                ],
              ),
            ),
            Icon(Icons.chevron_right_rounded, size: 20, color: palette.muted),
          ],
        ),
      ),
    );
  }
}
