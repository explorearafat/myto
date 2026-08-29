/**
 * Slash-command registry.
 *
 * Commands are disk-authored prompt templates, mirroring the Claude CLI's custom
 * commands. Each lives as a single Markdown file, read from two locations and
 * merged:
 *  - global  → `~/.sylor/commands/<name>.md`            (applies everywhere)
 *  - project → `<projectRoot>/.sylor/commands/<name>.md` (overrides global by name)
 *
 * A command file is Markdown with an optional leading `---` frontmatter block:
 *
 *   ---
 *   description: Open a focused code review of the current diff
 *   argument-hint: [path]
 *   ---
 *
 *   Review the changes in $ARGUMENTS and list issues by severity…
 *
 * The body is a prompt TEMPLATE: {@link expandCommand} substitutes `$ARGUMENTS`
 * (everything the user typed after the command name) and the positional `$1`,
 * `$2`, … before the turn runs. {@link parseCommand} is a pure frontmatter reader
 * (unit-tested); {@link loadCommands} scans + merges the two locations. Both are
 * defensive — a missing directory or a malformed file yields no command rather
 * than throwing, so a typo never breaks the composer. Kept free of Electron and
 * settings for easy testing, exactly like the skills registry.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CommandInfo, CommandSource, ConfigScope } from '../../shared/types'
import { expandCommand } from '../../shared/commands'

// Re-exported so existing importers (engine, tests) keep their `../commands/registry`
// path; the implementation now lives in the process-agnostic shared module so the
// renderer's composer can expand commands with the exact same logic.
export { expandCommand }

/** Sylor's global config directory (`~/.sylor`). */
export function sylorHome(): string {
  return join(homedir(), '.sylor')
}

/** Absolute path of the global commands directory (`~/.sylor/commands`). */
export function globalCommandsDir(): string {
  return join(sylorHome(), 'commands')
}

/** Absolute path of a project's commands directory (`<root>/.sylor/commands`). */
export function projectCommandsDir(projectRoot: string): string {
  return join(projectRoot, '.sylor', 'commands')
}

/** The frontmatter fields + body extracted from a command file. */
export interface ParsedCommand {
  description: string
  argumentHint: string
  /** Everything after the frontmatter block (trimmed) — the prompt template. */
  body: string
}

/** Strips a single layer of matching surrounding quotes from a frontmatter value. */
function stripQuotes(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1)
  }
  return value
}

/**
 * Parses a command file's text into frontmatter fields + template body. The
 * frontmatter is a leading `---`-fenced block of simple `key: value` lines — a
 * tiny subset of YAML — so no dependency is required. Recognized keys:
 * `description` and `argument_hint` (also accepts `argument-hint`/`argumentHint`).
 * Everything after the closing `---` is the body; with no frontmatter, the whole
 * text is the body. Total and defensive — unknown keys are ignored; never throws.
 */
export function parseCommand(raw: string): ParsedCommand {
  const text = raw.replace(/^\uFEFF/, '') // drop a leading BOM if present
  const fm = /^\s*---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/.exec(text)
  if (!fm) {
    return { description: '', argumentHint: '', body: text.trim() }
  }
  const [, front, body] = fm
  let description = ''
  let argumentHint = ''
  for (const line of front.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*)$/.exec(line.trim())
    if (!m) continue
    const key = m[1].toLowerCase().replace(/-/g, '_')
    const value = stripQuotes(m[2].trim())
    if (!value) continue
    if (key === 'description') description = value
    else if (key === 'argument_hint' || key === 'argumenthint') argumentHint = value
  }
  return { description, argumentHint, body: body.trim() }
}

/**
 * Scans one commands directory for `*.md` files. Each file is one command, keyed
 * by its basename (sans `.md`). A non-Markdown entry or an unreadable file is
 * skipped; an empty body is dropped. Returns [] when the directory is missing.
 */
