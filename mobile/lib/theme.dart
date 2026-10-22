import 'package:flutter/material.dart';

/// ---------------------------------------------------------------------------
/// Teamly design tokens.
///
/// Every value below was sampled pixel-by-pixel from the five reference
/// screenshots (Chat, Agents, Discover, Memory, Artifacts). This file is the
/// single source of truth for colour, type, spacing, radius and elevation —
/// widgets must read from here (or from `context.palette`) and never hard-code
/// a hex value of their own.
///
/// The one rule that defines the whole system: [TeamlyColors.green500] is a
/// FILL colour, never a text colour on a light surface (white-on-green is only
/// 2.3:1). When green must be *text*, use [TeamlyColors.greenText] (#18964D).
/// ---------------------------------------------------------------------------
class TeamlyColors {
  const TeamlyColors._();

  // -- brand green ----------------------------------------------------------
  /// Primary fill: primary buttons, selected chips, active tab underline.
  static const Color green500 = Color(0xFF00C951);

  /// Pressed state of a green-filled control.
  static const Color green600 = Color(0xFF00B548);

  /// Green used as TEXT on light surfaces (3.9:1 — AA at 600 weight+).
  static const Color greenText = Color(0xFF18964D);

  /// Tint fill behind agent/success tags ("✧ Agent generated").
  static const Color green050 = Color(0xFFEAFBF1);

  /// Inline green text links ("+ New").
  static const Color greenLink = Color(0xFF06A046);

  // -- surfaces -------------------------------------------------------------
  /// App canvas behind every screen.
  static const Color bg = Color(0xFFFAFBFD);

  /// Secondary canvas / section band.
  static const Color bgAlt = Color(0xFFF1F4F9);

  /// Cards, list rows, search fields, sheets.
  static const Color surface = Color(0xFFFFFFFF);

  /// Neutral chip + segmented-control track.
  static const Color chip = Color(0xFFF5F6FA);

  /// Warm-paper "document" surface (the co-editable brief panel).
  static const Color paper = Color(0xFFF1F0EB);

  /// Row pressed state.
  static const Color tint = Color(0xFFF3F4F6);

  /// 1px hairlines.
  static const Color divider = Color(0xFFEEEEEE);

  /// Letterbox stage behind a 9:16 artifact.
  static const Color stage = Color(0xFF191919);

  // -- ink (text) -----------------------------------------------------------
  /// Headings and titles.
  static const Color ink900 = Color(0xFF111727);

  /// Card titles (neutral variant) + document body headings.
  static const Color ink800 = Color(0xFF191919);

  /// Long-form body copy.
  static const Color ink700 = Color(0xFF3A4149);

  /// Secondary text, row descriptions.
  static const Color ink500 = Color(0xFF6B7280);

  /// Placeholder, timestamps, meta counters. Never load-bearing text.
  static const Color ink300 = Color(0xFFB9BABE);

  /// Editorial eyebrow / kicker on documents.
  static const Color teal = Color(0xFF355F55);

  // -- identity accents (Memory topic tiles only) ----------------------------
  static const Color accentPink = Color(0xFFEB4899);
  static const Color accentCyan = Color(0xFF07B6D5);
  static const Color accentAmber = Color(0xFFFACC15);
  static const Color accentViolet = Color(0xFFA755F7);

  /// The four tile colours, in the order the Memory screen shows them.
  static const List<Color> topicAccents = <Color>[
    accentPink,
    accentCyan,
    accentAmber,
    accentViolet,
  ];

  // -- avatar / illustration pastels ----------------------------------------
  static const Color pastelAmber = Color(0xFFFEE1A7);
  static const Color pastelPink = Color(0xFFFFE0EF);
  static const Color pastelBlue = Color(0xFFBDE7FF);
  static const Color pastelMint = Color(0xFFEAFBF3);

  /// Pastels in rotation, for agent avatar discs.
  static const List<Color> avatarPastels = <Color>[
    pastelAmber,
    pastelPink,
    pastelBlue,
    pastelMint,
  ];

  static const Color danger = Color(0xFFE5484D);
}

