import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../models/byok_config.dart';
import '../services/auth_service.dart';
import '../services/byok_service.dart';
import '../services/conversation_store.dart';
import '../theme.dart';
import '../widgets/teamly/kit.dart';

/// ---------------------------------------------------------------------------
/// SettingsScreen — opened from the Artifacts tab's gear. Two sections, every
/// control wired to real behavior:
///
///   Social media — which notifications reach you (the NotificationService
///   reads these toggles live) + your account row.
///   AI app — local chat storage controls and the AI key status synced from
///   your account (BYOK).
/// ---------------------------------------------------------------------------
class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  String _selectedModel = '';
  bool _likes = true;
  bool _comments = true;
  bool _shares = true;
  bool _posts = true;
  bool _dms = true;
  bool _loaded = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final prefs = await SharedPreferences.getInstance();
    if (!mounted) return;
    setState(() {
      _selectedModel = prefs.getString('sylor.chat.model') ?? '';
      _likes = prefs.getBool('sylor.notify.like') ?? true;
      _comments = prefs.getBool('sylor.notify.comment') ?? true;
      _shares = prefs.getBool('sylor.notify.share') ?? true;
      _posts = prefs.getBool('sylor.notify.post') ?? true;
      _dms = prefs.getBool('sylor.notify.dm') ?? true;
      _loaded = true;
    });
  }

  Future<void> _setToggle(String kind, bool value) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool('sylor.notify.$kind', value);
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final user = FirebaseAuth.instance.currentUser;

    return Scaffold(
      backgroundColor: palette.bg,
      appBar: AppBar(title: const Text('Settings')),
      body: !_loaded
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.all(TeamlySpace.gutter),
              children: <Widget>[
                // ── Social media ────────────────────────────────────────────
                const TeamlyGroupHeader(label: 'SOCIAL MEDIA'),
                Text(
                  'Choose what reaches your notifications.',
                  style: const TextStyle(fontSize: 12.5, color: TeamlyColors.ink500),
                ),
                const SizedBox(height: TeamlySpace.s2),
                _SwitchTile(
                  icon: Icons.favorite_rounded,
                  color: TeamlyColors.danger,
                  title: 'Likes on my posts',
                  value: _likes,
                  onChanged: (v) => _setToggle('like', v),
                ),
                _SwitchTile(
                  icon: Icons.chat_bubble_rounded,
                  color: TeamlyColors.greenText,
                  title: 'Comments on my posts',
                  value: _comments,
                  onChanged: (v) => _setToggle('comment', v),
                ),
                _SwitchTile(
                  icon: Icons.repeat_rounded,
                  color: TeamlyColors.ink700,
                  title: 'Shares of my posts',
                  value: _shares,
                  onChanged: (v) => _setToggle('share', v),
                ),
                _SwitchTile(
                  icon: Icons.edit_note_rounded,
                  color: TeamlyColors.greenText,
                  title: 'New posts from people I follow',
                  value: _posts,
                  onChanged: (v) => _setToggle('post', v),
                ),
                _SwitchTile(
                  icon: Icons.chat_bubble_rounded,
                  color: TeamlyColors.ink700,
                  title: 'Direct messages',
                  value: _dms,
                  onChanged: (v) => _setToggle('dm', v),
                ),
                const SizedBox(height: TeamlySpace.s2),
                TeamlyCard(
                  padding: const EdgeInsets.all(TeamlySpace.s4),
                  child: Row(
                    children: <Widget>[
                      _AccountAvatar(photo: user?.photoURL ?? '', name: user?.displayName ?? 'You'),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: <Widget>[
                            Text(
                              (user?.displayName ?? '').trim().isEmpty
                                  ? 'Myto user'
                                  : user!.displayName!,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                fontSize: 14.5,
                                fontWeight: FontWeight.w700,
                                color: TeamlyColors.ink900,
                              ),
                            ),
                            Text(
                              user?.email ?? 'Signed in',
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(fontSize: 12.5, color: TeamlyColors.ink500),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: TeamlySpace.s4),

                // ── AI app ──────────────────────────────────────────────────
                const TeamlyGroupHeader(label: 'AI APP'),
                const SizedBox(height: TeamlySpace.s2),
                _WorkingModelSection(
                  selected: _selectedModel,
                  onPicked: (id) async {
                    final prefs = await SharedPreferences.getInstance();
                    await prefs.setString('sylor.chat.model', id);
                    if (!mounted) return;
                    setState(() => _selectedModel = id);
                  },
                ),
                const SizedBox(height: TeamlySpace.s2),
                TeamlyCard(
                  padding: const EdgeInsets.all(TeamlySpace.s4),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Row(
                        children: <Widget>[
                          const Icon(Icons.vpn_key_rounded, size: 18, color: TeamlyColors.greenText),
                          const SizedBox(width: 8),
                          const Expanded(
                            child: Text(
                              'AI model keys',
                              style: TextStyle(
                                fontSize: 14.5,
                                fontWeight: FontWeight.w700,
                                color: TeamlyColors.ink900,
                              ),
                            ),
                          ),
                          _ByKeyStatus(),
                        ],
                      ),
                      const SizedBox(height: 6),
                      const Text(
                        'Your own provider keys sync from your account '
                        '(mytocode.vercel.app/authentication). The chat uses them automatically.',
                        style: TextStyle(fontSize: 12.5, height: 1.45, color: TeamlyColors.ink500),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: TeamlySpace.s2),
                TeamlyCard(
                  onTap: () => _confirmClearChats(context),
                  padding: const EdgeInsets.all(TeamlySpace.s4),
                  child: Row(
                    children: <Widget>[
                      const Icon(Icons.delete_sweep_rounded, size: 18, color: TeamlyColors.danger),
                      const SizedBox(width: 8),
                      const Expanded(
                        child: Text(
                          'Clear local AI chat history',
                          style: TextStyle(
                            fontSize: 14.5,
                            fontWeight: FontWeight.w700,
                            color: TeamlyColors.ink900,
                          ),
                        ),
                      ),
                      const Icon(Icons.chevron_right_rounded, size: 20, color: TeamlyColors.ink300),
                    ],
                  ),
                ),
                const SizedBox(height: TeamlySpace.s2),
                Text(
                  'Chats are stored on this device. Clearing removes every saved AI conversation here '
                  '(community posts and messages are not affected).',
                  style: const TextStyle(fontSize: 12, height: 1.45, color: TeamlyColors.ink300),
                ),
                const SizedBox(height: TeamlySpace.s4),
                Center(
                  child: TextButton(
                    onPressed: () => context.read<AuthService>().signOut(),
                    child: const Text('Sign out of Myto', style: TextStyle(color: TeamlyColors.danger)),
                  ),
                ),
              ],
            ),
    );
  }

  Future<void> _confirmClearChats(BuildContext context) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        backgroundColor: context.palette.surface,
        title: const Text('Clear chat history?'),
        content: const Text(
          'Every saved AI conversation on this device will be deleted. This cannot be undone.',
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel', style: TextStyle(color: TeamlyColors.ink500)),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Clear', style: TextStyle(color: TeamlyColors.danger)),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    context.read<ConversationStore>().clearAll();
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(const SnackBar(content: Text('Local AI chat history cleared.')));
  }
}

