# Myto

A premium desktop AI coding workspace inspired by Claude Code. Myto combines local
(Ollama) and remote (gateway) LLMs, a Monaco-based code editor, an integrated terminal,
and intelligent, token-efficient project workflows.

> **Status:** Phase 1 — Core Infrastructure & UI Shell. This is the app skeleton:
> layout, theming, editor, and terminal are in place. AI logic, real command execution,
> and session persistence arrive in later phases.

## Tech stack

- **Desktop:** Electron 43 (frameless window, custom title bar)
- **Bundler:** electron-vite (Vite 7) with HMR for main + renderer
- **UI:** React 19 + TypeScript 5.9, Tailwind CSS v4 (CSS-first `@theme`)
- **Editor:** Monaco (bundled locally — fully offline, no CDN)
- **Terminal:** xterm.js (display-only in Phase 1)
- **Layout:** react-resizable-panels
- **State:** Zustand
- **Tooling:** ESLint 9 + Prettier, Vitest, electron-builder

## Getting started

```bash
npm install
npm run dev
```

## Scripts

| Script                 | Description                                         |
| ---------------------- | --------------------------------------------------- |
| `npm run dev`          | Launch the app with hot reload                      |
| `npm run build`        | Typecheck + build main/preload/renderer             |
| `npm run typecheck`    | Type-check the node and web tsconfigs               |
| `npm run lint`         | Lint with ESLint                                    |
| `npm run format`       | Format with Prettier                                |
| `npm test`             | Run Vitest smoke tests                              |
| `npm run pack:dir`     | Build an unpacked app into `release/win-unpacked`   |
| `npm run dist:win`     | Build a Windows NSIS installer into `release/`      |

## Project structure

```
src/
├─ main/        Electron main process (window, IPC handlers)
├─ preload/     contextBridge — the typed window.myto API
├─ shared/      Types + IPC channel constants shared across processes
└─ renderer/    React UI (components, store, styles, Monaco/xterm)
```

## Video & photo editing

In **Build**/**Cowork** mode (with a working folder open), Myto can edit video and
images from plain language — e.g. _"cut the silences and make a 30s vertical reel with
subtitles."_ The model never touches pixels: it calls small, model-agnostic tools and a
**bundled FFmpeg/ffprobe** (`ffmpeg-static` / `ffprobe-static`) does the work, so the same
tools work across every provider Myto supports (Claude, Gemini, GLM, DeepSeek, …).

| Tool              | What it does                                                              |
| ----------------- | ------------------------------------------------------------------------- |
| `probe_video`     | Report duration, size, and stream info (read-only)                        |
| `trim_clip`       | Cut a `[start, end]` range to a new file                                  |
| `concat_clips`    | Join two or more clips in play order                                      |
| `extract_frames`  | Pull stills → images for the model to _see_ (count + resolution capped)   |
| `transcribe_audio`| Speech → timestamped caption segments (see config below)                  |
| `detect_silence`  | Find silent gaps and the keep-ranges to feed `apply_edit_plan`            |
| `add_subtitles`   | Burn an SRT onto the video                                                |
| `mix_audio`       | Replace or duck a video's audio with another track                        |
| `resize_or_crop`  | Reframe to an aspect ratio (`9:16`, `1:1`, …) by crop / pad / stretch     |
| `apply_edit_plan` | Run a multi-step plan (keep-ranges → speed → resize → subtitles → audio) in **one** render |
| `run_ffmpeg`      | Escape hatch: a raw, folder-restricted FFmpeg argument vector             |

**Safety.** Tools always pass an **argument array**, never a shell string. Inputs and
outputs are sandboxed to the working folder (symlink-safe, fail-closed); Myto **never
overwrites the source** — results are written to a `myto-edits/` subfolder with unique
names. Failures return a short, readable message with the FFmpeg stderr tail, not a raw log.
A finished video is previewed inline in the reply as a `<video controls>` player.

**Transcription config.** `transcribe_audio` resolves a backend from the environment (no
Settings UI):

1. **Local whisper.cpp** — set `WHISPER_CPP_PATH` (the `whisper-cli`/`main` binary) and
   `WHISPER_CPP_MODEL` (a `.bin` model). Audio is decoded to 16 kHz mono WAV first.
2. **OpenAI-compatible API** — set `MYTO_TRANSCRIBE_API_KEY` (optionally
   `MYTO_TRANSCRIBE_API_BASE`, default `https://api.openai.com/v1`, and
   `MYTO_TRANSCRIBE_API_MODEL`, default `whisper-1`).
3. Otherwise the tool returns a clear "not configured" note naming these variables.

**Exposing the tools as an MCP server (how-to, not shipped).** These tools are plain
`ToolDef`s (`src/main/tools/media-edit.ts`) over a pure core (`ffmpeg-core.ts`) and an
Electron runtime (`ffmpeg-runtime.ts`). To expose them over MCP, wrap the pure builders in a
small stdio MCP server (`@modelcontextprotocol/sdk`): map each tool's `schema` to an MCP
input schema, spawn FFmpeg with the bundled `ffmpegPath`/`ffprobePath`, and keep the same
path-sandboxing. This is intentionally **not** bundled yet — the tools ship in-process only.

## OneDrive note

This project lives under a OneDrive-synced folder. `node_modules`, `out`, `release`,
and `.vite` are `.gitignore`d — you should also **exclude them from OneDrive sync**
(OneDrive Settings → "Choose folders") to avoid native-binary corruption and file locks.
