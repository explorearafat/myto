import 'package:flutter/material.dart';

class MytoColors {
  const MytoColors._();

  // Brand monochrome. Ink is the accent on light surfaces and the mark/dark-tile colour; paper is
  // the accent on dark surfaces (and the mark drawn on ink). Warm gray sits between them for muted
  // text and hairline borders.
  static const Color ink = Color(0xFF181818);
  static const Color warmGray = Color(0xFFB0A8A0);
  static const Color paper = Color(0xFFF0F0EC);

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

ThemeData mytoLightTheme() => _build(
      brightness: Brightness.light,
      accent: MytoColors.ink,
      onAccent: MytoColors.paper,
      bg: MytoColors.lightBg,
      surface: MytoColors.lightSurface,
      surface2: MytoColors.lightSurface2,
      text: MytoColors.lightText,
      muted: MytoColors.lightMuted,
      border: MytoColors.lightBorder,
    );

ThemeData mytoDarkTheme() => _build(
      brightness: Brightness.dark,
      accent: MytoColors.paper,
      onAccent: MytoColors.ink,
      bg: MytoColors.darkBg,
      surface: MytoColors.darkSurface,
      surface2: MytoColors.darkSurface2,
      text: MytoColors.darkText,
      muted: MytoColors.darkMuted,
      border: MytoColors.darkBorder,
    );

ThemeData _build({
  required Brightness brightness,
  required Color accent,
  required Color onAccent,
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
    onPrimary: onAccent,
    secondary: accent,
    onSecondary: onAccent,
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
      MytoPalette(
        bg: bg,
        surface: surface,
        surface2: surface2,
        text: text,
        muted: muted,
        border: border,
        accent: accent,
        onAccent: onAccent,
      ),
    ],
  );
}

class MytoPalette extends ThemeExtension<MytoPalette> {
  const MytoPalette({
    required this.bg,
    required this.surface,
    required this.surface2,
    required this.text,
    required this.muted,
    required this.border,
    required this.accent,
    required this.onAccent,
  });

  final Color bg;
  final Color surface;
  final Color surface2;
  final Color text;
  final Color muted;
  final Color border;
  final Color accent;

  /// A colour that reads on top of [accent] (near-white on the light theme's ink accent, ink on the
  /// dark theme's near-white accent). Use it for text/icons on accent-filled buttons.
  final Color onAccent;

  @override
  MytoPalette copyWith({
    Color? bg,
    Color? surface,
    Color? surface2,
    Color? text,
    Color? muted,
    Color? border,
    Color? accent,
    Color? onAccent,
  }) =>
      MytoPalette(
        bg: bg ?? this.bg,
        surface: surface ?? this.surface,
        surface2: surface2 ?? this.surface2,
        text: text ?? this.text,
        muted: muted ?? this.muted,
        border: border ?? this.border,
        accent: accent ?? this.accent,
        onAccent: onAccent ?? this.onAccent,
      );

  @override
  MytoPalette lerp(ThemeExtension<MytoPalette>? other, double t) {
    if (other is! MytoPalette) return this;
    return MytoPalette(
      bg: Color.lerp(bg, other.bg, t)!,
      surface: Color.lerp(surface, other.surface, t)!,
      surface2: Color.lerp(surface2, other.surface2, t)!,
      text: Color.lerp(text, other.text, t)!,
      muted: Color.lerp(muted, other.muted, t)!,
      border: Color.lerp(border, other.border, t)!,
      accent: Color.lerp(accent, other.accent, t)!,
      onAccent: Color.lerp(onAccent, other.onAccent, t)!,
    );
  }
}

extension MytoThemeX on ThemeData {
  MytoPalette get palette => extension<MytoPalette>()!;
}
