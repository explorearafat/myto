import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/chat.dart';
import '../services/auth_service.dart';
import '../services/conversation_store.dart';
import '../theme.dart';
import 'myto_mark.dart';


class ConversationDrawer extends StatelessWidget {
  const ConversationDrawer({super.key, required this.onSelect, required this.onNewChat});

  final void Function(String id) onSelect;
  final VoidCallback onNewChat;

  @override
  Widget build(BuildContext context) {
    final palette = Theme.of(context).palette;
    final store = context.watch<ConversationStore>();
    final auth = context.watch<AuthService>();

    return Drawer(
      backgroundColor: palette.bg,
      child: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 14, 8, 6),
              child: Row(
                children: [
                  MytoMark(size: 24, color: palette.accent),
                  const SizedBox(width: 10),
                  Text(
                    'Myto',
                    style: TextStyle(
                      color: palette.text,
                      fontSize: 18,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const Spacer(),
                  IconButton(
                    icon: Icon(Icons.add_rounded, size: 22, color: palette.muted),
                    tooltip: 'New chat',
                    onPressed: onNewChat,
                  ),
                ],
              ),
            ),
            const SizedBox(height: 4),
            // Nav rows — icon + label, no border, no background (like Claude's left rail).
            // Only "Chats" exists on mobile today; the rest honestly say they aren't here yet.
            _navItem(context, palette, Icons.forum_outlined, 'Chats',
                active: true, onTap: () => Navigator.of(context).maybePop()),
            _navItem(context, palette, Icons.folder_outlined, 'Projects',
                onTap: () => _comingSoon(context, 'Projects')),
            _navItem(context, palette, Icons.terminal_rounded, 'Cowork',
                onTap: () => _comingSoon(context, 'Cowork')),
            _navItem(context, palette, Icons.widgets_outlined, 'Artifacts',
                onTap: () => _comingSoon(context, 'Artifacts')),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 10, 16, 8),
              child: Divider(height: 1, color: palette.border),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 16, 8),
              child: Text(
                'Recents',
                style: TextStyle(
                  color: palette.muted,
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  letterSpacing: 0.4,
                ),
              ),
            ),
            Expanded(
              child: store.conversations.isEmpty
                  ? _empty(palette)
                  : ListView.builder(
                      padding: const EdgeInsets.symmetric(horizontal: 8),
                      itemCount: store.conversations.length,
                      itemBuilder: (context, i) =>
                          _row(context, palette, store, store.conversations[i]),
                    ),
            ),
            Divider(height: 1, color: palette.border),
            _account(context, palette, auth),
          ],
        ),
      ),
    );
  }

  Widget _navItem(
    BuildContext context,
    MytoPalette palette,
    IconData icon,
    String label, {
    bool active = false,
    required VoidCallback onTap,
  }) {
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
        child: Row(
          children: [
            Icon(icon, size: 20, color: active ? palette.accent : palette.muted),
            const SizedBox(width: 14),
            Text(
              label,
              style: TextStyle(
                color: active ? palette.text : palette.text.withValues(alpha: 0.86),
                fontSize: 15,
                fontWeight: active ? FontWeight.w600 : FontWeight.w500,
              ),
            ),
          ],
        ),
      ),
    );
  }

  void _comingSoon(BuildContext context, String feature) {
    final messenger = ScaffoldMessenger.of(context);
    Navigator.of(context).maybePop();
    messenger.showSnackBar(
      SnackBar(content: Text('$feature isn\'t on mobile yet — use the desktop app.')),
    );
  }

  Widget _empty(MytoPalette palette) => Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(
            'Your conversations will appear here.',
            textAlign: TextAlign.center,
            style: TextStyle(color: palette.muted, fontSize: 14),
          ),
        ),
      );

  Widget _row(BuildContext context, MytoPalette palette, ConversationStore store, Conversation c) {
    final active = store.active.id == c.id;
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 2),
      decoration: BoxDecoration(
        color: active ? palette.surface2 : Colors.transparent,
        borderRadius: BorderRadius.circular(10),
      ),
      child: ListTile(
        dense: true,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
        title: Text(
          c.title,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(
            color: palette.text,
            fontSize: 14,
            fontWeight: active ? FontWeight.w600 : FontWeight.w400,
          ),
        ),
        trailing: IconButton(
          icon: Icon(Icons.delete_outline_rounded, size: 18, color: palette.muted),
          tooltip: 'Delete',
          onPressed: () => _confirmDelete(context, store, c),
        ),
        onTap: () => onSelect(c.id),
      ),
    );
  }

  Future<void> _confirmDelete(BuildContext context, ConversationStore store, Conversation c) async {
    final palette = Theme.of(context).palette;
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        backgroundColor: palette.surface,
        title: Text('Delete chat?', style: TextStyle(color: palette.text)),
        content: Text(
          'This removes "${c.title}" from this device.',
          style: TextStyle(color: palette.muted),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: Text('Cancel', style: TextStyle(color: palette.muted)),
          ),
          TextButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: Text('Delete', style: TextStyle(color: palette.accent)),
          ),
        ],
      ),
    );
    if (ok == true) store.delete(c.id);
  }

  Widget _account(BuildContext context, MytoPalette palette, AuthService auth) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
      child: Row(
        children: [
          CircleAvatar(
            radius: 16,
            backgroundColor: palette.surface2,
            backgroundImage: auth.photoURL != null ? NetworkImage(auth.photoURL!) : null,
            child: auth.photoURL == null
                ? Text(_initial(auth.displayName), style: TextStyle(color: palette.text, fontSize: 14))
                : null,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  auth.displayName,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(color: palette.text, fontSize: 14, fontWeight: FontWeight.w600),
                ),
                if (auth.email != null)
                  Text(
                    auth.email!,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(color: palette.muted, fontSize: 12),
                  ),
              ],
            ),
          ),
          IconButton(
            icon: Icon(Icons.logout_rounded, size: 20, color: palette.muted),
            tooltip: auth.user != null ? 'Sign out' : 'Exit guest',
            onPressed: auth.signOut,
          ),
        ],
      ),
    );
  }

  String _initial(String name) {
    final t = name.trim();
    return t.isEmpty ? '?' : t.substring(0, 1).toUpperCase();
  }
}
