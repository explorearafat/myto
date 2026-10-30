# Myto Remote — Voice Call Architecture

Call your Myto desktop agent from the phone: natural two-way voice, remote
PowerShell with permission tiers, project tasks that keep running after you
hang up, and automatic callback calls when a task finishes.

## Surfaces

| Piece | Where |
|---|---|
| Call tab + call screens | `mobile/lib/screens/call_tab.dart`, `call_screen.dart`, `incoming_call_screen.dart` |
| Phone call service (signaling, WebRTC, on-device STT, state machine) | `mobile/lib/services/call/call_service.dart` |
| Push routing + `calls` channel | `mobile/lib/services/push_service.dart` |
| Desktop call modules (presence, signaling, session, TTS, executor, tasks, callbacks) | `app/src/main/call/*` |
| Renderer WebRTC peer + TTS audio graph | `app/src/renderer/src/lib/call/webrtc-bridge.ts` |
| Agent loop entry (lifted for headless use) | `app/src/main/provider-ipc.ts` → `handleStreamStart` |
| Backend: push relay | `api/notify.ts` (kind `call`, self-push allowed, `calls` channel) |
| Backend: rules | `firestore.rules` (`users/{uid}/calls/**` owner-only) |

## Data flow

```
Phone mic → on-device STT (streaming partials) → WebRTC DataChannel (JSON text)
  → desktop main → task-manager.runCallTurn → THE REAL agent loop
  (handleStreamStart; cowork mode on the configured workspace)
  → sentence-split → node-edge-tts "en-IN-NeerjaNeural" (en-IN)
  → MP3 per sentence → renderer decodeAudioData → back-to-back scheduling on an
  AudioContext → MediaStreamDestination track → WebRTC audio → phone speaker.
```

- **Signaling**: Firestore documents. `users/{uid}/config/desktop` is presence
  (heartbeat every 15s; stale >45s = offline on the phone). Lifecycle lives in
  `users/{uid}/calls/{callId}`, WebRTC offers/answers/ICE in its `signals`
  subcollection. The desktop talks to Firestore over REST with the renderer's
  Firebase ID token (auto-refreshed); the phone uses the Firestore SDK. Rules
  keep everything strictly owner-only — "pairing" is the shared account.
- **WebRTC roles**: outgoing call (m2d) — phone offers, desktop answers.
  Callback (d2m) — desktop offers, phone answers. STUN by default; TURN from
  desktop settings (default: free public OpenRelay; replaceable in
  Settings › Calls), synced to the phone inside the presence doc.
- **Ringing is real**: the desktop accepts after `answerDelayMs` (5.5s) +
  jitter (0–1.5s) and only THEN starts WebRTC — the 5–7s ring is genuine
  ringing, not a stalled connection.

## Voice loop details

- **Barge-in**: phone STT partials flow to the desktop continuously; any
  partial while Myto speaks stops the TTS queue (breaks the Edge synthesis
  generator + flushes the renderer audio queue) and cancels the agent stream if
  it hasn't started using tools yet.
- **Quick-command fast path**: crisp utterances ("open PowerShell", "check my
  current directory", "run npm install") map straight to PowerShell without a
  model round-trip (`call-text.ts` → `call-executor.ts`).
- **Permission tiers**: every executed command is classified read_only / dev /
  destructive / elevated (`classifyCommand`). Destructive & elevated ALWAYS
  require confirmation — spoken yes/no or the on-screen card — regardless of
  the tier chosen in Settings. Every execution is audited to the `call_audit`
  sqlite table (command, tier, approver, exit code, outcome).
- **Fallback voice**: after 3 consecutive Edge-TTS failures the desktop sends
  sentences as text and the phone speaks them with its own TTS engine.
- **Tasks**: utterances that look like project work go to
  `startTaskFromCall` — a full cowork-mode run of the REAL agent loop that
  survives hanging up. Terminal state (verified by the loop's own verify gate)
  triggers `CallbackManager`: FCM push + incoming call doc; the phone rings
  full-screen; missed calls retry per prefs then degrade to a notification.
  Dedup is guaranteed by the `call_tasks` state machine.

## Security posture

- No unauthenticated surface: Firestore rules are owner-only; signaling
  messages are useless without the user's own session; commands never execute
  from network messages — only from inside the authenticated call session.
- TURN credentials are shared transport config (not desktop secrets); the
  desktop's API keys never leave the desktop.
- Command auditing + per-call sessions in the desktop sidebar (every voice
  conversation is a real, reviewable Myto chat).

## Deploy & run

1. Firestore rules (adds `users/{uid}/calls/**`):
   `firebase deploy --only firestore:rules`
2. Push relay (adds kind `call`): deploy the Vercel project
   (`vercel deploy --prod`).
3. Desktop: `cd app && npm install && npm run dev` — enable calls under
   Settings › Calls (on by default) and pick the Cowork workspace.
4. Phone: build the APK (tag a `v*` release or `flutter build apk` with the
   manifest injections from `.github/workflows/build-android.yml`).

## Manual end-to-end checklist (needs your phone + PC)

- [ ] Desktop signs in → `users/{uid}/config/desktop` appears and heartbeats;
      phone's Call tab shows "Myto is ready".
- [ ] Tap Call → rings ~5–7s (genuine — check the call doc stays `ringing`
      until accept) → Myto greets in Neerja's voice.
- [ ] Speak a question → Myto answers aloud; transcript lines appear.
- [ ] Speak while Myto is talking → playback stops immediately (barge-in).
- [ ] Mute → desktop stops receiving; Speaker toggles output; Hold pauses
      both sides; Keypad sends digits.
- [ ] "Check my current directory" → fast path answers with the path.
- [ ] "Open PowerShell" → a PowerShell window opens on the PC.
- [ ] "Run npm install" (ask tier) → spoken confirmation → yes → runs, output
      streams to the call log.
- [ ] "Fix all build errors in my project" → task accepted → hang up → the
      desktop keeps working → on completion your phone rings with the callback;
      answering plays the completion script.
- [ ] Decline the callback → notification arrives → retry per prefs → after
      `retryLimit` it stops (check `call_tasks` rows).
- [ ] Desktop quits mid-call → phone lands in "reconnecting" then ends
      gracefully; presence goes dark within ~15s.
- [ ] Revoke the device (`users/{uid}/config/desktopDevices/{id}` → revoked
      true) → desktop stops answering within one heartbeat.
- [ ] Different networks: turn off phone Wi-Fi and call over mobile data
      (exercises TURN; check More › Connection shows "Via TURN relay").

## Known limitations (v1)

- Android background mic: while the phone screen is off, Android can suspend
  the recognizer; a foreground-service microphone type is future work.
- One desktop instance at a time (single-instance lock; a second call while
  busy is declined with `busy`).
- The callback push is notification+data; if the vendor kills the app
  process the full-screen intent still fires from the `calls` channel.
