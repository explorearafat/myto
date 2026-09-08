/**
 * Tests for checkpoints (Phase 5) — the undo the agent's own writes never had.
 *
 * The git-backed suite runs against a throwaway repo in the OS temp dir and is
 * skipped where `git` is absent (there the module degrades to the `files` path,
 * which the second suite covers on its own). What is worth proving here is not
 * "a snapshot happened" but the two promises the module makes:
 *
 *  - it touches nothing the user owns — not HEAD, not their index, not the stash;
 *  - a restore is never lossy — it takes its own point first, deletes nothing, and
 *    leaves the record of newer points intact so the way back stays reachable.
 *
 * Every git-backed test carries {@link GIT_TIMEOUT} instead of the 5 s default: one
 * checkpoint is ~7 process spawns and a restore is ~5 more, and process creation on
 * Windows costs enough that a two-checkpoint test genuinely needs the room. A slow
 * test here is expected; a failing one is not.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCheckpoint, listCheckpoints, restoreCheckpoint } from '@main/checkpoint/checkpoints'

/** Per-test budget for the git-backed suite — real spawns, not mocks. */
const GIT_TIMEOUT = 30_000

/** Whether `git` is usable here; the git-backed suite needs it. */
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

/** Runs git in `cwd` and returns stdout (for assertions about repo state). */
function gitOut(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd }).toString()
}

