import { mkdirSync, readFileSync, appendFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { recallMemory } from './memory-recall'

/**
 * Global (user-level) memory — a single `memory.md` under the app's userData folder.
 *
 * Where {@link ./cowork-memory} keeps a PER-PROJECT journal inside each working folder,
 * this is ONE cross-project memory that follows the user everywhere: durable facts and
 * preferences the assistant should carry into every chat and every Cowork folder
 * ("call me X", "we deploy with Y", "always run Z before committing"). It is injected
 * as a USER MEMORY system turn at the head of every run — so it survives compaction —
 * and is appended to by the `remember` tool.
 *
 * Electron-free: the userData directory is INJECTED via {@link setUserMemoryDir}
 * (mirrors db.ts's `setDbPath`), so this module never imports electron and tests can
 * point it at a temp dir. Everything is best-effort and failure-isolated — a read/write
 * fault never breaks a turn; memory just isn't there that time.
 */

/** Injected userData directory the global memory file lives under. Null until set. */
let memoryDirOverride: string | null = null

/** Inject the userData directory (called once at startup, from index.ts). */
export function setUserMemoryDir(dir: string): void {
  memoryDirOverride = dir
}

/** For tests: point the memory file at a throwaway directory. */
export function __setUserMemoryDirForTest(dir: string | null): void {
  memoryDirOverride = dir
}

/** The global memory file's path, or null when no userData dir has been injected yet. */
function memoryPath(): string | null {
  return memoryDirOverride ? join(memoryDirOverride, 'memory.md') : null
}

/** Keep the injected memory bounded so it can't dominate the prompt. */
const MEMORY_READ_CAP = 8000
/** Trim the file on disk once it grows past this (keep the recent tail). */
const MEMORY_MAX_BYTES = 40_000

/**
 * Read the global memory for injection into a run, capped to its recent tail.
 * Returns '' when there is nothing yet (or no userData dir was injected).
 *
 * A `query` (the current task) lets {@link recallMemory} surface the most relevant
 * older notes alongside the tail once the file overflows — offline. Omitting it
 * reproduces the previous tail byte-for-byte.
 */
export function readUserMemory(query = ''): string {
  const path = memoryPath()
  if (!path) return ''
  try {
    const text = readFileSync(path, 'utf8').trim()
    if (!text) return ''
    return recallMemory(text, query, { cap: MEMORY_READ_CAP, trimmedMarker: '…(earlier notes trimmed)' })
  } catch {
    return ''
  }
}

/**
 * Append one remembered fact to the global memory file, creating it as needed.
 * Returns true on success, false if there was nothing to write or the write failed.
 */
export function appendUserMemory(fact: string): boolean {
  const f = fact.trim()
  const path = memoryPath()
  if (!f || !path || !memoryDirOverride) return false
  try {
    if (!existsSync(memoryDirOverride)) mkdirSync(memoryDirOverride, { recursive: true })
    // Trim the file if it has grown large: keep the recent tail.
    try {
      if (existsSync(path) && statSync(path).size > MEMORY_MAX_BYTES) {
        const kept = readFileSync(path, 'utf8').slice(-MEMORY_MAX_BYTES)
        writeFileSync(path, `…(earlier notes trimmed)\n${kept}`, 'utf8')
      }
    } catch {
      /* trim is best-effort */
    }
    const stamp = new Date().toISOString().slice(0, 10)
    appendFileSync(path, `- (${stamp}) ${f}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}
