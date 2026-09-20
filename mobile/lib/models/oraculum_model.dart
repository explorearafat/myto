class OraculumModel {
  const OraculumModel({required this.id, required this.name, required this.blurb});

  final String id;

  final String name;

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

const String kDefaultModelId = 'sylor-oraculum-aeon200B';

String oraculumModelName(String id) {
  for (final m in kOraculumModels) {
    if (m.id == id) return m.name;
  }
  return 'Oraculum';
}
