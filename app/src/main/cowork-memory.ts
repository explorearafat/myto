import { mkdirSync, readFileSync, appendFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolCall } from './tools/toolParser'

/*
 * Cowork project memory — the `.sylor/` folder.
 *
 * Just like Claude Code keeps a `.claude/` directory, Myto keeps a `.sylor/` folder
 * inside the working folder to give a Cowork run MEMORY across turns. Without it, each
 * new message starts a fresh tool loop that only sees the chat text — so the agent
 * re-explores, re-scaffolds, and repeats work it already did. With it, the main process
 * writes a running JOURNAL of the meaningful actions taken (files written, commands run)
 * and the goals asked, then injects that journal back into the next turn's context. The
 * agent reads "here is what you already did in this folder" and continues instead of
 * restarting.
 *
 * Everything here is best-effort and failure-isolated: a read/write problem never breaks
 * a turn (the loop just runs without memory that time).
 */

/** The `.sylor` directory inside a working folder. */
function mytoDir(workspaceDir: string): string {
  return join(workspaceDir, '.sylor')
}

/** The running journal file. */
function journalPath(workspaceDir: string): string {
  return join(mytoDir(workspaceDir), 'journal.md')
}

/** Keep the injected journal bounded so a long project can't blow up the prompt. */
const JOURNAL_READ_CAP = 8000
/** Trim the file on disk once it grows past this (keep the recent tail). */
const JOURNAL_MAX_BYTES = 40_000

/**
 * Ensure `.sylor/` exists with a small explainer, so the folder is discoverable and
 * the journal has a home. Idempotent; safe to call at the start of every Cowork turn.
 */
export function ensureMytoDir(workspaceDir: string): void {
  try {
    const dir = mytoDir(workspaceDir)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'README.md'),
        '# .sylor\n\nMyto keeps its working memory for this project here — a journal of what it has\ndone across sessions, so it continues your work instead of repeating it. Safe to keep\nin version control or to delete (Myto will start a fresh journal).\n',
        'utf8'
      )
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Read the project journal for injection into the next turn, capped to its recent tail.
 * Returns '' when there is no journal yet (a brand-new folder).
 */
export function readJournal(workspaceDir: string): string {
  try {
    const text = readFileSync(journalPath(workspaceDir), 'utf8').trim()
    if (!text) return ''
    return text.length > JOURNAL_READ_CAP ? `…(earlier entries trimmed)\n${text.slice(-JOURNAL_READ_CAP)}` : text
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