/// The chat's working model: every model from the user's synced AI config,
/// with the picked one checked. Agent and group chats stream from it.
class _WorkingModelSection extends StatelessWidget {
  const _WorkingModelSection({required this.selected, required this.onPicked});

  final String selected;
  final ValueChanged<String> onPicked;

  @override
  Widget build(BuildContext context) {
    final config = context.watch<ByokService>().config ?? ByokConfig.empty;
    final models = config.models;
    return TeamlyCard(
      padding: const EdgeInsets.all(TeamlySpace.s4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              const Icon(Icons.memory_rounded, size: 18, color: TeamlyColors.greenText),
              const SizedBox(width: 8),
              const Expanded(
                child: Text(
                  'Working model',
                  style: TextStyle(
                    fontSize: 14.5,
                    fontWeight: FontWeight.w700,
                    color: TeamlyColors.ink900,
                  ),
                ),
              ),
              Text(
                _currentLabel(config),
                style: const TextStyle(fontSize: 12, color: TeamlyColors.ink500),
              ),
            ],
          ),
          const SizedBox(height: 4),
          if (!config.isConfigured)
            const Text(
              'No AI keys yet — add them at mytocode.vercel.app/authentication and the '
              'available models will show up here.',
              style: TextStyle(fontSize: 12.5, height: 1.45, color: TeamlyColors.ink500),
            )
          else
            for (final m in models)
              InkWell(
                onTap: () => onPicked(m.id),
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 7),
                  child: Row(
                    children: <Widget>[
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: <Widget>[
                            Text(
                              m.name.isEmpty ? m.id : m.name,
                              style: const TextStyle(
                                fontSize: 14,
                                fontWeight: FontWeight.w600,
                                color: TeamlyColors.ink900,
                              ),
                            ),
                            if (m.name.isNotEmpty && m.id != m.id)
                              Text(
                                m.id,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(fontSize: 11.5, color: TeamlyColors.ink300),
                              ),
                          ],
                        ),
                      ),
                      Icon(
                        _isSelected(config, m)
                            ? Icons.check_circle_rounded
                            : Icons.radio_button_unchecked_rounded,
                        size: 20,
                        color: _isSelected(config, m)
                            ? TeamlyColors.green500
                            : TeamlyColors.ink300,
                      ),
                    ],
                  ),
                ),
              ),
        ],
      ),
    );
  }

  bool _isSelected(ByokConfig config, ByokModel m) {
    if (selected.isNotEmpty) return m.id == selected;
    return config.models.isNotEmpty && config.models.first.id == m.id;
  }

  String _currentLabel(ByokConfig config) {
    if (config.models.isEmpty) return 'no models';
    if (selected.isNotEmpty) {
      for (final m in config.models) {
        if (m.id == selected) return m.name.isEmpty ? m.id : m.name;
      }
    }
    return config.models.first.name.isEmpty
        ? config.models.first.id
        : config.models.first.name;
  }
}

