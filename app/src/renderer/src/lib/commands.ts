/**
 * Composer autocomplete: slash-command registry (#6) and trigger detection shared
 * with the `@file` mention popover (#7).
 *
 * This module is deliberately store-free and side-effect-free so it can be unit
 * tested in isolation and imported anywhere. It knows *what* the commands are and
 * *when* a trigger is active in the textarea; the actual effects (clearing the
 * chat, toggling Cowork, opening Settings…) live in {@link ChatPanel}, where the
 * Zustand stores are in scope. ChatPanel maps a {@link SlashCommand.id} to an
 * action; here we only describe and match them.
 */

/** The stable identity of each command — ChatPanel switches on this to run it. */
export type CommandId =
  | 'help'
  | 'clear'
  | 'cowork'
  | 'build'
  | 'plan'
  | 'verify'
  | 'model'
  | 'style'
  | 'install'

export interface SlashCommand {
  /** Stable id ChatPanel switches on. */
  id: CommandId
  /** The typed name (without the leading slash), e.g. `clear`. */
  name: string
  /** One-line description shown in the popover. */
  hint: string
  /** A short arg placeholder shown after the name when the command takes one. */
  arg?: string
  /** Destructive/irreversible commands render with a warning tint. */
  danger?: boolean
}

/**
 * The command catalogue. Order here is the order shown in the popover for a bare
 * `/`. Keep names lowercase and single-word — {@link detectTrigger} matches the
 * first word after the slash.
 */
export const SLASH_COMMANDS: SlashCommand[] = [
  { id: 'help', name: 'help', hint: 'List the available slash commands' },
  { id: 'clear', name: 'clear', hint: 'Start a fresh chat', danger: true },
  { id: 'cowork', name: 'cowork', hint: 'Switch to Cowork — the all-rounder (browser, your files, sub-agents)' },
  { id: 'build', name: 'build', hint: 'Switch to Build mode — scaffold & ship a project in a folder' },
  { id: 'plan', name: 'plan', hint: 'Toggle plan mode — plan first, approve before edits' },
  { id: 'verify', name: 'verify', hint: 'Set the Cowork verify command (opens Settings if empty)', arg: 'command' },
  { id: 'model', name: 'model', hint: 'Choose the model (opens Settings)' },
  { id: 'style', name: 'style', hint: 'Set the response style (opens Settings)' },
  { id: 'install', name: 'install', hint: 'Open the plugins manager' }
]

/** Case-insensitive lookup of a command by its typed name. */
export function findCommand(name: string): SlashCommand | undefined {
  const n = name.toLowerCase()
  return SLASH_COMMANDS.find((c) => c.name === n)
}

/**
 * Commands whose typed prefix matches `query` (the text after the slash, before any
 * space). An empty query returns the whole catalogue, so a bare `/` opens the full
 * list.
 */
export function matchSlashCommands(query: string): SlashCommand[] {
  const q = query.toLowerCase()
  if (q === '') return SLASH_COMMANDS
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(q))
}

/**
 * A live autocomplete trigger in the textarea: a `/command` at the very start of the
 * field, or an `@mention` anywhere. `start`/`end` are the character range the chosen
 * completion replaces; `query` is the text typed after the sigil so far.
 */
export interface TriggerToken {
  kind: 'slash' | 'mention'
  query: string
  start: number
  end: number
}

/**
 * Parse `@`/`text` from `full` for a submit-time slash expansion — the fast path
 * where a user types a whole command and hits Enter without touching the popover.
 * Returns the matched command and its trimmed argument, or null when the text is
 * not a recognised command.
 */
export function parseSlashInput(full: string): { command: SlashCommand; arg: string } | null {
  const m = /^\/([a-zA-Z]+)[ \t]*([\s\S]*)$/.exec(full.trim())
  if (!m) return null
  const command = findCommand(m[1])
  if (!command) return null
  return { command, arg: m[2].trim() }
}

/**
 * Given the textarea's current text and caret position, return the active trigger,
 * or null when none applies.
 *
 * Rules, chosen to avoid false positives on ordinary typing:
 * - **Slash** only fires when the field *starts* with `/` and the caret is still
 *   inside that first word (no space yet). So `/cl` triggers, but `and/or`,
 *   `path/to`, or `/verify npm test` (past the space) do not.
 * - **Mention** fires on an `@` that is at the start of the field or preceded by
 *   whitespace, with no whitespace between it and the caret. So `see @src/a` fires
 *   while `foo@bar.com` (the `@` follows a non-space) does not.
 * Mention wins if both could apply, but slash is anchored at 0 so they never overlap.
 */
export function detectTrigger(text: string, caret: number): TriggerToken | null {
  const upto = text.slice(0, caret)

  // Slash: only at the very start of the field, only while typing the command word.
  if (text.startsWith('/')) {
    const word = upto.slice(1)
    if (!/\s/.test(word)) {
      return { kind: 'slash', query: word, start: 0, end: caret }
    }
  }

  // Mention: walk back from the caret to the nearest `@` with no intervening space.
  const at = upto.lastIndexOf('@')
  if (at !== -1) {
    const between = upto.slice(at + 1)
    const before = at === 0 ? '' : upto[at - 1]
    const boundaryOk = at === 0 || /\s/.test(before)
    if (boundaryOk && !/\s/.test(between)) {
      return { kind: 'mention', query: between, start: at, end: caret }
    }
  }

  return null
}

/**
 * Splice `replacement` into `text` over the trigger's `[start, end)` range, adding a
 * trailing space so the caret lands ready for the next word. Returns the new text and
 * the caret offset to place after it.
 */
export function applyCompletion(
  text: string,
  trigger: TriggerToken,
  replacement: string
): { text: string; caret: number } {
  const insert = `${replacement} `
  const next = text.slice(0, trigger.start) + insert + text.slice(trigger.end)
  return { text: next, caret: trigger.start + insert.length }
}
