import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../models/chat.dart';

/// Holds the conversations and the active one, and persists them on-device with
/// shared_preferences (a single JSON blob). Kept dependency-light for v1. A chat is only
/// written into the list once it has its first message — until then it's a "New chat" draft.
class ConversationStore extends ChangeNotifier {
  static const String _key = 'sylor.conversations.v1';

  final List<Conversation> _conversations = [];
  List<Conversation> get conversations => List.unmodifiable(_conversations);

  Conversation _active = Conversation.create();
  Conversation get active => _active;

  SharedPreferences? _prefs;

  Future<void> load() async {
    _prefs = await SharedPreferences.getInstance();
    final raw = _prefs!.getString(_key);
    _conversations.clear();
    if (raw != null && raw.isNotEmpty) {
      try {
        final list = (jsonDecode(raw) as List).whereType<Map<String, dynamic>>();
        _conversations.addAll(list.map(Conversation.fromJson));
        _conversations.sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
      } catch (_) {
        /* corrupt store — start empty rather than crash */
      }
    }
    // Always open on a fresh draft, never resume the last chat. Previous chats stay in the
    // drawer's Recents; the app launches on a clean "New chat". Seed the draft's model from the
    // most-recent chat so the composer's model chip still shows a sensible default.
    _active = Conversation.create(
      modelId: _conversations.isNotEmpty ? _conversations.first.modelId : null,
    );
    notifyListeners();
  }

  bool get activeIsSaved => _conversations.any((c) => c.id == _active.id);

  void newChat({String? modelId}) {
    _active = Conversation.create(modelId: modelId ?? _active.modelId);
    notifyListeners();
  }

  void openConversation(String id) {
    for (final c in _conversations) {
      if (c.id == id) {
        _active = c;
        notifyListeners();
        return;
      }
    }
  }

  void setActiveModel(String modelId) {
    if (_active.modelId == modelId) return;
    _active.modelId = modelId;
    notifyListeners();
    if (activeIsSaved) _persist();
  }

  /// Append a message to the active chat, saving it into the list on the first message and
  /// keeping the most-recent chat on top. Call [touch] after streaming to persist the reply.
  void addMessage(ChatMessage message) {
    final wasSaved = activeIsSaved;
    _active.messages.add(message);
    _active.updatedAt = DateTime.now();
    if (!wasSaved) {
      _active.deriveTitleFromMessages();
      _conversations.insert(0, _active);
    } else {
      _bumpToTop(_active);
    }
    notifyListeners();
    _persist();
  }

  /// Persist after the active conversation mutated in place (streamed tokens finished).
  void touch() {
    _active.updatedAt = DateTime.now();
    if (activeIsSaved) {
      _bumpToTop(_active);
      _persist();
    }
    notifyListeners();
  }

  void delete(String id) {
    _conversations.removeWhere((c) => c.id == id);
    if (_active.id == id) {
      _active = _conversations.isNotEmpty ? _conversations.first : Conversation.create();
    }
    notifyListeners();
    _persist();
  }

  void _bumpToTop(Conversation c) {
    _conversations.removeWhere((x) => x.id == c.id);
    _conversations.insert(0, c);
  }

  Future<void> _persist() async {
    final prefs = _prefs;
    if (prefs == null) return;
    await prefs.setString(_key, jsonEncode(_conversations.map((c) => c.toJson()).toList()));
  }
}
