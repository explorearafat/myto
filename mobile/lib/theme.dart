import 'package:flutter/material.dart';
class SylorColors {
  const SylorColors._();

  static const Color terracotta = Color(0xFFCF5535);
  static const Color terracottaBright = Color(0xFFE0704F);

  static const Color lightBg = Color(0xFFFAF9F5);
  static const Color lightSurface = Color(0xFFFFFFFF);
  static const Color lightSurface2 = Color(0xFFF1ECE3);
  static const Color lightText = Color(0xFF23211E);
  static const Color lightMuted = Color(0xFF6B665E);
  static const Color lightBorder = Color(0xFFE9E1D4);

  static const Color darkBg = Color(0xFF1A1917);
  static const Color darkSurface = Color(0xFF232120);
  static const Color darkSurface2 = Color(0xFF2C2A27);
  static const Color darkText = Color(0xFFECE8E1);
  static const Color darkMuted = Color(0xFFA29C91);
  static const Color darkBorder = Color(0xFF35322C);
}

ThemeData sylorLightTheme() => _build(
      brightness: Brightness.light,
      accent: SylorColors.terracotta,
      bg: SylorColors.lightBg,
      surface: SylorColors.lightSurface,
      surface2: SylorColors.lightSurface2,
      text: SylorColors.lightText,
      muted: SylorColors.lightMuted,
      border: SylorColors.lightBorder,
    );

ThemeData sylorDarkTheme() => _build(
      brightness: Brightness.dark,
      accent: SylorColors.terracottaBright,
      bg: SylorColors.darkBg,
      surface: SylorColors.darkSurface,
      surface2: SylorColors.darkSurface2,
      text: SylorColors.darkText,
      muted: SylorColors.darkMuted,
      border: SylorColors.darkBorder,
    );

ThemeData _build({
  required Brightness brightness,
  required Color accent,
  required Color bg,
  required Color surface,
  required Color surface2,
  required Color text,
  required Color muted,
  required Color border,
}) {
  final scheme = ColorScheme(
    brightness: brightness,
    primary: accent,
    onPrimary: Colors.white,
    secondary: accent,
    onSecondary: Colors.white,
    surface: surface,
    onSurface: text,
    surfaceContainerHighest: surface2,
    error: const Color(0xFFB3392B),
    onError: Colors.white,
    outline: border,
  );

  return ThemeData(
    useMaterial3: true,
    brightness: brightness,
    colorScheme: scheme,
    scaffoldBackgroundColor: bg,
    canvasColor: bg,
    dividerColor: border,
    splashFactory: InkRipple.splashFactory,
    appBarTheme: AppBarTheme(
      backgroundColor: bg,
      surfaceTintColor: Colors.transparent,
      foregroundColor: text,
      elevation: 0,
      centerTitle: false,
    ),
    textSelectionTheme: TextSelectionThemeData(
      cursorColor: accent,
      selectionColor: accent.withValues(alpha: 0.25),
      selectionHandleColor: accent,
    ),
    snackBarTheme: SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      backgroundColor: surface2,
      contentTextStyle: TextStyle(color: text),
    ),
    extensions: <ThemeExtension<dynamic>>[
      SylorPalette(
        bg: bg,
        surface: surface,
        surface2: surface2,
        text: text,
        muted: muted,
        border: border,
        accent: accent,
      ),
    ],
  );
}

class SylorPalette extends ThemeExtension<SylorPalette> {
  const SylorPalette({
    required this.bg,
    required this.surface,
    required this.surface2,
    required this.text,
    required this.muted,
    required this.border,
    required this.accent,
  });

  final Color bg;
  final Color surface;
  final Color surface2;
  final Color text;
  final Color muted;
  final Color border;
  final Color accent;

  @override
  SylorPalette copyWith({
    Color? bg,
    Color? surface,
    Color? surface2,
    Color? text,
    Color? muted,
    Color? border,
    Color? accent,
  }) =>
      SylorPalette(
        bg: bg ?? this.bg,
        surface: surface ?? this.surface,
        surface2: surface2 ?? this.surface2,
        text: text ?? this.text,
        muted: muted ?? this.muted,
        border: border ?? this.border,
        accent: accent ?? this.accent,
      );

  @override
  SylorPalette lerp(ThemeExtension<SylorPalette>? other, double t) {
    if (other is! SylorPalette) return this;
    return SylorPalette(
      bg: Color.lerp(bg, other.bg, t)!,
      surface: Color.lerp(surface, other.surface, t)!,
      surface2: Color.lerp(surface2, other.surface2, t)!,
      text: Color.lerp(text, other.text, t)!,
      muted: Color.lerp(muted, other.muted, t)!,
      border: Color.lerp(border, other.border, t)!,
      accent: Color.lerp(accent, other.accent, t)!,
    );
  }
}

extension SylorThemeX on ThemeData {
  SylorPalette get palette => extension<SylorPalette>()!;
}
