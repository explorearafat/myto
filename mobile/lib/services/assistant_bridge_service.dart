import 'dart:convert';

import 'package:http/http.dart' as http;

/// Talks to the Myto Assistant running on the user's PC over the LAN bridge.
///
/// The bridge is the Assistant pane's "Phone bridge" toggle: a token-guarded
/// HTTP server on the PC (Settings → Assistant). Every call carries
/// `x-myto-token`; drafts are composed on the PC with the user's tone and only
/// delivered after an explicit approve here.
class AssistantBridgeService {
  AssistantBridgeService({http.Client? client}) : _client = client ?? http.Client();

  final http.Client _client;

  static const Duration _timeout = Duration(seconds: 30);

  Uri _uri(String base, String path) {
    var b = base.trim();
    if (!b.startsWith('http')) b = 'http://$b';
    while (b.endsWith('/')) {
      b = b.substring(0, b.length - 1);
    }
    return Uri.parse('$b$path');
  }

  Map<String, String> _headers(String token) => {
        'x-myto-token': token,
        'Content-Type': 'application/json',
      };

  Future<Map<String, dynamic>> status(String base, String token) async {
    final r = await _client
        .get(_uri(base, '/status'), headers: _headers(token))
        .timeout(_timeout);
    return jsonDecode(r.body) as Map<String, dynamic>;
  }

  /// The current PC screen as base64 PNG (the phone can see what the assistant sees).
  Future<String?> screenshot(String base, String token) async {
    final r = await _client
        .get(_uri(base, '/screenshot'), headers: _headers(token))
        .timeout(_timeout);
    final body = jsonDecode(r.body) as Map<String, dynamic>;
    if (body['ok'] == true) return body['dataBase64'] as String?;
    return null;
  }

  /// Compose a tone-matched DRAFT on the PC — nothing is sent yet.
  Future<Map<String, dynamic>> compose(
    String base,
    String token, {
    required String contact,
    required String intent,
  }) async {
    final r = await _client
        .post(
          _uri(base, '/compose'),
          headers: _headers(token),
          body: jsonEncode({'contact': contact, 'intent': intent}),
        )
        .timeout(_timeout);
    return jsonDecode(r.body) as Map<String, dynamic>;
  }

  /// Deliver an APPROVED draft into the PC's chat window (paste + Enter).
  Future<Map<String, dynamic>> deliver(
    String base,
    String token, {
    required String text,
    String? windowTitle,
    bool pressEnter = true,
  }) async {
    final r = await _client
        .post(
          _uri(base, '/deliver'),
          headers: _headers(token),
          body: jsonEncode({
            'text': text,
            if (windowTitle != null && windowTitle.isNotEmpty) 'windowTitle': windowTitle,
            'pressEnter': pressEnter,
          }),
        )
        .timeout(_timeout);
    return jsonDecode(r.body) as Map<String, dynamic>;
  }
}
