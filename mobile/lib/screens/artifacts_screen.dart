import 'dart:convert';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';

import '../services/social_service.dart';
import '../theme.dart';
import '../widgets/teamly/kit.dart';

/// The Artifacts tab — the user's vault of everything the models generated:
/// images, video clips, SVGs, documents. Backed by Firestore, so the vault is
/// the SAME one the desktop app writes into and the website's /artifacts page
/// shows. No demo data: the tab starts empty and fills as media is generated.
class ArtifactsScreen extends StatefulWidget {
  const ArtifactsScreen({super.key});

  @override
  State<ArtifactsScreen> createState() => _ArtifactsScreenState();
}

class _ArtifactsScreenState extends State<ArtifactsScreen> {
  User? get _user => FirebaseAuth.instance.currentUser;

  Future<void> _delete(CloudArtifact a) async {
    await SocialService().deleteArtifact(a.id);
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(const SnackBar(
        content: Text('Artifact deleted.'),
        duration: Duration(seconds: 2),
      ));
  }

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final uid = _user?.uid ?? '';

    return Scaffold(
      appBar: AppBar(title: const Text('Artifacts')),
      body: uid.isEmpty
          ? const _Empty(text: 'Sign in to open your artifact vault.')
          : StreamBuilder<List<CloudArtifact>>(
              stream: SocialService().streamArtifacts(uid),
              builder: (context, snap) {
                if (snap.connectionState == ConnectionState.waiting && !snap.hasData) {
                  return const Center(
                    child:
                        Text('Loading the vault…', style: TextStyle(color: TeamlyColors.ink300)),
                  );
                }
                final items = snap.data ?? const <CloudArtifact>[];
                if (items.isEmpty) {
                  return const _EmptyState();
                }
                return RefreshIndicator(
                  onRefresh: () async {},
                  child: GridView.builder(
                    padding: const EdgeInsets.all(TeamlySpace.gutter),
                    gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
                      maxCrossAxisExtent: 260,
                      mainAxisSpacing: TeamlySpace.s3,
                      crossAxisSpacing: TeamlySpace.s3,
                      childAspectRatio: 0.82,
                    ),
                    itemCount: items.length,
                    itemBuilder: (context, i) =>
                        _ArtifactCard(artifact: items[i], onDelete: () => _delete(items[i])),
                  ),
                );
              },
            ),
    );
  }
}

class _ArtifactCard extends StatelessWidget {
  const _ArtifactCard({required this.artifact, required this.onDelete});

  final CloudArtifact artifact;
  final VoidCallback onDelete;

  Widget _stage() {
    if (artifact.isImage && artifact.hasInline) {
      final bytes = base64Decode(artifact.dataBase64);
      return Image.memory(bytes, fit: BoxFit.cover, errorBuilder: (_, __, ___) => const _StageFallback(kind: 'image'));
    }
    if (artifact.isImage && artifact.url.isNotEmpty) {
      return Image.network(
        artifact.url,
        fit: BoxFit.cover,
        errorBuilder: (_, __, ___) => const _StageFallback(kind: 'image'),
      );
    }
    if (artifact.isVideo) {
      final src = artifact.hasInline ? artifact.inlineSrc : artifact.url;
      return Container(
        color: Colors.black,
        child: Center(
          child: IconButton(
            icon: const Icon(Icons.play_circle_fill_rounded, color: Colors.white70, size: 40),
            onPressed: src.isEmpty ? null : () {},
            tooltip: 'Open the source to play',
          ),
        ),
      );
    }
    return _StageFallback(kind: artifact.kind);
  }

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return TeamlyCard(
      padding: EdgeInsets.zero,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Expanded(child: _stage()),
          Padding(
            padding: const EdgeInsets.all(TeamlySpace.s3),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  artifact.title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                      fontSize: 13, fontWeight: FontWeight.w600, color: TeamlyColors.ink900),
                ),
                const SizedBox(height: TeamlySpace.s2),
                Row(
                  children: <Widget>[
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                      decoration: BoxDecoration(
                        color: palette.tagBg,
                        borderRadius: BorderRadius.circular(TeamlyRadius.pill),
                      ),
                      child: Text(
                        artifact.kind.toUpperCase(),
                        style: TextStyle(
                            fontSize: 9.5, fontWeight: FontWeight.w700, color: palette.tagFg),
                      ),
                    ),
                    const Spacer(),
                    IconButton(
                      visualDensity: VisualDensity.compact,
                      tooltip: 'Delete',
                      onPressed: onDelete,
                      icon:
                          const Icon(Icons.delete_outline_rounded, size: 18, color: TeamlyColors.ink300),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _StageFallback extends StatelessWidget {
  const _StageFallback({required this.kind});

  final String kind;

  @override
  Widget build(BuildContext context) {
    return Container(
      color: TeamlyColors.ink900,
      child: Center(
        child: Icon(
          kind == 'image' ? Icons.image_outlined : Icons.description_outlined,
          color: TeamlyColors.ink500,
          size: 32,
        ),
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(Icons.dashboard_outlined, size: 40, color: context.palette.muted),
            const SizedBox(height: TeamlySpace.s3),
            const Text(
              'The vault is empty.',
              style: TextStyle(
                  fontSize: 15, fontWeight: FontWeight.w600, color: TeamlyColors.ink900),
            ),
            const SizedBox(height: 8),
            const Text(
              'Generate an image or video in a chat — desktop, Android, or the browser — and it lands here automatically.',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 13, height: 1.5, color: TeamlyColors.ink500),
            ),
          ],
        ),
      ),
    );
  }
}

class _Empty extends StatelessWidget {
  const _Empty({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Text(text, style: const TextStyle(color: TeamlyColors.ink500)),
    );
  }
}
