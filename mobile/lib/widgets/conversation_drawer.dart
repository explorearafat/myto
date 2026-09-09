import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/chat.dart';
import '../services/auth_service.dart';
import '../services/conversation_store.dart';
import '../theme.dart';
import 'sylor_star.dart';

/// The left drawer: a new-chat button, the saved conversation list, and the account footer.
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
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 14, 12, 6),
              child: Row(
                children: [
                  SylorStar(size: 24, color: palette.accent),
                  const SizedBox(width: 10),
                  Text(
                    'Sylor',
                    style: TextStyle(
                      color: palette.text,
                      fontSize: 18,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
              child: _NewChatButton(onTap: onNewChat, palette: palette),
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

  Widget _empty(SylorPalette palette) => Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(
            'Your conversations will appear here.',
            textAlign: TextAlign.center,
            style: TextStyle(color: palette.muted, fontSize: 14),
          ),
        ),
      );

  Widget _row(BuildContext context, SylorPalette palette, ConversationStore store, Conversation c) {
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

  Widget _account(BuildContext context, SylorPalette palette, AuthService auth) {
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

class _NewChatButton extends StatelessWidget {
  const _NewChatButton({required this.onTap, required this.palette});

  final VoidCallback onTap;
  final SylorPalette palette;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: palette.surface,
      borderRadius: BorderRadius.circular(12),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: palette.border),
          ),
          child: Row(
            children: [
              Icon(Icons.add_rounded, size: 20, color: palette.accent),
              const SizedBox(width: 10),
              Text(
                'New chat',
                style: TextStyle(color: palette.text, fontSize: 14, fontWeight: FontWeight.w600),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
