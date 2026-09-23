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

## OneDrive note

This project lives under a OneDrive-synced folder. `node_modules`, `out`, `release`,
and `.vite` are `.gitignore`d — you should also **exclude them from OneDrive sync**
(OneDrive Settings → "Choose folders") to avoid native-binary corruption and file locks.
