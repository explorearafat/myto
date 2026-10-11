# Myto CLI

The Myto agent in your terminal. It works directly on your project folder: it
reads, creates, edits and searches files, runs shell commands, and fetches/
searches the web — until your task is done.

```
npm install -g myto
cd your-project
myto "add dark mode to the settings page"
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

## Publish (enables `npm install -g myto`)

The package publishes under the public name `myto`. To release a new version:

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

Until it is on the npm registry, install straight from this repo:

```
cd cli && npm pack
npm install -g ./myto-1.0.0.tgz
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
| `myto` | Interactive session in the current folder |
| `myto "<task>"` | One-shot task in the current folder |
| `myto --dir <path> "<task>"` | One-shot task in a specific folder |
| `myto config --base-url … --api-key … --model …` | Save config |
| `myto models` | List models the endpoint serves |
| `myto help` | Help |

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
  review the `▸ $ command` lines as they print. Ctrl-C twice force-quits.
