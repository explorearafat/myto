import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../services/auth_service.dart';
import '../theme.dart';
import '../widgets/myto_mark.dart';

/// The sign-in screen — the spec the Discover community needs: the Myto mark,
/// a "Create an account" heading with "Discover Myto" beneath it, an intro
/// paragraph, email + password signup/sign-in, and Google one-tap beside it.
class SignInScreen extends StatefulWidget {
  const SignInScreen({super.key});

  @override
  State<SignInScreen> createState() => _SignInScreenState();
}

class _SignInScreenState extends State<SignInScreen> {
  bool _signup = true;
  final _name = TextEditingController();
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _obscure = true;

  @override
  void dispose() {
    _name.dispose();
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  void _submit(AuthService auth) {
    if (auth.busy) return;
    if (_signup && _name.text.trim().length < 2) {
      _showError(context, auth, 'Tell us your name — it shows on your posts.');
      return;
    }
    if (_signup) {
      auth.signUpWithEmail(
        email: _email.text,
        password: _password.text,
        name: _name.text,
      );
    } else {
      auth.signInWithEmail(email: _email.text, password: _password.text);
    }
  }

  void _showError(BuildContext context, AuthService auth, String message) {
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    final palette = Theme.of(context).palette;
    final auth = context.watch<AuthService>();

    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 20),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: TweenAnimationBuilder<double>(
                tween: Tween(begin: 0, end: 1),
                duration: const Duration(milliseconds: 450),
                curve: Curves.easeOutCubic,
                builder: (context, t, child) => Opacity(
                  opacity: t.clamp(0.0, 1.0),
                  child: Transform.translate(offset: Offset(0, (1 - t) * 14), child: child),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    // Logo + wordmark
                    const MytoMarkAura(auraSize: 110, starSize: 52),
                    const SizedBox(height: 14),
                    Text(
                      'Create an account',
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        color: palette.text,
                        fontSize: 26,
                        fontWeight: FontWeight.w600,
                        letterSpacing: -0.5,
                      ),
                    ),
                    Text(
                      'Discover Myto',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: palette.accent, fontSize: 14.5, fontWeight: FontWeight.w600),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      'One account for the whole workspace — chat with your model, build real projects, and post to the Discover community.',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: palette.muted, fontSize: 13.5, height: 1.45),
                    ),
                    const SizedBox(height: 26),

                    // Email + password form
                    if (_signup)
                      _field(
                        controller: _name,
                        palette: palette,
                        label: 'Your name',
                        icon: Icons.person_outline_rounded,
                        textInputAction: TextInputAction.next,
                      ),
                    if (_signup) const SizedBox(height: 10),
                    _field(
                      controller: _email,
                      palette: palette,
                      label: 'Email address',
                      icon: Icons.alternate_email_rounded,
                      keyboard: TextInputType.emailAddress,
                      textInputAction: TextInputAction.next,
                    ),
                    const SizedBox(height: 10),
                    _field(
                      controller: _password,
                      palette: palette,
                      label: 'Password',
                      icon: Icons.lock_outline_rounded,
                      obscure: _obscure,
                      toggleObscure: () => setState(() => _obscure = !_obscure),
                      textInputAction: TextInputAction.done,
                      onSubmitted: (_) => _submit(auth),
                    ),
                    const SizedBox(height: 16),
                    SizedBox(
                      height: 52,
                      child: Material(
                        color: palette.accent,
                        borderRadius: BorderRadius.circular(14),
                        child: InkWell(
                          borderRadius: BorderRadius.circular(14),
                          onTap: auth.busy ? null : () => _submit(auth),
                          child: Center(
                            child: auth.busy
                                ? SizedBox(
                                    width: 20,
                                    height: 20,
                                    child: CircularProgressIndicator(strokeWidth: 2, color: palette.onAccent),
                                  )
                                : Text(
                                    _signup ? 'Create account' : 'Sign in',
                                    style: TextStyle(
                                      color: palette.onAccent,
                                      fontSize: 15,
                                      fontWeight: FontWeight.w600,
                                    ),
                                  ),
                          ),
                        ),
                      ),
                    ),

                    if (auth.error != null) ...[
                      const SizedBox(height: 14),
                      _errorBanner(palette, auth.error!),
                    ],

                    // Mode toggle
                    const SizedBox(height: 14),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Text(
                          _signup ? 'Already have an account?' : 'New to Myto?',
                          style: TextStyle(color: palette.muted, fontSize: 13.5),
                        ),
                        TextButton(
                          onPressed: () => setState(() => _signup = !_signup),
                          child: Text(
                            _signup ? 'Sign in' : 'Create one',
                            style: TextStyle(color: palette.accent, fontWeight: FontWeight.w600),
                          ),
                        ),
                      ],
                    ),

                    // Divider + Google beside the email path
                    Row(
                      children: [
                        Expanded(child: Divider(color: palette.border)),
                        Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 12),
                          child: Text('or', style: TextStyle(color: palette.muted, fontSize: 12)),
                        ),
                        Expanded(child: Divider(color: palette.border))
                      ],
                    ),
                    const SizedBox(height: 14),
                    _providerButton(
                      label: 'Continue with Google',
                      icon: Icons.g_mobiledata_rounded,
                      onTap: auth.busy ? null : auth.signInWithGoogle,
                      palette: palette,
                      filled: false,
                    ),
                    const SizedBox(height: 16),
                    Text(
                      'Reading the Discover feed needs no account. Signing in unlocks posting, reactions, and follows.',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: palette.muted, fontSize: 12, height: 1.4),
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

  Widget _field({
    required TextEditingController controller,
    required MytoPalette palette,
    required String label,
    required IconData icon,
    TextInputType? keyboard,
    TextInputAction? textInputAction,
    bool obscure = false,
    VoidCallback? toggleObscure,
    ValueChanged<String>? onSubmitted,
  }) {
    return TextField(
      controller: controller,
      keyboardType: keyboard,
      textInputAction: textInputAction,
      obscureText: obscure,
      onSubmitted: onSubmitted,
      style: TextStyle(color: palette.text, fontSize: 15),
      decoration: InputDecoration(
        labelText: label,
        labelStyle: TextStyle(color: palette.muted, fontSize: 13.5),
        prefixIcon: Icon(icon, size: 20, color: palette.muted),
        suffixIcon: toggleObscure != null
            ? IconButton(
                onPressed: toggleObscure,
                icon: Icon(
                  obscure ? Icons.visibility_off_outlined : Icons.visibility_outlined,
                  size: 20,
                  color: palette.muted,
                ),
              )
            : null,
        filled: true,
        fillColor: palette.surface,
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 15),
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: BorderSide(color: palette.border)),
        enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: BorderSide(color: palette.border)),
        focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: BorderSide(color: palette.accent, width: 1.4)),
      ),
    );
  }

  Widget _errorBanner(MytoPalette palette, String message) => Container(
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
    required MytoPalette palette,
    required bool filled,
  }) {
    final bg = filled ? palette.accent : palette.surface;
    final fg = filled ? palette.onAccent : palette.text;
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
