# Myto – Project Plan

## Project Overview
**Myto** is a desktop application inspired by the functionality and interface of Claude Code. It serves as a full‑featured AI‑powered coding workspace that combines local and remote large language models, a smart code editor, an integrated terminal, and intelligent project management. The goal is to provide a premium, responsive, and token‑efficient development environment that works both online and offline.

---

## Objectives
- Build a desktop AI IDE that feels modern, minimal, and premium (dark theme, Claude‑inspired aesthetics).
- Allow users to choose between **local (Ollama)** and **remote gateway** model providers.
- Streamline the AI‑assisted development workflow: intent understanding → planning → execution → verification.
- Reduce token consumption with aggressive context reuse, incremental reasoning, and lazy loading.
- Persist session memory so that context, project state, and previous results survive restarts.
- Automate file editing, terminal commands, dependency management, testing, and debugging safely and transparently.

---

## Core Features

### 1. Model Provider Settings
- **Ollama Engine** – Local model execution. Works offline; no internet required.
- **Gateway** – Connect to third‑party LLM APIs via:
  - Base URL
  - API Key
  - Authentication Schema (e.g., Bearer, custom header)
- **Model Selection**
  - Model Name (display name)
  - Model ID (actual identifier sent to API)
- **Test Connection** button – Sends a probe request with the selected model ID.  
  - Success → green indicator, continue.  
  - Failure → error message displayed.

### 2. User Interface Layout
- **Top Navigation Bar**  
  Project selector, model selector, permission mode, environment status (Local/Remote), notifications, user profile.
- **Left Sidebar**  
  Project list, recent sessions, chat history, Git status, settings access.
- **Center Panel (AI Workspace)**  
  Conversation view (user ↔ AI), planning summaries, reasoning steps, code suggestions, proposed file diffs, chat input.
- **Right Panel (Code Editor)**  
  Multi‑tab code editor with syntax highlighting and line numbers, file explorer.
- **Bottom Panel (Integrated Terminal)**  
  Command execution, logs, build output. Resizable and dockable.

### 3. AI Interaction & Workflow
- **Intent Analysis (Low‑token)**  
  The user’s prompt is first transformed into a concise internal request to determine:  
  - Is it a question or an edit request?  
  - If it involves file/project changes, verify context, structure, dependencies.
- **Intent Confirmation**  
  An interpreted response like *“You want to…”* is shown; the user confirms before execution begins.
- **Step‑by‑step Reasoning**  
  The AI performs: scanning → file inspection → dependency analysis → error detection → planning → tool execution → generation → testing → debugging → verification.  
  Live activity updates are displayed (e.g., “Analyzing project…”, “Reading files…”, “Running tests…”).
- **Final Response**  
  Comprehensive, accurate, well‑structured, context‑aware solution.

### 4. Automated Tool Execution
- **Safety First** – No command runs without prior analysis of project state and potential impact.
- **Step‑by‑step Terminal Usage** – Each command’s output is verified before the next step.
- **Error Handling** – On failure, the AI inspects logs, configs, and source code, then applies a fix.
- **File Editing** – Read file → understand code → evaluate impact → modify → validate → build/test.
- **Live Progress** – Continuous status updates (e.g., “Installing dependencies…”, “Verifying changes…”, “Build successful”).

### 5. Token & Performance Optimizations
- **Progressive Context Loading** – Start with minimal required files; expand only when needed.
- **Context Reuse** – Previously read files, terminal outputs, and verified conclusions are reused.
- **Incremental Reasoning** – Only re‑evaluate changed parts; keep previous valid conclusions.
- **Caching** – Frequently used metadata, file indexes, dependency graphs, and terminal results.
- **Parallel Execution** – Independent tasks (file reading, indexing, terminal commands) run concurrently.
- **Lightweight Intent Parsing** – Quick initial response before full processing.

### 6. Session Memory & Persistence
- Store verified session context, code, terminal outputs, analysis results, user preferences locally.
- Each session has a unique ID; memory is independently managed.
- On restart, load relevant context and only process new/changed data.
- Users can clear, export, or restore any session.

### 7. Documentation Awareness
- Before working, review README, API specs, package.json, build scripts, environment configs, comments.
- Follow existing conventions (coding style, naming, dependency management).  
- If undocumented, infer the most consistent patterns from the codebase.

---

## Optional Features (Future)
- Multi‑repository Git integration with visual diff.
- Collaborative session sharing.
- Plugin system for custom agents/tools.
- Advanced permission management (e.g., read‑only, sandboxed commands).
- Cloud backup for sessions.

---

## System Architecture
[User Interface Layer] [AI & Automation Layer] [Model Layer]

| Desktop App (Electron/Tauri)
| - React/Vue UI
| - Monaco/CodeMirror Editor
| - Xterm.js Terminal
|
| AI Core (Rust/Node.js)
| - Intent Parser
| - Workflow Engine (Multi‑Agent Pipeline)
| - Tool Manager (FS, Terminal, Git)
| - Context Manager & Cache
| - Session Manager
|
| Model Providers
| - Ollama (local)
| - Gateway (REST API)
| - (Optional) Direct Cloud APIs


**Key Design Principles:**
- All file and terminal operations run in a sandboxed, permission‑controlled environment.
- Model communication is abstracted behind a unified provider interface.
- Caching and context reuse are built into the core engine.

---

