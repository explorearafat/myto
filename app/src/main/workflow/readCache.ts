import type { ReadResult, ToolProposal, ToolResult } from '../../shared/types'
import { contextManager } from '../context/manager'

/**
 * In-run read deduplication (Problem 1: "it reads the SAME file over and over").
 *
 * Every read the agent makes echoes the file's (bounded) content into the next
 * turn, and the whole conversation is re-sent to the model every step — so a
 * second identical read of an unchanged file costs a wasted disk hit AND a second
 * full copy of that content in the context window, for zero new information. This
 * module lets {@link executeTool} answer a repeat `read_file` from a short note
 * instead, while staying correct: a write or command that could have changed the
 * file drops it from the cache, and a size/mtime change forces a fresh read.
 *
 * The per-run cache is a `Map<key, stamp>` living on the run handle (so it's
 * cleared when the run ends). `key` identifies a specific read window; `stamp`
 * is the file's `size:mtime` at read time — the freshness guard.
 *
 * These helpers are kept out of `engine.ts` (and its Electron-heavy import chain)
 * so they can be unit-tested directly against the real {@link contextManager}.
 */

/** `size:mtime` stamp string for a stat result — the cache's freshness token. */
function stampOf(stat: { size: number; mtime: number }): string {
  return `${stat.size}:${stat.mtime}`
}

/**
 * Cache key for a read: the active root + the path as the model spelled it + the
 * line window, JSON-encoded so no separator char can ever collide (a path may
 * contain spaces, quotes, anything but a NUL). The root is part of the key so a
 * worktree subagent reading `foo.ts` never aliases the lead reading a different
 * `foo.ts`.
 */
export function readCacheKey(root: string, path: string, offset?: number, limit?: number): string {
  return JSON.stringify([root, path, offset ?? null, limit ?? null])
}

/**
 * Prefix that every {@link readCacheKey} for a given (root, path) starts with,
 * regardless of the line window — used to evict all cached windows of a file on
 * write. JSON's closing quote after the path makes the boundary exact, so
 * `foo.ts` never matches `foo.ts.bak`.
 */
function pathKeyPrefix(root: string, path: string): string {
  const withPath = JSON.stringify([root, path])
  return `${withPath.slice(0, -1)},` // drop the trailing "]" and reopen the array
}

/**
 * If this exact `read_file` window was already served this run and the file is
 * unchanged on disk since, returns a short "already read" note to hand back
 * INSTEAD of a second disk read + a second full-content injection. Returns null
 * on the first read, a changed/vanished file (stamp differs — the stale entry is
 * evicted so the caller re-reads), or any non-`read_file` op. Media reads are
 * never cached (they carry image bytes for a vision turn), so only prior TEXT
 * reads ever reach this path.
 */
export function servedFromReadCache(
  cache: Map<string, string>,
  proposal: ToolProposal
): ReadResult | null {
  if (proposal.kind !== 'read' || proposal.op !== 'read_file') return null
  const key = readCacheKey(contextManager.getRoot(), proposal.path, proposal.offset, proposal.limit)
  const seen = cache.get(key)
  if (seen === undefined) return null

  const stamp = contextManager.fileStamp(proposal.path)
  if (!stamp || stampOf(stamp) !== seen) {
    // Vanished or changed since we served it — force a fresh read.
    cache.delete(key)
    return null
  }

  const summary = contextManager.indexSummaryFor(proposal.path)
  const output = summary
    ? `Already read \`${proposal.path}\` earlier in this turn — unchanged since, so its full content is still above. Structural summary: ${summary}`
    : `Already read \`${proposal.path}\` earlier in this turn — unchanged since, so its full content is still above.`
  return {
    id: proposal.id,
    kind: 'read',
    ok: true,
    output,
    truncated: false,
    summary: 'already read (unchanged)'
  }
}

/**
 * Updates the per-run read cache and the persistent project index after a tool
 * actually ran:
 *  - a successful text read is remembered (window → stamp) and fed to the index;
 *  - a successful write evicts every cached window of that path (a read-after-write
 *    must return fresh bytes) and refreshes the file's index summary;
 *  - any command clears the whole cache — a command can touch arbitrary files, so
 *    nothing read before it can be trusted as unchanged.
 */
export function updateReadCache(
  cache: Map<string, string>,
  proposal: ToolProposal,
  result: ToolResult
): void {
  if (
    proposal.kind === 'read' &&
    proposal.op === 'read_file' &&
    result.kind === 'read' &&
    result.ok &&
    !result.media
  ) {
    const stamp = contextManager.fileStamp(proposal.path)
    if (stamp) {
      const key = readCacheKey(
        contextManager.getRoot(),
        proposal.path,
        proposal.offset,
        proposal.limit
      )
      cache.set(key, stampOf(stamp))
    }
    contextManager.noteRead(proposal.path)
    return
  }

  if (proposal.kind === 'write_file' && result.kind === 'write_file' && result.ok) {
    const prefix = pathKeyPrefix(contextManager.getRoot(), proposal.path)
    for (const key of [...cache.keys()]) {
      if (key.startsWith(prefix)) cache.delete(key)
    }
    contextManager.noteWrite(proposal.path, proposal.newContent)
    return
  }

  if (proposal.kind === 'run_command') {
    cache.clear()
  }
}