class _SwitchTile extends StatelessWidget {
  const _SwitchTile({
    required this.icon,
    required this.color,
    required this.title,
    required this.value,
    required this.onChanged,
  });

  final IconData icon;
  final Color color;
  final String title;
  final bool value;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    return TeamlyCard(
      padding: const EdgeInsets.fromLTRB(TeamlySpace.s4, 10, TeamlySpace.s2, 10),
      child: Row(
        children: <Widget>[
          Icon(icon, size: 18, color: color),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              title,
              style: const TextStyle(
                fontSize: 14.5,
                fontWeight: FontWeight.w600,
                color: TeamlyColors.ink900,
              ),
            ),
          ),
          Switch(value: value, onChanged: onChanged, activeThumbColor: TeamlyColors.green500),
        ],
      ),
    );
  }
}

class _AccountAvatar extends StatelessWidget {
  const _AccountAvatar({required this.photo, required this.name});

  final String photo;
  final String name;

  @override
  Widget build(BuildContext context) {
    if (photo.isNotEmpty) {
      return ClipOval(
        child: Image.network(
          photo,
          width: 42,
          height: 42,
          fit: BoxFit.cover,
          errorBuilder: (_, __, ___) => _initial(context),
        ),
      );
    }
    return _initial(context);
  }

  Widget _initial(BuildContext context) {
    return CircleAvatar(
      radius: 21,
      backgroundColor: context.palette.pastel(1),
      child: Text(
        name.trim().isEmpty ? '?' : name.trim().substring(0, 1).toUpperCase(),
        style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w800, color: TeamlyColors.ink800),
      ),
    );
  }
}

/// Live read of whether the user has their own AI keys synced (BYOK).
class _ByKeyStatus extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final configured = context.watch<ByokService>().isConfigured;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Container(
          width: 8,
          height: 8,
          decoration: BoxDecoration(
            color: configured ? TeamlyColors.green500 : TeamlyColors.ink300,
            shape: BoxShape.circle,
          ),
        ),
        const SizedBox(width: 6),
        Text(
          configured ? 'Connected' : 'Not set',
          style: const TextStyle(fontSize: 12.5, color: TeamlyColors.ink500),
        ),
      ],
    );
  }
}