/** An initialized repo with one committed file. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sylor-cp-repo-'))
  git(['init', '-b', 'main'], dir)
  git(['config', 'user.email', 'test@example.com'], dir)
  git(['config', 'user.name', 'Test'], dir)
  git(['config', 'commit.gpgsign', 'false'], dir)
  // Keep line endings byte-stable so content assertions don't trip over Windows
  // autocrlf rewriting LF→CRLF on checkout.
  git(['config', 'core.autocrlf', 'false'], dir)
  writeFileSync(join(dir, 'tracked.txt'), 'v1\n')
  git(['add', '.'], dir)
  git(['commit', '-m', 'init'], dir)
  return dir
}

describe.skipIf(!HAS_GIT)('checkpoints (git-backed)', () => {
  let repo: string

  beforeEach(() => {
    repo = makeRepo()
  })

  afterEach(() => {
    try {
      rmSync(repo, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('puts a tracked file back and leaves an undo point behind', async () => {
    const made = await createCheckpoint(repo, 'Before writing tracked.txt', { runId: 'run-1' })
    expect(made?.created).toBe(true)
    expect(made?.checkpoint.kind).toBe('git')
    expect(made?.checkpoint.runId).toBe('run-1')

    writeFileSync(join(repo, 'tracked.txt'), 'v2\n')
    const outcome = await restoreCheckpoint(repo, made!.checkpoint.id)

    expect(outcome.ok).toBe(true)
    expect(outcome.restored).toEqual(['tracked.txt'])
    expect(readFileSync(join(repo, 'tracked.txt'), 'utf-8')).toBe('v1\n')
    // The tree as it stood before the restore was itself recorded, so the restore
    // can be undone from the same timeline.
    expect(outcome.safety?.auto).toBe(true)
    expect(listCheckpoints(repo).some((c) => c.id === outcome.safety?.id)).toBe(true)
  }, GIT_TIMEOUT)

  it('captures a file Sylor just created that git has never seen', async () => {
    writeFileSync(join(repo, 'fresh.ts'), 'export const a = 1\n')
    const made = await createCheckpoint(repo, 'Before editing fresh.ts')
    expect(made?.created).toBe(true)

    writeFileSync(join(repo, 'fresh.ts'), 'export const a = 2\n')
    const outcome = await restoreCheckpoint(repo, made!.checkpoint.id)

    expect(outcome.ok).toBe(true)
    expect(outcome.restored).toEqual(['fresh.ts'])
    expect(readFileSync(join(repo, 'fresh.ts'), 'utf-8')).toBe('export const a = 1\n')
  }, GIT_TIMEOUT)

  it('leaves HEAD, the branch, the index and the stash untouched', async () => {
    const headBefore = gitOut(['rev-parse', 'HEAD'], repo).trim()
    writeFileSync(join(repo, 'tracked.txt'), 'staged-by-user\n')
    git(['add', 'tracked.txt'], repo)
    const stagedBefore = gitOut(['diff', '--cached', '--name-only'], repo)

    const made = await createCheckpoint(repo, 'Before running npm test')

    expect(gitOut(['rev-parse', 'HEAD'], repo).trim()).toBe(headBefore)
    expect(gitOut(['diff', '--cached', '--name-only'], repo)).toBe(stagedBefore)
    expect(gitOut(['stash', 'list'], repo).trim()).toBe('')
    expect(gitOut(['branch', '--list'], repo)).not.toContain('sylor')
    // The snapshot is kept alive by a ref of its own, outside heads/tags/stash.
    const refs = gitOut(['for-each-ref', '--format=%(refname)', 'refs/sylor'], repo)
    expect(refs).toContain(`refs/sylor/checkpoints/${made!.checkpoint.id}`)
  }, GIT_TIMEOUT)

  it('adds no second row for a tree that has not changed', async () => {
    const first = await createCheckpoint(repo, 'Before the first write')
    const second = await createCheckpoint(repo, 'Before the second write')

    expect(first?.created).toBe(true)
    // Trees are compared, not commits: `commit-tree` stamps the clock, so two
    // snapshots of identical bytes are different commit objects and only the tree
    // can answer "has anything changed".
    expect(second?.created).toBe(false)
    expect(second?.checkpoint.id).toBe(first!.checkpoint.id)
    expect(listCheckpoints(repo)).toHaveLength(1)
  }, GIT_TIMEOUT)

  it('keeps the record of newer points when an older one is restored', async () => {
    const first = await createCheckpoint(repo, 'Before write one')
    writeFileSync(join(repo, 'tracked.txt'), 'v2\n')
    const second = await createCheckpoint(repo, 'Before write two')
    expect(second?.created).toBe(true)

    await restoreCheckpoint(repo, first!.checkpoint.id)

    // The timeline still knows about the point that held the newer state — the
    // checkpoint store is deliberately outside the snapshots it describes.
    const ids = listCheckpoints(repo).map((c) => c.id)
    expect(ids).toContain(second!.checkpoint.id)
    expect(ids).toContain(first!.checkpoint.id)
  }, GIT_TIMEOUT)

  it('reports an empty restore when the tree already matches', async () => {
    const made = await createCheckpoint(repo, 'Before a write that never happened')
    const outcome = await restoreCheckpoint(repo, made!.checkpoint.id)

    expect(outcome.ok).toBe(true)
    expect(outcome.restored).toEqual([])
  }, GIT_TIMEOUT)

  it('never deletes a file created after the checkpoint', async () => {
    const made = await createCheckpoint(repo, 'Before write one')
    writeFileSync(join(repo, 'later.txt'), 'made afterwards\n')

    const outcome = await restoreCheckpoint(repo, made!.checkpoint.id)

    expect(outcome.ok).toBe(true)
    expect(existsSync(join(repo, 'later.txt'))).toBe(true)
  }, GIT_TIMEOUT)

  it('refuses an id it has no record of', async () => {
    const outcome = await restoreCheckpoint(repo, 'cp-nope')
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toMatch(/no longer on record/)
  }, GIT_TIMEOUT)
})

describe('checkpoints (no repo — file copies)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sylor-cp-plain-'))
  })

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('has an empty timeline before anything is recorded', () => {
    expect(listCheckpoints(dir)).toEqual([])
  })

  it('copies the run’s written files and puts them back', async () => {
    writeFileSync(join(dir, 'note.txt'), 'first\n')
    const made = await createCheckpoint(dir, 'Before writing note.txt', { files: ['note.txt'] })

    expect(made?.created).toBe(true)
    expect(made?.checkpoint.kind).toBe('files')
    expect(made?.checkpoint.files).toEqual(['note.txt'])

    writeFileSync(join(dir, 'note.txt'), 'second\n')
    const outcome = await restoreCheckpoint(dir, made!.checkpoint.id)

    expect(outcome.ok).toBe(true)
    expect(outcome.restored).toEqual(['note.txt'])
    expect(readFileSync(join(dir, 'note.txt'), 'utf-8')).toBe('first\n')
  })

  it('records nothing when there is no file list to fall back on', async () => {
    // No git here and no `files`, so there is genuinely nothing this mechanism can
    // hold — and it says so with null instead of writing an empty point.
    expect(await createCheckpoint(dir, 'Before running a command')).toBeNull()
    expect(listCheckpoints(dir)).toEqual([])
  })

  it('does not duplicate a point when the same bytes are captured twice', async () => {
    writeFileSync(join(dir, 'note.txt'), 'same\n')
    const first = await createCheckpoint(dir, 'Before write one', { files: ['note.txt'] })
    const second = await createCheckpoint(dir, 'Before write two', { files: ['note.txt'] })

    expect(first?.created).toBe(true)
    expect(second?.created).toBe(false)
    expect(second?.checkpoint.id).toBe(first!.checkpoint.id)
  })

  it('refuses a recorded path that tries to escape the project', async () => {
    writeFileSync(join(dir, 'note.txt'), 'inside\n')
    // The index is a file on disk, so it is treated as untrusted input: a path that
    // resolves outside the root is skipped rather than copied.
    const made = await createCheckpoint(dir, 'Before a suspicious write', {
      files: ['../escape.txt', 'note.txt']
    })

    expect(made?.checkpoint.files).toEqual(['note.txt'])
    expect(existsSync(join(dir, '..', 'escape.txt'))).toBe(false)
  })

  it('says no when the folder does not exist', async () => {
    expect(await createCheckpoint(join(dir, 'nope'), 'Before anything')).toBeNull()
  })
})
