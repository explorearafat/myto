import { mkdirSync, readFileSync, appendFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolCall } from './tools/toolParser'
import { recallMemory } from './memory-recall'

/*
 * Cowork project memory — the `.myto/` folder.
 *
 * Just like Claude Code keeps a `.claude/` directory, Myto keeps a `.myto/` folder
 * inside the working folder to give a Cowork run MEMORY across turns. Without it, each
 * new message starts a fresh tool loop that only sees the chat text — so the agent
 * re-explores, re-scaffolds, and repeats work it already did. With it, the main process
 * writes a running JOURNAL of the meaningful actions taken (files written, commands run)
 * and the goals asked, then injects that journal back into the next turn's context. The
 * agent reads "here is what you already did in this folder" and continues instead of
 * restarting.
 *
 * The folder was named `.sylor/` before the Myto rebrand; a legacy `.sylor/journal.md`
 * is migrated into `.myto/` on first touch and still read as a fallback, so an in-flight
 * project keeps its history seamlessly.
 *
 * Everything here is best-effort and failure-isolated: a read/write problem never breaks
 * a turn (the loop just runs without memory that time).
 */

/** The `.myto` directory inside a working folder. */
function mytoDir(workspaceDir: string): string {
  return join(workspaceDir, '.myto')
}

/** The pre-rebrand `.sylor` directory — read for back-compat, never freshly created. */
function legacyDir(workspaceDir: string): string {
  return join(workspaceDir, '.sylor')
}

/** The running journal file. */
function journalPath(workspaceDir: string): string {
  return join(mytoDir(workspaceDir), 'journal.md')
}

/** The pre-rebrand journal file, migrated from and read as a fallback. */
function legacyJournalPath(workspaceDir: string): string {
  return join(legacyDir(workspaceDir), 'journal.md')
}

/** Keep the injected journal bounded so a long project can't blow up the prompt. */
const JOURNAL_READ_CAP = 8000
/** Trim the file on disk once it grows past this (keep the recent tail). */
const JOURNAL_MAX_BYTES = 40_000

/**
 * Ensure `.myto/` exists with a small explainer, so the folder is discoverable and
 * the journal has a home. Idempotent; safe to call at the start of every Cowork turn.
 * On first creation, a pre-rebrand `.sylor/journal.md` is copied in so history carries
 * over without a gap.
 */
export function ensureMytoDir(workspaceDir: string): void {
  try {
    const dir = mytoDir(workspaceDir)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'README.md'),
        '# .myto\n\nMyto keeps its working memory for this project here — a journal of what it has\ndone across sessions, so it continues your work instead of repeating it. Safe to keep\nin version control or to delete (Myto will start a fresh journal).\n',
        'utf8'
      )
      // Back-compat: seed the new journal from the legacy `.sylor/journal.md` so an
      // in-flight project's history isn't lost at the rebrand boundary.
      try {
        const legacy = legacyJournalPath(workspaceDir)
        const dest = journalPath(workspaceDir)
        if (existsSync(legacy) && !existsSync(dest)) {
          writeFileSync(dest, readFileSync(legacy, 'utf8'), 'utf8')
        }
      } catch {
        /* migration is best-effort */
      }
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Read the project journal for injection into the next turn, capped to its recent tail.
 * Reads the current `.myto/journal.md`, falling back to the legacy `.sylor/journal.md`
 * when a project hasn't been touched since the rebrand. Returns '' when neither exists.
 *
 * When a `query` (the current task) is given and the journal has overflowed its cap,
 * the most RELEVANT older notes are surfaced alongside the recency tail via
 * {@link recallMemory} — fully offline. Omitting `query` reproduces the old tail exactly.
 */
export function readJournal(workspaceDir: string, query = ''): string {
  try {
    let text = ''
    try {
      text = readFileSync(journalPath(workspaceDir), 'utf8').trim()
    } catch {
      text = ''
    }
    if (!text) {
      try {
        text = readFileSync(legacyJournalPath(workspaceDir), 'utf8').trim()
      } catch {
        text = ''
      }
    }
    if (!text) return ''
    return recallMemory(text, query, { cap: JOURNAL_READ_CAP })
  } catch {
    return ''
  }
}

/** Append one line to the journal, creating the dir/file as needed. Best-effort. */
function append(workspaceDir: string, line: string): void {
  try {
    ensureMytoDir(workspaceDir)
    const path = journalPath(workspaceDir)
    // Trim the file if it has grown large: keep the recent tail.
    try {
      if (existsSync(path) && statSync(path).size > JOURNAL_MAX_BYTES) {
        const kept = readFileSync(path, 'utf8').slice(-JOURNAL_MAX_BYTES)
        writeFileSync(path, `…(earlier entries trimmed)\n${kept}`, 'utf8')
      }
    } catch {
      /* trim is best-effort */
    }
    appendFileSync(path, line.endsWith('\n') ? line : `${line}\n`, 'utf8')
  } catch {
    /* best-effort */
  }
}

/** Record the user's goal at the start of a Cowork turn (a session marker in the journal). */
export function recordGoal(workspaceDir: string, goal: string): void {
  const g = goal.trim()
  if (!g) return
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
  append(workspaceDir, `\n## ${stamp} — goal\n${g.length > 500 ? `${g.slice(0, 500)}…` : g}`)
}

/**
 * Record a durable, model-authored note into the project journal — the `remember` tool's
 * `project` scope. Unlike the automatic action log, this is something the agent explicitly
 * chose to remember for next time (a decision, a convention, a gotcha). Best-effort.
 * Returns true when something was written.
 */
export function recordNote(workspaceDir: string, note: string): boolean {
  const n = note.trim()
  if (!workspaceDir.trim() || !n) return false
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
  append(workspaceDir, `- (${stamp}) note: ${n.length > 500 ? `${n.slice(0, 500)}…` : n}`)
  return true
}

/**
 * Record a meaningful tool action so the next turn knows it happened. Only the actions
 * that CHANGE the project or verify it are logged (writes, edits, deletes, commands, code
 * runs) — reads/lists/searches are transient and would just be noise. The result is
 * summarised to a short outcome, never dumped in full.
 */
export function recordToolAction(workspaceDir: string, call: ToolCall, result: string): void {
  const input = call.input && typeof call.input === 'object' ? (call.input as Record<string, unknown>) : {}
  const path = typeof input.path === 'string' ? input.path : ''
  const outcome = summariseOutcome(result)
  let line: string | null = null
  switch (call.name) {
    case 'write_file':
      line = `- wrote \`${path}\``
      break
    case 'edit_file':
      line = `- edited \`${path}\``
      break
    case 'delete_file':
      line = `- deleted \`${path}\``
      break
    case 'run_command': {
      const cmd = typeof input.command === 'string' ? input.command : ''
      line = `- ran \`${cmd.length > 60 ? `${cmd.slice(0, 60)}…` : cmd}\` → ${outcome}`
      break
    }
    case 'run_code': {
      const lang = typeof input.language === 'string' ? input.language : 'code'
      line = `- ran ${lang} → ${outcome}`
      break
    }
    default:
      return // reads / lists / searches / web / preview / plan: not journalled
  }
  if (line) append(workspaceDir, line)
}

/** Compress a tool result into a one-word-ish outcome for the journal. */
function summariseOutcome(result: string): string {
  const r = result.toLowerCase()
  if (/\berror\b|\bfailed\b|traceback|exception|not found|cannot|denied/.test(r)) return 'error'
  const firstLine = result.trim().split('\n')[0] ?? ''
  return firstLine ? (firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine) : 'ok'
}
