import 'oraculum_model.dart';

enum Role { user, assistant }

class ChatMessage {
  ChatMessage({required this.role, required this.content, DateTime? at})
      : at = at ?? DateTime.now();

  final Role role;
  String content;
  final DateTime at;

  bool get isUser => role == Role.user;

  Map<String, String> toWire() => {
        'role': role == Role.assistant ? 'assistant' : 'user',
        'content': content,
      };

  Map<String, dynamic> toJson() => {
        'role': role == Role.assistant ? 'assistant' : 'user',
        'content': content,
        'at': at.millisecondsSinceEpoch,
      };

  factory ChatMessage.fromJson(Map<String, dynamic> json) => ChatMessage(
        role: json['role'] == 'assistant' ? Role.assistant : Role.user,
        content: (json['content'] as String?) ?? '',
        at: DateTime.fromMillisecondsSinceEpoch(
          (json['at'] as num?)?.toInt() ?? DateTime.now().millisecondsSinceEpoch,
        ),
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
  })  : messages = messages ?? <ChatMessage>[],
        createdAt = createdAt ?? DateTime.now(),
        updatedAt = updatedAt ?? DateTime.now();

  final String id;
  String title;
  String modelId;
  final List<ChatMessage> messages;
  final DateTime createdAt;
  DateTime updatedAt;

  factory Conversation.create({String? modelId}) => Conversation(
        id: DateTime.now().microsecondsSinceEpoch.toRadixString(36),
        title: 'New chat',
        modelId: modelId ?? kDefaultModelId,
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
        'createdAt': createdAt.millisecondsSinceEpoch,
        'updatedAt': updatedAt.millisecondsSinceEpoch,
        'messages': messages.map((m) => m.toJson()).toList(),
      };

  factory Conversation.fromJson(Map<String, dynamic> json) => Conversation(
        id: (json['id'] as String?) ?? DateTime.now().microsecondsSinceEpoch.toRadixString(36),
        title: (json['title'] as String?) ?? 'New chat',
        modelId: (json['modelId'] as String?) ?? kDefaultModelId,
        createdAt: DateTime.fromMillisecondsSinceEpoch((json['createdAt'] as num?)?.toInt() ?? 0),
        updatedAt: DateTime.fromMillisecondsSinceEpoch((json['updatedAt'] as num?)?.toInt() ?? 0),
        messages: ((json['messages'] as List?) ?? const [])
            .whereType<Map<String, dynamic>>()
            .map(ChatMessage.fromJson)
            .toList(),
      );
}