## Technology Stack
- **Desktop Framework:** Electron or Tauri (for performance, Tauri recommended)
- **Frontend:** React / Next.js (or Vue) with TypeScript
- **UI Styling:** Tailwind CSS + custom dark theme
- **Code Editor:** Monaco Editor (VS Code core) or CodeMirror 6
- **Terminal:** xterm.js + node‑pty
- **Backend (core services):** Node.js or Rust (via Tauri commands)
- **Local Model:** Ollama
- **Data Persistence:** SQLite (via better‑sqlite3) for sessions, settings, cache
- **State Management:** Zustand or Redux Toolkit
- **Testing:** Vitest, Playwright, post‑build integration tests

---

## Folder Structure (Tentative)
sylor/
├── package.json
├── src/
│ ├── main/ # Electron/Tauri main process
│ │ ├── index.ts
│ │ ├── session/
│ │ ├── tools/
│ │ ├── providers/
│ │ └── ...
│ ├── renderer/ # UI (React)
│ │ ├── components/
│ │ ├── hooks/
│ │ ├── pages/
│ │ ├── store/
│ │ └── styles/
│ ├── shared/ # Shared types, constants, utilities
│ └── ...
├── resources/ # Icons, logos
├── plan.md # This file
└── README.md

---

## UI/UX Plan
- **Theme:** Premium dark, inspired by Claude’s design language – deep grays, subtle gradients, accent colors (#D97706? – orange/amber), clean typography.
- **Layout:** Fully resizable panels, collapsible sidebars.
- **Color Scheme:** Background: #0D1117, Surface: #161B22, Primary: #F59E0B, Text: #E6EDF3.
- **Logo:** Minimalist geometric mark, reminiscent of Claude’s logo but distinct (maybe an abstract “S”).
- **Animations:** Subtle, purposeful; no heavy transitions.

---

## Development Phases & Milestones

### Phase 1 – Core Infrastructure & UI Shell
- Set up Tauri/Electron project with React + TypeScript.
- Implement basic window management, dark theme, panel layout.
- Build left sidebar (static), center chat (static), right editor shell (Monaco), terminal (xterm).
- Wire navigation bar with dummy selectors.
- Task status: `Pending`

### Phase 2 – Model Provider Integration
- Implement settings page with Ollama and Gateway forms.
- Build provider abstraction layer: `getCompletion()`, `streamCompletion()`.
- Ollama integration (list models, chat).
- Gateway integration (Base URL, API Key, Auth Schema, Test Connection).
- Model selector with dynamic list.
- Task status: `Complete`

### Phase 3 – AI Core & Workflow Engine
- Intent parser (lightweight prompt rewriting) — LLM classification with heuristic fallback.
- Workflow pipeline: analyze → scan → read → plan → generate (read-only; edit/terminal deferred to Phase 4).
- Context manager: bounded lazy file walk, key-doc overview, caching.
- Live progress updates via IPC (staged WorkflowEvent stream, cancellable).
- Live chat UI: streamed assistant replies, intent restatement, activity chips.
- Task status: `Complete`

### Phase 4 – Tool Execution & Safety
- Sandboxed terminal execution (node‑pty) with output parsing.
- File system operations (read, write, diff) with impact analysis.
- Error detection and auto‑remediation logic.
- Permission modes (read‑only, ask, execute).
- Task status: `Pending`

### Phase 5 – Session Memory & Persistence
- SQLite schema for sessions, messages, file cache, terminal logs.
- Auto‑save/restore on restart.
- Session management (export, clear, delete).
- Task status: `Pending`

### Phase 6 – Documentation Awareness & Advanced Features
- README/config parser.
- Convention inference from codebase.
- Multi‑agent task chaining (dynamic workflow steps).
- Performance profiling and optimization.
- Task status: `Pending`

### Phase 7 – Testing, Packaging & Distribution
- Unit, integration, and E2E tests.
- Build for Windows, macOS, Linux.
- Auto‑update support.
- User documentation.
- Task status: `Pending`

---

## Task Breakdown & Dependency Order
1. Initialize project, set up repo, CI/CD. `Blocked by: None`
2. Build UI shell (panels, theme, navigation). `Depends on: 1`
3. Integrate Monaco editor and xterm terminal. `Depends on: 2`
4. Implement settings and model provider UI + logic. `Depends on: 2`
5. Develop context manager and caching. `Depends on: 1`
6. Create intent parser and lightweight confirmation flow. `Depends on: 2`
7. Build step‑by‑step workflow engine. `Depends on: 5, 6`
8. Implement tool manager (FS + terminal) with safety checks. `Depends on: 7`
9. Add session storage and restore. `Depends on: 5`
10. Wire up chat interface with real‑time progress. `Depends on: 2, 7`
11. Implement Git status and file explorer. `Depends on: 2`
12. Add documentation awareness. `Depends on: 8`
13. Integrate all components, end‑to‑end workflow. `Depends on: 8, 9, 10, 11`
14. Testing & optimization. `Depends on: 13`
15. Packaging & release. `Depends on: 14`

---

## Testing Strategy
- **Unit tests:** Core utilities, intent parser, context manager, tool safety checks.
- **Integration tests:** Model provider responses, file system operations, terminal commands.
- **End‑to‑end tests:** Simulate full user interactions – ask question, edit file, run build, verify output.
- **Performance tests:** Token usage tracking, response time measurement, memory footprint of session storage.

---

## Deployment Plan
- CI/CD pipeline (GitHub Actions) to build binaries for each platform.
- Notarization for macOS, signing for Windows.
- Distribution via GitHub Releases initially; later consider dedicated website.

---

## Future Improvements
- Plugin marketplace.
- Voice input support.
- Cloud session syncing.
- Team collaboration mode.
- Advanced analytics dashboard for token usage and productivity.

---
