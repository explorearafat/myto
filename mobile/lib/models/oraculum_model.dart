/// The two models a Sylor user can pick, mirrored from the website's shared/models.ts.
///
/// These are *facade* identities: server-side, both route across the same pool of real
/// upstream models with failover — the names are branding only. This is the single client
/// source of truth for the picker and for the id we send to the gateway.
class OraculumModel {
  const OraculumModel({required this.id, required this.name, required this.blurb});

  /// The id sent to the gateway and validated there.
  final String id;

  /// Display name shown in the picker and app bar.
  final String name;

  /// One-line description under the name.
  final String blurb;
}

const List<OraculumModel> kOraculumModels = <OraculumModel>[
  OraculumModel(
    id: 'sylor-oraculum-aeon200B',
    name: 'Oraculum Thinking',
    blurb: 'Deliberate, step-by-step reasoning',
  ),
  OraculumModel(
    id: 'sylor-oraculum-aeon1.0-230B',
    name: 'Oraculum Pro',
    blurb: 'Fast, capable everyday model',
  ),
];

/// The default selection (first option), matching the website.
const String kDefaultModelId = 'sylor-oraculum-aeon200B';

/// The display name for a facade id, falling back to a neutral label.
String oraculumModelName(String id) {
  for (final m in kOraculumModels) {
    if (m.id == id) return m.name;
  }
  return 'Oraculum';
}
