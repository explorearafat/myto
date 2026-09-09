import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

/// Where the streaming chat gateway lives — the same handler the website's /chat uses
/// (see api/chat.ts + src/server/gateway.ts). Native HTTP clients send no `Origin` header,
/// so the gateway's same-origin guard lets these requests through (a browser fetch would be
/// blocked, which is why this app targets mobile, not Flutter web).
const String kGatewayUrl = 'https://sylorcode.vercel.app/api/chat';

/// One event from the streaming reply.
sealed class ChatEvent {
  const ChatEvent();
}

class ChatToken extends ChatEvent {
  const ChatToken(this.text);
  final String text;
}

class ChatDone extends ChatEvent {
  const ChatDone(this.usage);
  final int? usage;
}

class ChatFailure extends ChatEvent {
  const ChatFailure(this.code, {this.resetSeconds});

  /// 'quota' | 'upstream' | 'network'.
  final String code;
  final int? resetSeconds;
}

/// Streams a chat completion from the gateway, re-emitting its tiny SSE protocol
/// (`data: {"t":"token"|"done"|"error", …}`) as [ChatEvent]s. This is the Dart mirror of the
/// browser client in src/lib/chatClient.ts. Call [abort] to cancel an in-flight request.
class ChatClient {
  http.Client? _client;
  bool _aborted = false;

  Stream<ChatEvent> send({
    required String model,
    required List<Map<String, String>> messages,
  }) async* {
    _aborted = false;
    final client = http.Client();
    _client = client;

    try {
      final request = http.Request('POST', Uri.parse(kGatewayUrl));
      request.headers['content-type'] = 'application/json';
      request.headers['accept'] = 'text/event-stream';
      request.body = jsonEncode({'model': model, 'messages': messages});

      final http.StreamedResponse response;
      try {
        response = await client.send(request);
      } catch (_) {
        if (_aborted) return;
        yield const ChatFailure('network');
        return;
      }

      if (response.statusCode == 429) {
        final body = await response.stream.bytesToString();
        int? reset;
        try {
          reset = ((jsonDecode(body) as Map<String, dynamic>)['resetSeconds'] as num?)?.toInt();
        } catch (_) {
          /* body wasn't JSON — leave reset null */
        }
        yield ChatFailure('quota', resetSeconds: reset);
        return;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        yield const ChatFailure('upstream');
        return;
      }

      var buffer = '';
      try {
        await for (final chunk in response.stream.transform(utf8.decoder)) {
          buffer += chunk;
          var idx = buffer.indexOf('\n\n');
          while (idx >= 0) {
            final raw = buffer.substring(0, idx).trim();
            buffer = buffer.substring(idx + 2);
            final event = _parseLine(raw);
            if (event != null) {
              yield event;
              if (event is ChatDone || event is ChatFailure) return;
            }
            idx = buffer.indexOf('\n\n');
          }
        }
      } catch (_) {
        if (_aborted) return;
        yield const ChatFailure('network');
        return;
      }

      yield const ChatDone(null);
    } finally {
      client.close();
      if (identical(_client, client)) _client = null;
    }
  }

  ChatEvent? _parseLine(String raw) {
    if (!raw.startsWith('data:')) return null;
    final line = raw.substring(5).trim();
    if (line.isEmpty) return null;
    try {
      final ev = jsonDecode(line) as Map<String, dynamic>;
      switch (ev['t']) {
        case 'token':
          final v = ev['v'];
          return (v is String && v.isNotEmpty) ? ChatToken(v) : null;
        case 'done':
          return ChatDone((ev['usage'] as num?)?.toInt());
        case 'error':
          return ChatFailure(
            (ev['code'] as String?) ?? 'upstream',
            resetSeconds: (ev['resetSeconds'] as num?)?.toInt(),
          );
      }
    } catch (_) {
      /* malformed event — skip it and keep reading */
    }
    return null;
  }

  /// Cancel the in-flight request (the composer's Stop button). Safe when nothing is streaming.
  void abort() {
    _aborted = true;
    _client?.close();
    _client = null;
  }
}
