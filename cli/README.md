# Myto CLI

The Myto agent in your terminal. It works directly on your project folder: it
reads, creates, edits and searches files, runs shell commands, and fetches/
searches the web — until your task is done.

```
npm install -g mytocode
cd your-project
myto "add dark mode to the settings page"
```

> Published on npm as **`mytocode`** — the bare name `myto` is blocked as too
> similar to existing packages. The installed command is still `myto`.

## The interface (v1.5)

On an interactive terminal `myto` runs inside a **docked shell**: the alternate
screen buffer with a fixed layout — nothing ever reprints, every update happens
in place. The agent face pins to the top and assembles line by line (one blink)
on first draw:

```
    ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·
 \                                       /
  \         ──              ──          /
   ##       (*)            (*)        ##
   ##                                 ##
   |           M  Y  T  O             |
   |                                  |
    \       \______________/         /
     \                              /
 ╭───────────────────────────────────────────╮
 │   Working Folder  ~/projects/new-app      │
 │   Model           claude-3.5-sonnet       │
 │   Effort          Advanced                │
 │   API Status      Connected · gateway     │
 ╰───────────────────────────────────────────╯
```

- **The dashboard rows are live controls.** With an empty input, **↑/↓** move
  the `▸` selection and **←/→** (or Enter) change it in place: Effort cycles
  Low → Balanced → Advanced, Working Folder opens the folder browser, Model
  opens the live model picker. Only the dashboard repaints — the rest of the
  screen never moves.
- **Messages scroll in their own region** between the face and the input, so
  tool output never pushes the frame around. Tool lines land as colour-coded
  `⏺ Write(src/app.ts)` with `⎿` results (green writes, amber shell, red
  failures).
- **The input box docks at the bottom** with a block caret and an `Ask Myto…`
  placeholder; the slash-command dropdown appears above it while you type
  `/`. Under it a live strip:

```
 ↑↓ tune · ⇧⇥ ask before acting · ⌃E effort Balanced
```

  **Shift+Tab** cycles the permission policy (ask ⇄ auto-approve), **Ctrl+E**
  cycles effort (Low 15 · Balanced 40 · Advanced 200 tool turns) — same as the
  dashboard rows and `/permissions`, `/effort`.

- **Submissions** lift into a blue panel — `User (12:30 PM): build a dashboard`
  — while the model's chain-of-thought prints dim/ash at low opacity, and the
  final answer settles into its own gray panel labelled `Myto (12:30 PM)`,
  rendered as terminal markdown.

On terminals too small for the shell (or pipes/CI) everything degrades to
sequential printing; piped runs list instead of hang and a closed stdin exits
cleanly. Works on Windows PowerShell / Windows Terminal, macOS and Linux.

**First run** — before the shell appears, a wizard signs you in, all driven by
keyboard or mouse:

1. **Provider** — an OpenAI-compatible gateway (OpenAI, OpenRouter, vLLM, any
   `/v1` endpoint) or local Ollama.
2. **Credentials** — the API key is masked as you type (`****`), stored in
   `~/.myto/config.json`, never echoed or logged.
3. **Model** — fetched live from the endpoint and picked from a menu; if the
   endpoint lists nothing you type the id.
4. **Folder** — a mouse-usable directory browser: descend, go up, or commit to
   the folder Myto should work in.

## The numbered menu

`/menu` opens a hub with seven
destinations — Chat (a plain streaming assistant with no tools), Cowork (the
agent interface), Connector (switch provider, set the base URL / key, run a
real connection test with latency), Skills, Command, Plugin, Model — pick with
number keys, ↑/↓ + Enter, or a mouse click; Esc/q exits.

- **Skills** — instruction packs that shape how the agent works. A skill is a
  markdown file whose first `# heading` is its name; the body rides the system
  prompt. Discover in `<workspace>/.myto/skills/` then `~/.myto/skills/`
  (workspace wins on a name clash). Create from the menu, run with a task.
- **Command** — one-shot quick actions (explain the codebase, review the
  working diff, write/fix tests, write `MYTO.md`) plus your prompt-kind plugins.
- **Plugin** — JSON manifests in `~/.myto/plugins/` or
  `<workspace>/.myto/plugins/` that extend the CLI:

  ```json
  {
    "name": "deploy-check",
    "title": "Deploy check",
    "kind": "prompt",            // or "command"
    "description": "Verify the deploy is healthy.",
    "prompt": "Check the deploy scripts and report risks.",
    "command": "npm run build"   // for kind: "command"
  }
  ```

## Build (from this repo)

