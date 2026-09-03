/**
 * Tests for worktree isolation (Phase 3, sub-agent power-up).
 *
 * These exercise the REAL git-backed `createWorktree` / `finalizeWorktree`
 * against a throwaway repo in the OS temp dir, so they only run where `git` is on
 * PATH (skipped otherwise — the functions degrade to `null`/no-op there, which is
 * the whole point of their total contract). The engine-level wiring (a subagent
 * running inside `runWithRoot(dir, …)`) is covered separately in the
 * orchestration e2e test with a mocked worktree module; here we prove the git
 * mechanics themselves: carve a worktree, sync an agent's writes/deletes/renames
 * back into the project, and tear the worktree + branch down.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { contextManager } from '@main/context/manager'
import { createWorktree, finalizeWorktree, type WorktreeHandle } from '@main/workflow/worktree'

/** Whether `git` is usable in this environment; the happy-path suite needs it. */
function gitPresent(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const HAS_GIT = gitPresent()

/** Runs git in `cwd`, throwing on failure (test setup wants loud failures). */
function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

/** Creates an initialized repo with one committed file, returns its path. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sylor-wt-repo-'))
  git(['init', '-b', 'main'], dir)
  git(['config', 'user.email', 'test@example.com'], dir)
  git(['config', 'user.name', 'Test'], dir)
  git(['config', 'commit.gpgsign', 'false'], dir)
  // Keep line endings byte-stable across platforms so content assertions don't
  // trip over Windows autocrlf converting LF→CRLF on checkout.
  git(['config', 'core.autocrlf', 'false'], dir)
  writeFileSync(join(dir, 'committed.txt'), 'original\n')
  git(['add', '.'], dir)
  git(['commit', '-m', 'init'], dir)
  return dir
}

const originalRoot = contextManager.getRoot()

// Restore the singleton's root after the whole file so a temp repo path can't
// leak into another test (vitest isolates per file, but this keeps it honest).
afterAll(() => {
  contextManager.setRoot(originalRoot)
})

describe.skipIf(!HAS_GIT)('createWorktree / finalizeWorktree (git-backed)', () => {
  let repo: string

  beforeEach(() => {
    repo = makeRepo()
    contextManager.setRoot(repo)
  })

  afterEach(() => {
    // Best-effort teardown of the repo; individual tests finalize their own
    // worktrees (which removes them from git's registry + disk).
    try {
      rmSync(repo, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('carves a worktree at a distinct dir on its own branch', async () => {
    const handle = await createWorktree('agent-1')
    expect(handle).not.toBeNull()
    const h = handle as WorktreeHandle
    expect(existsSync(h.dir)).toBe(true)
    expect(h.dir).not.toBe(repo)
    expect(h.branch).toMatch(/^sylor\/agent-agent-1-/)
    expect(h.base).toBe(repo)
    // The committed file is present in the fresh worktree (checked out at HEAD).
    expect(readFileSync(join(h.dir, 'committed.txt'), 'utf-8')).toBe('original\n')
    // git knows about the extra worktree. Compare on the unique dir name, not the
    // full path — `git worktree list` normalizes separators (forward slashes on
    // Windows) and may canonicalize the temp path.
    const list = execFileSync('git', ['worktree', 'list'], { cwd: repo }).toString()
    expect(list).toContain(basename(h.dir))
    // Clean up so the test doesn't strand a worktree under the temp dir.
    await finalizeWorktree(h)
  })

  it('syncs added + modified files back into the project, then tears down', async () => {
    const h = (await createWorktree('agent-add')) as WorktreeHandle
    expect(h).not.toBeNull()
    // Simulate the agent working inside its isolated dir.
    writeFileSync(join(h.dir, 'committed.txt'), 'changed by agent\n')
    mkdirSync(join(h.dir, 'src'), { recursive: true })
    writeFileSync(join(h.dir, 'src', 'new.ts'), 'export const x = 1\n')

    const note = await finalizeWorktree(h)

    // Changes landed in the main project…
    expect(readFileSync(join(repo, 'committed.txt'), 'utf-8')).toBe('changed by agent\n')
    expect(readFileSync(join(repo, 'src', 'new.ts'), 'utf-8')).toBe('export const x = 1\n')
    expect(note).toContain('synced')
    // …and the worktree + branch are gone. Match on the unique token (shared by
    // both the dir name and the branch) so separator/casing quirks don't matter.
    expect(existsSync(h.dir)).toBe(false)
    const token = basename(h.dir)
    const list = execFileSync('git', ['worktree', 'list'], { cwd: repo }).toString()
    expect(list).not.toContain(token)
    const branches = execFileSync('git', ['branch', '--list'], { cwd: repo }).toString()
    expect(branches).not.toContain(token)
  })

  it('mirrors a deletion made in the worktree back to the project', async () => {
    const h = (await createWorktree('agent-del')) as WorktreeHandle
    rmSync(join(h.dir, 'committed.txt'))

    const note = await finalizeWorktree(h)

    expect(existsSync(join(repo, 'committed.txt'))).toBe(false)
    expect(note).toContain('deleted')
  })

  it('applies a staged rename (new copied in, old removed)', async () => {
    const h = (await createWorktree('agent-mv')) as WorktreeHandle
    // A staged rename is what surfaces as `R` in porcelain output.
    git(['mv', 'committed.txt', 'renamed.txt'], h.dir)

    await finalizeWorktree(h)

    expect(existsSync(join(repo, 'committed.txt'))).toBe(false)
    expect(readFileSync(join(repo, 'renamed.txt'), 'utf-8')).toBe('original\n')
  })

  it('returns an empty note and still removes an unchanged worktree', async () => {
    const h = (await createWorktree('agent-noop')) as WorktreeHandle
    const dir = h.dir

    const note = await finalizeWorktree(h)

    expect(note).toBe('')
    expect(existsSync(dir)).toBe(false)
  })
})

describe('createWorktree degradation (no repo)', () => {
  let plain: string

  beforeEach(() => {
    plain = mkdtempSync(join(tmpdir(), 'sylor-wt-plain-'))
    contextManager.setRoot(plain)
  })

  afterEach(() => {
    try {
      rmSync(plain, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('returns null when the root is not a git work tree', async () => {
    // Outside a repo, isolation is impossible — the caller runs in the shared
    // root instead. (When git is entirely absent this returns null too.)
    const handle = await createWorktree('agent-x')
    expect(handle).toBeNull()
  })

  it('returns null immediately when the signal is already aborted', async () => {
    const handle = await createWorktree('agent-x', AbortSignal.abort())
    expect(handle).toBeNull()
  })
})

