import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:url_launcher/url_launcher.dart';

import '../services/social_service.dart';
import '../theme.dart';

/// ---------------------------------------------------------------------------
/// Profile social links — Instagram, WhatsApp, TikTok.
///
/// One rounded box under the bio: each row is the brand's mark, the handle
/// (WhatsApp shows the number), and it opens the user's profile on that
/// platform in the browser/app (instagram.com/<user>, wa.me/<number>,
/// tiktok.com/@<user>). Rows only appear for links the user actually set.
/// ---------------------------------------------------------------------------

/// The brand marks as inline SVG (crisp at any size, no new deps beyond
/// the flutter_svg the app already carries).
const Map<String, String> kSocialSvg = <String, String>{
  'instagram':
      '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">'
      '<defs><linearGradient id="ig" x1="0" y1="1" x2="1" y2="0">'
      '<stop offset="0" stop-color="#FFC107"/><stop offset="0.5" stop-color="#F44336"/>'
      '<stop offset="1" stop-color="#9C27B0"/></linearGradient></defs>'
      '<rect x="2" y="2" width="20" height="20" rx="5.5" fill="none" stroke="url(#ig)" stroke-width="2"/>'
      '<circle cx="12" cy="12" r="4.6" fill="none" stroke="url(#ig)" stroke-width="2"/>'
      '<circle cx="17.4" cy="6.6" r="1.4" fill="url(#ig)"/></svg>',
  'whatsapp':
      '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">'
      '<path fill="#25D366" d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5.1-1.3A10 10 0 1 0 12 2z"/>'
      '<path fill="#fff" d="M9.1 7.4c.3-.6.5-.6.8-.6h.6c.2 0 .5 0 .7.5l.9 2.2c.1.2.1.4 0 .6l-.5.7c-.1.2-.2.4 0 .7.7 1.2 1.6 2 2.8 2.6.3.1.5.1.7-.1l.7-.8c.2-.2.4-.2.6-.1l2.1 1c.3.1.5.3.5.5 0 1.1-.7 1.9-1.7 2.1-1.1.2-2.6-.2-4.3-1.4-2-1.4-3.3-3.2-3.8-4.4-.5-1.2-.5-2.2-.1-3z"/>'
      '</svg>',
  'tiktok':
      '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">'
      '<path fill="#111111" d="M16.6 3c.4 2 1.7 3.4 3.9 3.6v2.9c-1.5.1-2.8-.4-3.9-1.2v5.6c0 4-2.9 6.1-6 6.1-2.9 0-5.3-2-5.3-5.1 0-3 2.4-5.1 5.6-4.9v3c-1.5-.3-2.7.5-2.7 1.9 0 1.3 1 2.2 2.4 2.2 1.6 0 2.7-1.1 2.7-3.1V3h3.3z"/>'
      '<path fill="#25F4EE" d="M16.6 3c.4 2 1.7 3.4 3.9 3.6v1.4c-1.5.1-2.8-.4-3.9-1.2V3z" opacity="0.9"/>'
      '<path fill="#FE2C55" d="M9.9 10.1c-3.2-.2-5.6 1.9-5.6 4.9 0 .8.2 1.5.5 2.2-.7-.8-1-2-1-3 0-3.1 2.7-5.2 6.1-4.9v.8z" opacity="0.85"/>'
      '</svg>',
};

/// Which socials exist and how each renders/links.
const List<String> kSocialKinds = <String>['instagram', 'whatsapp', 'tiktok'];

String? socialHandle(SocialLinks? links, String kind) {
  if (links == null) return null;
  switch (kind) {
    case 'instagram':
      final v = links.instagram.trim();
      return v.isEmpty ? null : v;
    case 'whatsapp':
      final v = links.whatsapp.trim();
      return v.isEmpty ? null : v;
    case 'tiktok':
      final v = links.tiktok.trim();
      return v.isEmpty ? null : v;
  }
  return null;
}

String? socialUrl(SocialLinks? links, String kind) {
  final handle = socialHandle(links, kind);
  if (handle == null) return null;
  switch (kind) {
    case 'instagram':
      return 'https://instagram.com/$handle';
    case 'whatsapp':
      return 'https://wa.me/$handle';
    case 'tiktok':
      return 'https://tiktok.com/@$handle';
  }
  return null;
}

/// The rounded social box under the bio. Hidden entirely when the profile has
/// no links set.
class ProfileSocialBox extends StatelessWidget {
  const ProfileSocialBox({super.key, required this.links});

  final SocialLinks? links;

  Future<void> _open(String url) async {
    final uri = Uri.tryParse(url);
    if (uri != null) {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    }
  }

  @override
  Widget build(BuildContext context) {
    final rows = <Widget>[];
    for (final kind in kSocialKinds) {
      final url = socialUrl(links, kind);
      final handle = socialHandle(links, kind);
      if (url == null || handle == null) continue;
      rows.add(
        InkWell(
          borderRadius: BorderRadius.circular(10),
          onTap: () => _open(url),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
            child: Row(
              children: <Widget>[
                SvgPicture.string(kSocialSvg[kind]!, width: 20, height: 20),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    kind == 'whatsapp' ? '+$handle' : handle,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 13.5,
                      fontWeight: FontWeight.w600,
                      color: TeamlyColors.ink900,
                    ),
                  ),
                ),
                const Icon(Icons.open_in_new_rounded, size: 14, color: TeamlyColors.ink300),
              ],
            ),
          ),
        ),
      );
    }
    if (rows.isEmpty) return const SizedBox.shrink();
    return Container(
      decoration: BoxDecoration(
        color: context.palette.chip,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: context.palette.border),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(children: rows),
    );
  }
}
