/// The user's bring-your-own-key chat configuration — their own OpenAI-compatible endpoint, API
/// key, and models. This is the Dart mirror of the web `src/shared/byok.ts` type. It is stored in
/// Firestore at users/{uid}/config/byok (owner-only) and written from the website's Authentication
/// page; the app reads it to know which models to offer and which endpoint to chat against.

class ByokModel {
  const ByokModel({required this.id, required this.name});

  final String id;
  final String name;

  factory ByokModel.fromJson(Map<String, dynamic> json) => ByokModel(
        id: (json['id'] as String?)?.trim() ?? '',
        name: (json['name'] as String?)?.trim() ?? '',
      );
}

class ByokConfig {
  const ByokConfig({
    required this.baseUrl,
    required this.apiKey,
    required this.authSchema,
    required this.authHeaderName,
    required this.models,
  });

  final String baseUrl;
  final String apiKey;

  /// 'bearer' | 'header' | 'none'.
  final String authSchema;
  final String authHeaderName;
  final List<ByokModel> models;

  static const empty = ByokConfig(
    baseUrl: '',
    apiKey: '',
    authSchema: 'bearer',
    authHeaderName: 'Authorization',
    models: [],
  );

  /// True when the config can actually drive a chat: a base URL and at least one model.
  bool get isConfigured => baseUrl.trim().isNotEmpty && models.isNotEmpty;

  factory ByokConfig.fromJson(Map<String, dynamic> json) {
    final schema = json['authSchema'];
    final rawModels = json['models'];
    return ByokConfig(
      baseUrl: (json['baseUrl'] as String?)?.trim() ?? '',
      apiKey: (json['apiKey'] as String?) ?? '',
      authSchema: (schema == 'header' || schema == 'none') ? schema as String : 'bearer',
      authHeaderName: ((json['authHeaderName'] as String?)?.trim().isNotEmpty ?? false)
          ? (json['authHeaderName'] as String).trim()
          : 'Authorization',
      models: rawModels is List
          ? rawModels
              .whereType<Map<String, dynamic>>()
              .map(ByokModel.fromJson)
              .where((m) => m.id.isNotEmpty)
              .toList()
          : const [],
    );
  }
}
