# Sylor Mobile

A Claude-style mobile companion for Sylor, built with Flutter. It signs in with Google or
GitHub (the same Firebase project as the website), then streams real answers from the live
**Oraculum** gateway — the exact backend the web `/chat` uses — with conversation history, a
model picker, and Sylor's warm light/dark theming.

> **What's in this folder:** the Dart sources (`lib/`), the `pubspec.yaml`, a smoke test, and a
> committed `lib/firebase_options.dart` carrying Sylor's *public* Web config. The platform
> folders (`android/`, `ios/`, …) are **not** committed — you generate them once with
> `flutter create .` (see below). This keeps the repo to just the code that's actually ours.

---

## Prerequisites

- **Flutter SDK 3.27 or newer** (Dart ≥ 3.6). Check with `flutter --version`.
  Install: <https://docs.flutter.dev/get-started/install>
- For Android: Android Studio + an emulator or a device with USB debugging.
- For iOS (macOS only): Xcode + CocoaPods.
- Confirm your toolchain is healthy: `flutter doctor`

---

## First-time setup

Everything runs from this `mobile/` directory.

### 1. Generate the platform folders

The repo ships only the Dart code, so first let Flutter scaffold the native projects:

```bash
flutter create --org com.sylor --project-name sylor .
```

> ⚠️ **Important:** `flutter create .` **overwrites** a handful of files it owns —
> `lib/main.dart`, `pubspec.yaml`, `analysis_options.yaml`, `.gitignore`, `README.md`, and
> `test/widget_test.dart`. Restore Sylor's versions immediately (this only reverts tracked
> files; it leaves the freshly generated `android/`, `ios/`, `.metadata` in place):

```bash
git checkout -- mobile/
```

Run that from the repo root. All of Sylor's `lib/` sources, the pubspec, and the smoke test are
now back, sitting on top of the new native folders.

### 2. Install packages

```bash
flutter pub get
```

### 3. Run it

```bash
flutter run
```

That's it — the app boots straight into **guest mode** (no Firebase needed yet) and chats
against the live gateway. Sign-in is optional and covered next.

---

## Enable sign-in (optional)

The chat works without signing in. Sign-in adds Google/GitHub accounts and is UX parity with the
website — it uses Firebase project **`sylor-29cab`**. Until you do this, the sign-in buttons show
a friendly "not set up yet" message and **Continue without signing in** always works.

1. Install the FlutterFire CLI once:

   ```bash
   dart pub global activate flutterfire_cli
   ```

2. From `mobile/`, wire this app to the Firebase project. This **regenerates**
   `lib/firebase_options.dart` with real Android/iOS values and drops `google-services.json` /
   `GoogleService-Info.plist` into the native folders (both are git-ignored):

   ```bash
   flutterfire configure --project=sylor-29cab
   ```

3. In the [Firebase console](https://console.firebase.google.com/project/sylor-29cab) →
   **Authentication → Sign-in method**, make sure **Google** and **GitHub** are enabled (the
   GitHub OAuth app + callback URL are already set up for the website).

4. **Android + Google only:** add your signing SHA-1/SHA-256 fingerprints to the Android app in
   the console (`flutter build apk` debug key, then your release key), or Google sign-in returns
   `ApiException 10`. Get the debug SHA-1 with:

   ```bash
   cd android && ./gradlew signingReport
   ```

Re-run `flutter run`; the Google and GitHub buttons now work.

---

## Build a release

**Android APK** (installable file):

```bash
flutter build apk --release
# → build/app/outputs/flutter-apk/app-release.apk
```

**Android App Bundle** (for Play Store):

```bash
flutter build appbundle --release
```

**iOS** (macOS + Xcode):

```bash
flutter build ipa --release
```

For a signed release you'll set up an upload keystore (Android) or a signing team (iOS) the usual
Flutter way — see <https://docs.flutter.dev/deployment>.

---

## How it works

```
lib/
  main.dart                  Boot: init Firebase (falls back to guest), load store, runApp.
  app.dart                   MultiProvider + MaterialApp; light/dark by system; sign-in gate.
  theme.dart                 SylorColors + light/dark ThemeData + SylorPalette (warm paper).
  firebase_options.dart      Public Web config; throws on unconfigured platforms → guest mode.
  models/
    oraculum_model.dart      The two facade models (branding only; same real pool server-side).
    chat.dart                ChatMessage + Conversation (JSON round-trip).
  services/
    chat_client.dart         SSE client for the gateway — Dart mirror of src/lib/chatClient.ts.
    auth_service.dart        Firebase Google/GitHub + guest mode (degrades gracefully).
    conversation_store.dart  History + active chat, persisted via shared_preferences.
  widgets/
    sylor_star.dart          The ✻ mark, drawn with a CustomPainter (same geometry as web/app).
    message_bubble.dart      User bubble (right) / assistant Markdown beside the star (left).
    chat_composer.dart       Multiline input; send button becomes a stop button while streaming.
    model_picker.dart        Bottom-sheet model chooser.
    conversation_drawer.dart History list + new chat + account/sign-out.
    typing_indicator.dart    Three pulsing dots before the first token.
  screens/
    sign_in_screen.dart      Star + Google/GitHub + "Continue without signing in".
    chat_screen.dart         The chat surface; drives the gateway and streams the reply in.
```

The gateway is `https://sylorcode.vercel.app/api/chat` and speaks a tiny SSE protocol
(`data: {"t":"token"|"done"|"error", …}`). Native HTTP clients send no `Origin` header, so the
gateway's same-origin guard lets the app through.

---

## Notes & constraints

- **Mobile only.** Don't run this as Flutter **web** — a browser fetch sends an `Origin` the
  gateway rejects (that guard is what stops the web build from leaking the shared quota). Android
  and iOS are the supported targets.
- **Shared quota.** The gateway enforces a shared daily limit for everyone. When it's hit you'll
  get a "daily limit reached" message and a snackbar; it resets automatically.
- **Firebase is not a gate for chat.** The gateway doesn't verify Firebase tokens — sign-in is
  for account identity/parity with the web app, not for authorizing the model calls. That's why
  guest mode can chat.
- **`flutter_markdown`** is in maintenance/discontinued upstream but works fine for this MVP. If a
  future Flutter release drops it, swap in `flutter_markdown_plus` or `gpt_markdown` — only
  `lib/widgets/message_bubble.dart` imports it.
- **`google-services.json` / `GoogleService-Info.plist`** are intentionally git-ignored; they're
  regenerated by `flutterfire configure`. `lib/firebase_options.dart` *is* committed (public Web
  config) so the project compiles before you configure Firebase.
