# Myto — release status

_Last updated: after the v0.9.0 mobile push._

## Where things stand

| Item | State |
| --- | --- |
| Mobile app version | `0.9.0+12` (`mobile/pubspec.yaml`) |
| Pushed to GitHub | `main` — commit `4f2c9ba` |
| Release tag | `v0.9.0` |
| Android build (CI) | latest "Build Android App" run on `main`: **success**, no compile errors |
| Other platform builds (Windows / Linux / macOS) | triggered with the same push — not individually re-checked yet |
| Download page | needs its app links pointed at the `v0.9.0` APK |

## What changed in the app

- **Chat tab is now a chat list.** It shows the groups `Agents` (one row per specialist),
  `Rooms` (the group chats) and `Chats` (your saved conversations). No demo data anywhere —
  every thread starts empty.
- **1-to-1 agent chats** — tapping a specialist opens a full-screen chat where that agent
  answers in its own persona (app-generated avatar, own colour).
- **Research rooms** — a group chat: after you speak, each member takes a turn, then a
  consolidated *Research Report* bubble closes the discussion.
- **Agents tab is the rooms hub** — create a room, pick the specialists, name it, tap it
  to open the group chat.
- **Myto assistant** has its own route (the plain bring-your-own-key streaming chat).
- Every conversation opens as a pushed route, so the bottom nav hides while a chat is open.
- Chat backdrop uses the drawn/parchment doodle wallpaper; the composer no longer shows a
  green focus border.

## Next steps

1. Confirm the Windows / Linux / macOS builds from the same tag went green.
2. Point the website download page at the `v0.9.0` APK so anyone can install it.
3. Post the release note (what's new in 0.9.0) on the site download section.