/// 4pt spacing scale. Screen gutter is always [s4] (16), card padding [s5] (20).
class TeamlySpace {
  const TeamlySpace._();
  static const double s1 = 4;
  static const double s2 = 8;
  static const double s3 = 12;
  static const double s4 = 16;
  static const double s5 = 20;
  static const double s6 = 24;
  static const double s8 = 32;

  /// Standard horizontal screen gutter.
  static const double gutter = s4;

  /// Inner padding of a card / list row.
  static const double cardPad = s5;
}

/// "Soft pill" corner language.
class TeamlyRadius {
  const TeamlyRadius._();
  static const double pill = 999;
  static const double lg = 24;
  static const double md = 18;
  static const double sm = 12;
  static const double xs = 8;
}

/// Shadows stay under 6% opacity — heavier instantly breaks the look. White
/// cards are separated from the canvas by radius + whitespace, not by shadow.
class TeamlyElevation {
  const TeamlyElevation._();

  static const List<BoxShadow> e1 = <BoxShadow>[
    BoxShadow(color: Color(0x0A111727), blurRadius: 2, offset: Offset(0, 1)),
  ];

  static const List<BoxShadow> e2 = <BoxShadow>[
    BoxShadow(color: Color(0x0F111727), blurRadius: 16, offset: Offset(0, 4)),
  ];

  static const List<BoxShadow> e3 = <BoxShadow>[
    BoxShadow(color: Color(0x1A111727), blurRadius: 28, offset: Offset(0, 8)),
  ];

  /// Subtle green glow under a primary CTA.
  static const List<BoxShadow> green = <BoxShadow>[
    BoxShadow(color: Color(0x4700C951), blurRadius: 16, offset: Offset(0, 6)),
  ];
}

/// Font families. `Inter` is the UI sans; JetBrains Mono is used only for the
/// document toolbar inside Discover.
///
/// NOTE: no TTF is bundled yet — Flutter falls back to the platform default
/// sans if the family is absent, so the app still renders correctly. Drop the
/// Inter/JetBrains-Mono TTFs into `mobile/assets/fonts` and declare them in
/// pubspec.yaml to get the exact reference typography.
class TeamlyFonts {
  const TeamlyFonts._();
  static const String sans = 'Inter';
  static const String serif = 'Source Serif 4';
  static const String mono = 'JetBrains Mono';
}

/// ---------------------------------------------------------------------------
/// Backwards-compatible alias. The pre-redesign app referred to `MytoColors`;
/// keeping the name (with Teamly values) means no widget has to change just to
/// compile.
/// ---------------------------------------------------------------------------
class MytoColors {
  const MytoColors._();

  static const Color ink = TeamlyColors.ink800;
  static const Color warmGray = TeamlyColors.ink300;
  static const Color paper = TeamlyColors.paper;

  static const Color lightBg = TeamlyColors.bg;
  static const Color lightSurface = TeamlyColors.surface;
  static const Color lightSurface2 = TeamlyColors.chip;
  static const Color lightText = TeamlyColors.ink900;
  static const Color lightMuted = TeamlyColors.ink500;
  static const Color lightBorder = TeamlyColors.divider;

  static const Color darkBg = Color(0xFF0E1116);
  static const Color darkSurface = Color(0xFF191E26);
  static const Color darkSurface2 = Color(0xFF232A34);
  static const Color darkText = Color(0xFFF2F4F7);
  static const Color darkMuted = Color(0xFF9AA3AF);
  static const Color darkBorder = Color(0xFF252B34);
}

/// ---------------------------------------------------------------------------
/// Theme builders.
///
/// `MytoPalette` is the switchboard every widget reads from, so a widget asks
/// for `context.palette.accent` and gets Teamly green on light, a brighter green
/// on dark. The extra Teamly fields (chip/paper/stage/tag/eyebrow) are exposed
/// on the same object so new screens never hard-code colour either.
/// ---------------------------------------------------------------------------
ThemeData mytoLightTheme() => _build(
      brightness: Brightness.light,
      accent: TeamlyColors.green500,
      onAccent: Colors.white,
      bg: TeamlyColors.bg,
      surface: TeamlyColors.surface,
      surface2: TeamlyColors.chip,
      text: TeamlyColors.ink900,
      muted: TeamlyColors.ink500,
      border: TeamlyColors.divider,
      chip: TeamlyColors.chip,
      paper: TeamlyColors.paper,
      stage: TeamlyColors.stage,
      tagBg: TeamlyColors.green050,
      tagFg: TeamlyColors.greenText,
      accentText: TeamlyColors.greenText,
      avatarPastels: TeamlyColors.avatarPastels,
    );