function readCommandsDir(dir: string, source: CommandSource): CommandInfo[] {
  let files: string[]
  try {
    files = readdirSync(dir)
  } catch {
    return [] // directory doesn't exist → no commands here
  }
  const out: CommandInfo[] = []
  for (const file of files) {
    if (!file.toLowerCase().endsWith('.md')) continue
    const path = join(dir, file)
    let text: string
    try {
      text = readFileSync(path, 'utf-8')
    } catch {
      continue // not a file, or unreadable
    }
    const parsed = parseCommand(text)
    const name = file.slice(0, -3).trim()
    if (!name || !parsed.body) continue // nameless or empty → not a usable command
    out.push({
      name,
      description: parsed.description,
      argumentHint: parsed.argumentHint,
      body: parsed.body,
      source,
      path
    })
  }
  return out
}

/**
 * Loads and merges the global + project commands. A project command shadows a
 * global one of the same name (project wins), matching the skills/MCP precedence.
 */
export function loadCommands(projectRoot: string | null): CommandInfo[] {
  const merged = new Map<string, CommandInfo>()
  for (const cmd of readCommandsDir(globalCommandsDir(), 'global')) {
    merged.set(cmd.name, cmd)
  }
  if (projectRoot) {
    for (const cmd of readCommandsDir(projectCommandsDir(projectRoot), 'project')) {
      merged.set(cmd.name, cmd)
    }
  }
  return [...merged.values()]
}

// ---------------------------------------------------------------------------
// Writers — used by the in-app "Add a command" and "Remove" actions, and by the
// plugin installer when unpacking a repo's commands. Kept beside the reader so
// the on-disk shape has one owner and round-trips (only the parsed keys).
// ---------------------------------------------------------------------------

/** Slugifies a command name into a safe basename (lowercase, ascii, dashed). */
export function commandFileName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64)
}

/** Fields the UI (or installer) supplies to author a new command. */
export interface NewCommandInput {
  name: string
  description?: string
  argumentHint?: string
  body: string
}

/** Renders a command file: a frontmatter block (only the parsed keys) + the body. */
function renderCommandMd(input: NewCommandInput): string {
  const description = input.description?.trim()
  const argumentHint = input.argumentHint?.trim()
  const lines: string[] = []
  if (description || argumentHint) {
    lines.push('---')
    if (description) lines.push(`description: ${description}`)
    if (argumentHint) lines.push(`argument-hint: ${argumentHint}`)
    lines.push('---', '')
  }
  lines.push(input.body.trim(), '')
  return lines.join('\n')
}

/**
 * Authors a new command on disk at `<scope>/commands/<slug>.md` and returns the
 * file path. Throws a friendly error when the name/body is blank or the slug is
 * empty, or when a project scope is requested with no open project.
 */
export function writeCommand(
  input: NewCommandInput,
  scope: ConfigScope,
  projectRoot: string | null
): string {
  if (!input.name.trim()) throw new Error('Enter a name for the command.')
  if (!input.body.trim()) throw new Error('Enter the command prompt.')
  const slug = commandFileName(input.name)
  if (!slug) throw new Error('The name must contain a letter or number.')
  if (scope === 'project' && !projectRoot) {
    throw new Error('Open a project folder first to add a project-scoped command.')
  }
  const baseDir =
    scope === 'project' ? projectCommandsDir(projectRoot as string) : globalCommandsDir()
  mkdirSync(baseDir, { recursive: true })
  const path = join(baseDir, `${slug}.md`)
  writeFileSync(path, renderCommandMd(input), 'utf-8')
  return path
}

/** Deletes a command's `.md` file. Non-throwing (a missing file is a no-op). */
export function deleteCommandFile(path: string): void {
  rmSync(path, { force: true })
}

/**
 * Caches the commands discovered for a project root, invalidated when the root
 * changes or on an explicit {@link reload} (the composer/settings after the user
 * edits a command on disk), mirroring the skills registry.
 */
class CommandsRegistry {
  private cache: CommandInfo[] | null = null
  private cachedRoot: string | null = null

  /** Commands for `root`, loaded from disk and cached until the root changes. */
  getCommands(root: string | null): CommandInfo[] {
    if (this.cache && root === this.cachedRoot) return this.cache
    this.cachedRoot = root
    this.cache = loadCommands(root)
    return this.cache
  }

  /** Force a fresh disk scan for `root`. */
  reload(root: string | null): CommandInfo[] {
    this.cachedRoot = root
    this.cache = loadCommands(root)
    return this.cache
  }
}

/** The app-wide commands registry, shared by the engine and the commands IPC. */
export const commandsRegistry = new CommandsRegistry()