The CLI reuses the desktop app's real engine — the gateway/Ollama providers, the
`fs`/`command`/`search`/`plan`/`think`/`web` tools, the ` ```myto:tool ` stream
parser, and the stall guards — bundled into one self-contained `dist/cli.js`
(no runtime dependencies).

```
npm install          # from the repo root (installs esbuild/vitest/typescript)
cd cli
npm run typecheck    # tsc --noEmit over cli/src + the reused app modules
npm test             # vitest: loop + config suites
npm run build        # esbuild -> dist/cli.js
```

## Publish (enables `npm install -g mytocode`)

The package publishes under the public name `mytocode`. To release a new version:

```
npm login                  # once per machine
cd cli
npm run build              # esbuild -> dist/cli.js
npm publish                # publishConfig.access is already "public"
```

`prepublishOnly` runs the build automatically on publish, so `npm run build` is a
belt-and-braces check rather than a requirement. (It is deliberately *not*
`prepare`: a `prepare` script runs on every consumer install too, which makes npm
flag the package as having install scripts for no benefit — the tarball already
contains the built `dist/cli.js`.)

To install from disk without the registry (offline / air-gapped):

```
cd cli && npm pack
npm install -g ./mytocode-1.1.0.tgz
```

## Configure (first run)

```
myto config --base-url https://api.openai.com/v1 --api-key sk-… --model gpt-4o-mini
myto config --base-url https://api.anthropic.com/v1 --api-key sk-ant-… --model claude-sonnet-4-5
myto config --ollama-url http://localhost:11434 --model llama3.1:8b
```

Or with environment variables (highest priority):

```
MYTO_BASE_URL, MYTO_API_KEY, MYTO_MODEL, MYTO_PROVIDER,
MYTO_AUTH_SCHEMA, MYTO_AUTH_HEADER, MYTO_OLLAMA_URL, MYTO_DIR
```

Resolution order: **env > `~/.myto/config.json` > the Myto desktop app's saved
settings** — if you already configured the app, the CLI just works.

## Commands

| Command | What it does |
|---|---|
| `myto` | Interactive session — main menu: Chat · Cowork · Connector · Skills… |
| `myto "<task>"` | One-shot task in the current folder |
| `myto --dir <path> "<task>"` | One-shot task in a specific folder |
| `myto config --base-url … --api-key … --model …` | Save config |
| `myto --auto "<task>"` | One-shot without permission prompts |
| `myto models` | List models the endpoint serves |
| `myto help` | Help |

## Session features (Cowork mode)

Cowork works like a real agentic CLI (the Claude Code / Freebuff school):

- **Session memory** — your conversation carries across prompts, so follow-ups
  like "now add tests for what you just wrote" work. `/clear` starts fresh,
  `/compact` folds the session into a summary to free context.
- **Permission prompts** — before every side effect (write / edit / delete /
  shell / code) Myto asks: allow once, allow for the session, or decline and
  redirect. `/permissions` toggles auto-approve; `myto --auto "task"` skips
  prompting in one-shot runs.
- **Markdown answers** — the final answer renders as terminal markdown
  (headings, lists, fenced code), not raw model text.
- **Interrupts** — `Esc` or `Ctrl-C` stops the running agent mid-turn; `↑`
  recalls earlier prompts; `!` runs a shell command directly.
- **Project memory** — `/init` surveys the project and writes a `MYTO.md` that
  future runs read; `/memory` shows it; `/status` prints the current setup.
- **Animated status** — a spinner with elapsed seconds (`✻ Thinking… (3s · esc
  to interrupt)`) covers generation; tool calls print as `⏺ Write(src/app.ts)`
  with `⎿` results.

## How it works

- **Same protocol as the app.** The model streams; tool calls ride the
  ` ```myto:tool ` fenced protocol parsed by the same incremental parser
  (`app/src/main/tools/toolParser.ts`).
- **Same tools.** `list_dir`, `read_file`, `write_file`, `edit_file`,
  `delete_file`, `search_code`, `find_files`, `run_command`, `run_code`,
  `web_fetch`, `web_search`, `wiki_search`, `update_plan`, `think` — the real
  implementations, sandboxed to the working folder (`resolveInWorkspace`).
- **Same stall guards.** The CLI loop ports the app's guard cascade
  (`cowork-guards.ts`): plan-completion gate, auto-persist of narrated code,
  announced-action / false-limit / empty-reply nudges, oscillation and
  research-stall stops, batched-call draining.
- **Safety.** File tools are confined to the working folder (lexical + realpath
  containment). `run_command`/`run_code` execute with your user's privileges —
  with the default permission policy each one asks before it acts; `/permissions`
  or `--auto` lifts the prompt. Ctrl-C twice force-quits.