ThemeData mytoDarkTheme() => _build(
      brightness: Brightness.dark,
      accent: const Color(0xFF00D45B),
      onAccent: const Color(0xFF06210F),
      bg: MytoColors.darkBg,
      surface: MytoColors.darkSurface,
      surface2: MytoColors.darkSurface2,
      text: MytoColors.darkText,
      muted: MytoColors.darkMuted,
      border: MytoColors.darkBorder,
      chip: MytoColors.darkSurface2,
      paper: const Color(0xFF22242A),
      stage: const Color(0xFF101014),
      tagBg: const Color(0xFF12291C),
      tagFg: const Color(0xFF3ED37A),
      accentText: const Color(0xFF3ED37A),
      avatarPastels: const <Color>[
        Color(0xFF4A3F1E),
        Color(0xFF4A2436),
        Color(0xFF1E3A4A),
        Color(0xFF1E3A2E),
      ],
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
  required Color chip,
  required Color paper,
  required Color stage,
  required Color tagBg,
  required Color tagFg,
  required Color accentText,
  required List<Color> avatarPastels,
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
    error: TeamlyColors.danger,
    onError: Colors.white,
    outline: border,
  );

  // Type scale, straight from the measured reference (see design-and-theme.md).
  final textTheme = TextTheme(
    // Document headline — serif, only inside a brief.
    displaySmall: TextStyle(
      fontFamily: TeamlyFonts.serif,
      fontSize: 35,
      fontWeight: FontWeight.w700,
      letterSpacing: -0.7,
      height: 1.12,
      color: text,
    ),
    // Screen title.
    titleLarge: TextStyle(
      fontFamily: TeamlyFonts.sans,
      fontSize: 22,
      fontWeight: FontWeight.w700,
      letterSpacing: -0.2,
      height: 1.25,
      color: text,
    ),
    // Row / card title.
    titleMedium: TextStyle(
      fontFamily: TeamlyFonts.sans,
      fontSize: 19,
      fontWeight: FontWeight.w700,
      letterSpacing: -0.1,
      height: 1.3,
      color: text,
    ),
    // List title.
    titleSmall: TextStyle(
      fontFamily: TeamlyFonts.sans,
      fontSize: 16,
      fontWeight: FontWeight.w600,
      height: 1.35,
      color: text,
    ),
    bodyLarge: TextStyle(
      fontFamily: TeamlyFonts.sans,
      fontSize: 15,
      fontWeight: FontWeight.w400,
      height: 1.5,
      color: text,
    ),
    bodyMedium: TextStyle(
      fontFamily: TeamlyFonts.sans,
      fontSize: 15,
      fontWeight: FontWeight.w400,
      height: 1.5,
      color: muted,
    ),
    bodySmall: TextStyle(
      fontFamily: TeamlyFonts.sans,
      fontSize: 13,
      fontWeight: FontWeight.w400,
      height: 1.45,
      color: muted,
    ),
    labelLarge: TextStyle(
      fontFamily: TeamlyFonts.sans,
      fontSize: 15,
      fontWeight: FontWeight.w600,
      color: text,
    ),
    // Uppercase group label / eyebrow.
    labelSmall: TextStyle(
      fontFamily: TeamlyFonts.sans,
      fontSize: 11,
      fontWeight: FontWeight.w600,
      letterSpacing: 1.3,
      color: TeamlyColors.ink300,
    ),
  );

  return ThemeData(
    useMaterial3: true,
    brightness: brightness,
    colorScheme: scheme,
    scaffoldBackgroundColor: bg,
    canvasColor: bg,
    dividerColor: border,
    textTheme: textTheme,
    splashFactory: InkSparkle.splashFactory,
    appBarTheme: AppBarTheme(
      backgroundColor: surface,
      surfaceTintColor: Colors.transparent,
      foregroundColor: text,
      elevation: 0,
      scrolledUnderElevation: 0,
      centerTitle: false,
      titleTextStyle: textTheme.titleLarge,
    ),
    cardTheme: CardThemeData(
      color: surface,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(TeamlyRadius.lg),
      ),
    ),
    dividerTheme: DividerThemeData(color: border, thickness: 1, space: 1),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: surface,
      surfaceTintColor: Colors.transparent,
      indicatorColor: Colors.transparent,
      elevation: 0,
      height: 72,
      labelBehavior: NavigationDestinationLabelBehavior.alwaysShow,
    ),
    textSelectionTheme: TextSelectionThemeData(
      cursorColor: accent,
      selectionColor: accent.withValues(alpha: 0.25),
      selectionHandleColor: accent,
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: surface,
      hintStyle: TextStyle(color: TeamlyColors.ink300, fontSize: 15),
      contentPadding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(TeamlyRadius.pill),
        borderSide: BorderSide.none,
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(TeamlyRadius.pill),
        borderSide: BorderSide.none,
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(TeamlyRadius.pill),
        borderSide: BorderSide(color: accent, width: 1.5),
      ),
    ),
    snackBarTheme: SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      backgroundColor: surface,
      contentTextStyle: TextStyle(color: text, fontSize: 14),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(TeamlyRadius.sm),
      ),
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
        chip: chip,
        paper: paper,
        stage: stage,
        tagBg: tagBg,
        tagFg: tagFg,
        accentText: accentText,
        avatarPastels: avatarPastels,
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
    required this.chip,
    required this.paper,
    required this.stage,
    required this.tagBg,
    required this.tagFg,
    required this.accentText,
    required this.avatarPastels,
  });

  final Color bg;
  final Color surface;
  final Color surface2;
  final Color text;
  final Color muted;
  final Color border;

  /// The loud brand colour: primary buttons, selected chips, active tabs.
  /// This is a FILL — put [onAccent] on top of it, never white-on-green text
  /// smaller than 14/600.
  final Color accent;

  /// A colour that reads on top of [accent].
  final Color onAccent;

  /// Neutral chip / segmented-control track.
  final Color chip;

  /// Warm-paper document surface.
  final Color paper;

  /// Letterbox behind a 9:16 artifact.
  final Color stage;

  /// Status-tag fill + text ("✧ Agent generated").
  final Color tagBg;
  final Color tagFg;

  /// Green that is safe as TEXT on [surface].
  final Color accentText;

  /// Avatar disc pastels, in rotation.
  final List<Color> avatarPastels;

  /// Pick a pastel by index, wrapping.
  Color pastel(int i) => avatarPastels[i % avatarPastels.length];

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
    Color? chip,
    Color? paper,
    Color? stage,
    Color? tagBg,
    Color? tagFg,
    Color? accentText,
    List<Color>? avatarPastels,
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
        chip: chip ?? this.chip,
        paper: paper ?? this.paper,
        stage: stage ?? this.stage,
        tagBg: tagBg ?? this.tagBg,
        tagFg: tagFg ?? this.tagFg,
        accentText: accentText ?? this.accentText,
        avatarPastels: avatarPastels ?? this.avatarPastels,
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
      chip: Color.lerp(chip, other.chip, t)!,
      paper: Color.lerp(paper, other.paper, t)!,
      stage: Color.lerp(stage, other.stage, t)!,
      tagBg: Color.lerp(tagBg, other.tagBg, t)!,
      tagFg: Color.lerp(tagFg, other.tagFg, t)!,
      accentText: Color.lerp(accentText, other.accentText, t)!,
      avatarPastels: avatarPastels,
    );
  }
}

extension MytoThemeX on ThemeData {
  MytoPalette get palette => extension<MytoPalette>()!;
}

extension MytoContextX on BuildContext {
  MytoPalette get palette => Theme.of(this).palette;
  TextTheme get texts => Theme.of(this).textTheme;
}