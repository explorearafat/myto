import type { PermissionMode, ReasoningEffort, WorkMode } from '../shared/types'

/**
 * The headless CLI's parsed options. Kept deliberately small and flat so the
 * runner ({@link ../cli/run}) and the entry ({@link ../cli/index}) can be driven
 * from a plain object in tests, with no argv or process state.
 */
export interface CliOptions {
  /** The user turn's prompt. May be '' after parsing — the entry then tries stdin. */
  prompt: string
  /** Approval posture; default `auto-edit` (auto reads + edits, gate the rest). */
  permissionMode: PermissionMode
  /** Top-level mode; default `code` (the full folder agent). */
  mode: WorkMode
  /** Reasoning effort; default `medium`. */
  effort: ReasoningEffort
  /** Workspace root the engine operates on; null → the entry uses `process.cwd()`. */
  root: string | null
  /** Explicit userData override; null → the entry resolves the default location. */
  userDataDir: string | null
  /** Emit every WorkflowEvent as JSONL to stdout instead of the streamed answer. */
  json: boolean
}

/** Result of {@link parseCliArgs}: a run request, a help request, or a usage error. */
export type ParsedArgs =
  | { kind: 'run'; options: CliOptions }
  | { kind: 'help' }
  | { kind: 'error'; message: string }

const PERMISSION_MODES: readonly PermissionMode[] = ['ask', 'auto-edit', 'autonomous']
const WORK_MODES: readonly WorkMode[] = ['cowork', 'code']
const EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'max']

/** Usage text, printed by `--help`. Exported so tests can assert the key flags. */
export const USAGE = `sylor — headless AI coding engine (print mode)

Usage:
  sylor -p "<prompt>"              Run one turn, stream the answer to stdout
  echo "<prompt>" | sylor -p       Read the prompt from stdin
  sylor "<prompt>" [flags]         Prompt as a positional argument

Flags:
  -p, --print <prompt>       The prompt to run (or pass on stdin / as positional)
      --permission-mode <m>  ask | auto-edit | autonomous  (default: auto-edit)
      --mode <m>             cowork | code                 (default: code)
      --effort <e>           low | medium | high | max      (default: medium)
  -C, --cwd, --root <dir>    Workspace root to operate on  (default: cwd)
      --user-data <dir>      Override the userData directory (settings/DB/memory)
      --json                 Emit each engine event as JSONL to stdout
  -h, --help                 Show this help

Headless approvals: reads and (in auto-edit) file edits run automatically;
commands, network, and other sensitive tools are skipped unless you pass
--permission-mode autonomous.`

/**
 * Parse `argv` (already sliced past `node <script>`) into {@link ParsedArgs}. Pure
 * — no process/env/filesystem access — so the whole surface is unit-testable.
 * Supports `--flag value` and `--flag=value`; a bare positional is taken as the
 * prompt when `-p` is absent. Unknown flags, missing values, and out-of-range enum
 * choices produce a usage error rather than a silent default.
 */
export function parseCliArgs(argv: readonly string[]): ParsedArgs {
  const options: CliOptions = {
    prompt: '',
    permissionMode: 'auto-edit',
    mode: 'code',
    effort: 'medium',
    root: null,
    userDataDir: null,
    json: false
  }
  const positionals: string[] = []
  let promptFromFlag = false

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '-h' || token === '--help') return { kind: 'help' }
    if (token === '--json') {
      options.json = true
      continue
    }

    // Split `--flag=value`; otherwise a value flag consumes the next token.
    const eq = token.startsWith('--') ? token.indexOf('=') : -1
    const name = eq >= 0 ? token.slice(0, eq) : token
    const inlineValue = eq >= 0 ? token.slice(eq + 1) : null
    const takeValue = (): string | null => {
      if (inlineValue !== null) return inlineValue
      const next = argv[i + 1]
      if (next === undefined) return null
      i++
      return next
    }

    switch (name) {
      case '-p':
      case '--print': {
        // The prompt value is OPTIONAL: `-p "text"` runs that text, while a bare
        // `-p` (nothing, or only another flag, after it) reads the prompt from
        // stdin — the documented `echo … | sylor -p` idiom. So consume the next
        // token only when it's a real value, not a flag. A prompt that must start
        // with '-' can always use the `--print=…` form.
        if (inlineValue !== null) {
          options.prompt = inlineValue
          promptFromFlag = true
          break
        }
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith('-')) {
          options.prompt = next
          promptFromFlag = true
          i++
        }
        break
      }
      case '--permission-mode': {
        const v = takeValue()
        if (v === null || !PERMISSION_MODES.includes(v as PermissionMode)) {
          return {
            kind: 'error',
            message: `--permission-mode must be one of: ${PERMISSION_MODES.join(', ')}`
          }
        }
        options.permissionMode = v as PermissionMode
        break
      }
      case '--mode': {
        const v = takeValue()
        if (v === null || !WORK_MODES.includes(v as WorkMode)) {
          return { kind: 'error', message: `--mode must be one of: ${WORK_MODES.join(', ')}` }
        }
        options.mode = v as WorkMode
        break
      }
      case '--effort': {
        const v = takeValue()
        if (v === null || !EFFORTS.includes(v as ReasoningEffort)) {
          return { kind: 'error', message: `--effort must be one of: ${EFFORTS.join(', ')}` }
        }
        options.effort = v as ReasoningEffort
        break
      }
      case '-C':
      case '--cwd':
      case '--root': {
        const v = takeValue()
        if (v === null) return { kind: 'error', message: `${name} needs a directory` }
        options.root = v
        break
      }
      case '--user-data': {
        const v = takeValue()
        if (v === null) return { kind: 'error', message: `--user-data needs a directory` }
        options.userDataDir = v
        break
      }
      default: {
        if (name.startsWith('-')) return { kind: 'error', message: `unknown flag: ${name}` }
        positionals.push(token)
      }
    }
  }

  if (positionals.length > 0) {
    if (promptFromFlag) {
      return {
        kind: 'error',
        message: 'pass the prompt with -p or as a positional argument, not both'
      }
    }
    options.prompt = positionals.join(' ')
  }

  return { kind: 'run', options }
}
