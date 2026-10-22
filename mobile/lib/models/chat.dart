enum Role { user, assistant }

class ChatMessage {
  ChatMessage({required this.role, required this.content, DateTime? at, this.senderName})
      : at = at ?? DateTime.now();

  final Role role;
  String content;
  final DateTime at;

  /// Who produced this message. Null for plain Myto chats; set to an agent's
  /// name inside a room discussion so the bubble can label each speaker.
  final String? senderName;

  bool get isUser => role == Role.user;

  Map<String, String> toWire() => {
        'role': role == Role.assistant ? 'assistant' : 'user',
        'content': content,
      };

  Map<String, dynamic> toJson() => {
        'role': role == Role.assistant ? 'assistant' : 'user',
        'content': content,
        'at': at.millisecondsSinceEpoch,
        if (senderName != null) 'sender': senderName,
      };

  factory ChatMessage.fromJson(Map<String, dynamic> json) => ChatMessage(
        role: json['role'] == 'assistant' ? Role.assistant : Role.user,
        content: (json['content'] as String?) ?? '',
        at: DateTime.fromMillisecondsSinceEpoch(
          (json['at'] as num?)?.toInt() ?? DateTime.now().millisecondsSinceEpoch,
        ),
        senderName: (json['sender'] as String?) ?? (json['senderName'] as String?),
      );
}

class Conversation {
  Conversation({
    required this.id,
    required this.title,
    required this.modelId,
    List<ChatMessage>? messages,
    DateTime? createdAt,
    DateTime? updatedAt,
    this.channel,
  })  : messages = messages ?? <ChatMessage>[],
        createdAt = createdAt ?? DateTime.now(),
        updatedAt = updatedAt ?? DateTime.now();

  final String id;
  String title;
  String modelId;

  /// Route marker that tells the chat list how to reopen this thread:
  /// `agent:<id>` → the 1-to-1 chat with that roster agent,
  /// `room:<id>`  → the group research room, null → the plain Myto chat.
  String? channel;
  final List<ChatMessage> messages;
  final DateTime createdAt;
  DateTime updatedAt;

  factory Conversation.create({String? modelId, String? channel}) => Conversation(
        id: DateTime.now().microsecondsSinceEpoch.toRadixString(36),
        title: 'New chat',
        // Empty until the account's models load; the send path resolves it to a real model id.
        modelId: modelId ?? '',
        channel: channel,
      );

  void deriveTitleFromMessages() {
    ChatMessage? firstUser;
    for (final m in messages) {
      if (m.isUser) {
        firstUser = m;
        break;
      }
    }
    if (firstUser == null) return;
    final text = firstUser.content.trim().replaceAll(RegExp(r'\s+'), ' ');
    if (text.isEmpty) return;
    title = text.length <= 40 ? text : '${text.substring(0, 40).trimRight()}…';
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'title': title,
        'modelId': modelId,
        'channel': channel,
        'createdAt': createdAt.millisecondsSinceEpoch,
        'updatedAt': updatedAt.millisecondsSinceEpoch,
        'messages': messages.map((m) => m.toJson()).toList(),
      };

  factory Conversation.fromJson(Map<String, dynamic> json) => Conversation(
        id: (json['id'] as String?) ?? DateTime.now().microsecondsSinceEpoch.toRadixString(36),
        title: (json['title'] as String?) ?? 'New chat',
        modelId: (json['modelId'] as String?) ?? '',
        channel: (json['channel'] as String?),
        createdAt: DateTime.fromMillisecondsSinceEpoch((json['createdAt'] as num?)?.toInt() ?? 0),
        updatedAt: DateTime.fromMillisecondsSinceEpoch((json['updatedAt'] as num?)?.toInt() ?? 0),
        messages: ((json['messages'] as List?) ?? const [])
            .whereType<Map<String, dynamic>>()
            .map(ChatMessage.fromJson)
            .toList(),
      );
}
