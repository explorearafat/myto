import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../services/auth_service.dart';
import '../theme.dart';
import '../widgets/sylor_star.dart';

class SignInScreen extends StatelessWidget {
  const SignInScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final palette = Theme.of(context).palette;
    final auth = context.watch<AuthService>();

    return Scaffold(
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 420),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 28),
              child: TweenAnimationBuilder<double>(
                tween: Tween(begin: 0, end: 1),
                duration: const Duration(milliseconds: 450),
                curve: Curves.easeOutCubic,
                builder: (context, t, child) => Opacity(
                  opacity: t.clamp(0.0, 1.0),
                  child: Transform.translate(offset: Offset(0, (1 - t) * 14), child: child),
                ),
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    const SylorStarAura(auraSize: 132, starSize: 64),
                    const SizedBox(height: 18),
                  Text(
                    'Sylor',
                    style: TextStyle(
                      color: palette.text,
                      fontSize: 30,
                      fontWeight: FontWeight.w600,
                      letterSpacing: -0.5,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    'Your calm, capable AI — now on mobile.',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: palette.muted, fontSize: 15, height: 1.4),
                  ),
                  const SizedBox(height: 36),
                  if (auth.error != null) _errorBanner(palette, auth.error!),
                  _providerButton(
                    label: 'Continue with Google',
                    icon: Icons.g_mobiledata_rounded,
                    onTap: auth.busy ? null : auth.signInWithGoogle,
                    palette: palette,
                    filled: true,
                  ),
                  const SizedBox(height: 18),
                  if (auth.busy)
                    SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(strokeWidth: 2, color: palette.accent),
                    )
                  else
                    Text(
                      'A browser will open to finish signing in.',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: palette.muted, fontSize: 13, height: 1.4),
                    ),
                ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _errorBanner(SylorPalette palette, String message) => Container(
        margin: const EdgeInsets.only(bottom: 18),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(
          color: palette.accent.withValues(alpha: 0.10),
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: palette.accent.withValues(alpha: 0.35)),
        ),
        child: Text(message, style: TextStyle(color: palette.text, fontSize: 13, height: 1.4)),
      );

  Widget _providerButton({
    required String label,
    required IconData icon,
    required VoidCallback? onTap,
    required SylorPalette palette,
    required bool filled,
  }) {
    final bg = filled ? palette.accent : palette.surface;
    final fg = filled ? Colors.white : palette.text;
    return SizedBox(
      width: double.infinity,
      height: 52,
      child: Material(
        color: bg,
        borderRadius: BorderRadius.circular(14),
        child: InkWell(
          borderRadius: BorderRadius.circular(14),
          onTap: onTap,
          child: Container(
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(14),
              border: filled ? null : Border.all(color: palette.border),
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Icon(icon, color: fg, size: 22),
                const SizedBox(width: 10),
                Text(
                  label,
                  style: TextStyle(color: fg, fontSize: 15, fontWeight: FontWeight.w600),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
