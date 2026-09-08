/**
 * Checkpoints — the undo the agent's own writes never had (Phase 5).
 *
 * Before Sylor changes anything, it records a restorable snapshot of the working
 * tree. When git is available that snapshot is a dangling commit kept alive by a
 * ref under `refs/sylor/checkpoints/`, built through a **scratch index**
 * (`GIT_INDEX_FILE`) so it captures tracked edits *and* the untracked files Sylor
 * just created while touching nothing the user owns: not their branch, not HEAD,
 * not their staged index, not the stash list. With no git — or no repo — it falls
 * back to byte copies of the files this run wrote, under `.sylor/checkpoints/<id>/`.
 *
 * Two rules shape the whole module:
 *
 * 1. **A restore is never lossy.** {@link restoreCheckpoint} takes its own
 *    checkpoint first, so going back is itself reversible, and it only ever
 *    *writes* files — a file created after the checkpoint is left in place rather
 *    than deleted behind the user's back. That means "restore" means "put these
 *    files back as they were", not "make the folder identical to then", and the UI
 *    says so.
 * 2. **Everything is total.** Every function resolves a value instead of throwing:
 *    a missing git, a pruned object, an unreadable index — all degrade to `null` /
 *    `{ ok: false }`, because a snapshot mechanism that can abort a run is worse
 *    than no snapshot at all.
 *
 * Not to be confused with `context/projectState.ts`'s `SessionCheckpoint`, which is
 * a hand-off note written for the next session and restores nothing.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { isGitAvailable } from '../plugins/git'
import { runGit } from '../git/exec'
import type { CheckpointInfo, RestoreResult } from '../../shared/types'

/** Where a project's checkpoints live: the index, plus copies for the no-git path. */
const CHECKPOINT_DIR = join('.sylor', 'checkpoints')
/**
 * The same directory as git names it: forward slashes, project-relative. Snapshots
 * exclude it and restores skip it, because the timeline's own record must not ride
 * inside the snapshots it describes — a restore that rolled `index.json` back to an
 * older copy would erase every checkpoint taken since, including the safety point
 * the restore had just reported as the way back.
 */
const CHECKPOINT_PATHSPEC = '.sylor/checkpoints'
/**
 * Ref namespace for snapshot commits. Deliberately outside `refs/heads` and
 * `refs/tags`, so a checkpoint never appears as a branch the user could check out
 * by accident, and outside `refs/stash`, so it can't shadow their own stashes.
 */
const REF_PREFIX = 'refs/sylor/checkpoints/'
/**
 * How many checkpoints one project keeps. Bounded because each ref pins its objects
 * against garbage collection; the oldest entries are dropped (and their refs
 * deleted) once the list is longer than this. Nothing else ever removes one.
 */
const MAX_CHECKPOINTS = 60
/**
 * Identity for the snapshot commit. Passed as env rather than read from config:
 * `commit-tree` refuses to run without one, and a user who has never set
 * `user.email` should still get checkpoints — while their own config stays untouched.
 */
const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Sylor',
  GIT_AUTHOR_EMAIL: 'sylor@localhost',
  GIT_COMMITTER_NAME: 'Sylor',
  GIT_COMMITTER_EMAIL: 'sylor@localhost'
}
/** Paths per `checkout-index` call, so a big restore can't overflow the command line. */
const RESTORE_BATCH = 80
/**
 * Roots already proven to be inside a git work tree. Only positives are cached: a
 * folder does not stop being a repo, while one that isn't yet may become one after a
 * `git init` — and the probe costs two process spawns in front of every single write,
 * which is the one place this module is on the critical path.
 */
const REPO_CACHE = new Set<string>()

/** What {@link createCheckpoint} did: the point, and whether it is a NEW one. */
export interface CheckpointCreation {
  checkpoint: CheckpointInfo
  /**
   * False when the tree was byte-identical to the newest existing checkpoint, so
   * that one was returned instead. Callers use this to avoid announcing a second
   * row for a state the timeline already holds.
   */
  created: boolean
}

/** On-disk shape of `.sylor/checkpoints/index.json`. */
interface StoredIndex {
  version: 1
  checkpoints: CheckpointInfo[]
}

/** Absolute checkpoint directory for a project root. */
function dirFor(root: string): string {
  return join(root, CHECKPOINT_DIR)
}

/** Reads the index, tolerating every kind of absence and corruption. */
export function listCheckpoints(root: string): CheckpointInfo[] {
  try {
    const raw = readFileSync(join(dirFor(root), 'index.json'), 'utf8')
    const parsed = JSON.parse(raw) as StoredIndex
    if (!Array.isArray(parsed?.checkpoints)) return []
    // Newest first — the order the timeline reads in, and the order "restore the
    // last good state" scans.
    return [...parsed.checkpoints].sort((a, b) => b.at - a.at)
  } catch {
    return []
  }
}

/** Writes the index back. Best-effort: a failure loses the record, not the run. */
function writeIndex(root: string, checkpoints: CheckpointInfo[]): void {
  try {
    mkdirSync(dirFor(root), { recursive: true })
    const body: StoredIndex = { version: 1, checkpoints }
    writeFileSync(join(dirFor(root), 'index.json'), JSON.stringify(body, null, 2), 'utf8')
  } catch {
    /* a project we cannot write to simply has no timeline */
  }
}

/**
 * Sortable, collision-free id — also the ref and directory name, so it stays to
 * `[a-z0-9-]` and can never be read as a git option.
 */
function nextId(): string {
  return `cp-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
}

/** A scratch index file, so staging never touches the user's real one. */
function tempIndex(): string {
  return join(tmpdir(), `sylor-cp-${randomUUID()}.idx`)
}

/**
 * Resolves a project-relative path against `root`, returning it only if it stays
 * inside. A recorded path that tries to escape the project (`..`, an absolute
 * path) is skipped rather than restored — a checkpoint index is a file on disk and
 * is treated as untrusted input.
 */
function safeJoin(root: string, rel: string): string | null {
  const base = resolve(root)
  const dest = resolve(base, rel)
  if (dest !== base && !dest.startsWith(base + sep)) return null
  return dest
}

/** True when `root` is inside a git work tree (and git exists at all). */
async function insideRepo(root: string, signal?: AbortSignal): Promise<boolean> {
  if (REPO_CACHE.has(root)) return true
  if (!(await isGitAvailable())) return false
  const inside = await runGit(['rev-parse', '--is-inside-work-tree'], root, signal)
  const yes = inside.ok && inside.stdout.trim() === 'true'
  if (yes) REPO_CACHE.add(root)
  return yes
}

/** What a snapshot attempt produced: a new commit, nothing new, or a failure. */
type SnapshotOutcome = { kind: 'created'; sha: string } | { kind: 'unchanged' } | { kind: 'failed' }

/**
 * Snapshots the whole working tree as a commit object and returns its sha.
 *
 * `read-tree HEAD` seeds a scratch index with the committed state, `add -A` stages
 * everything else on top — modifications, deletions, and the untracked files Sylor
 * just wrote (`.gitignore` still applies, so `node_modules` stays out; the
 * checkpoint store itself is excluded, see {@link CHECKPOINT_PATHSPEC}) — and
 * `commit-tree` turns the result into a real commit whose parent is HEAD. A repo
 * with no commits yet simply gets a parentless one.
 *
 * `prevSha` is the newest existing checkpoint, and the comparison against it is on
 * **trees**, not commits: `commit-tree` stamps the current time, so the same tree
 * snapshotted a minute later is a different commit object. The tree is what a
 * restore actually reads back, so the tree is what decides "nothing has changed" —
 * and the check happens before committing, so an unchanged step leaves no object
 * behind at all.
 *
 * Nothing here writes the user's index: every staging step runs with
 * `GIT_INDEX_FILE` pointed at a throwaway file, which is deleted before returning.
 */
async function gitSnapshot(
  root: string,
  label: string,
  prevSha: string | undefined,
  signal?: AbortSignal
): Promise<SnapshotOutcome> {
  const idx = tempIndex()
  const env = { GIT_INDEX_FILE: idx }
  try {
    const head = await runGit(['rev-parse', 'HEAD'], root, signal)
    const parent = head.ok ? head.stdout.trim() : ''
    if (parent) {
      const seeded = await runGit(['read-tree', parent], root, signal, env)
      if (!seeded.ok) return { kind: 'failed' }
    }
    const staged = await runGit(
      ['add', '-A', '--', '.', `:(exclude)${CHECKPOINT_PATHSPEC}`],
      root,
      signal,
      env
    )
    if (!staged.ok) return { kind: 'failed' }
    const tree = await runGit(['write-tree'], root, signal, env)
    const treeSha = tree.stdout.trim()
    if (!tree.ok || !/^[0-9a-f]{40,64}$/.test(treeSha)) return { kind: 'failed' }
    if (prevSha) {
      const prevTree = await runGit(['rev-parse', `${prevSha}^{tree}`], root, signal)
      if (prevTree.ok && prevTree.stdout.trim() === treeSha) return { kind: 'unchanged' }
    }
    const commit = await runGit(
      ['commit-tree', treeSha, ...(parent ? ['-p', parent] : []), '-m', label],
      root,
      signal,
      { ...env, ...GIT_IDENTITY }
    )
    const sha = commit.stdout.trim()
    if (!commit.ok || !/^[0-9a-f]{40,64}$/.test(sha)) return { kind: 'failed' }
    return { kind: 'created', sha }
  } finally {
    try {
      rmSync(idx, { force: true })
    } catch {
      /* a leftover scratch index in tmp is harmless */
    }
  }
}

/**
 * No-git fallback: copy the files this run has written into the checkpoint folder.
 *
 * Only what exists is captured, and only the files handed in — without git there is
 * no cheap way to know what else in the folder might change, and copying a whole
 * project on every step would be indefensible. So this snapshot is narrower than
 * the git one by construction: it can put back a file Sylor overwrote, and it holds
 * nothing about a file that did not exist yet. Returns the paths actually copied.
 */
function fileSnapshot(root: string, id: string, files: readonly string[]): string[] {
  const captured: string[] = []
  for (const rel of files) {
    const from = safeJoin(root, rel)
    if (!from || !existsSync(from)) continue
    const to = join(dirFor(root), id, rel)
    try {
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(from, to)
      captured.push(rel)
    } catch {
      /* skip what we cannot copy; the rest of the snapshot still stands */
    }
  }
  return captured
}

/**
 * True when a `files` checkpoint would be byte-identical to `prev` — same set of
 * paths, same contents. Cheap because these snapshots only ever hold the handful of
 * files one run wrote, and it is what keeps the timeline from filling with rows for
 * a state that never changed.
 */
function sameAsFileSnapshot(root: string, prev: CheckpointInfo, files: readonly string[]): boolean {
  const before = prev.files ?? []
  if (prev.kind !== 'files' || before.length !== files.length) return false
  for (const rel of files) {
    if (!before.includes(rel)) return false
    const now = safeJoin(root, rel)
    const then = join(dirFor(root), prev.id, rel)
    try {
      if (!now || !readFileSync(now).equals(readFileSync(then))) return false
    } catch {
      return false
    }
  }
  return true
}

/** Drop the oldest entries past {@link MAX_CHECKPOINTS}, releasing what pinned them. */
async function prune(root: string, list: CheckpointInfo[]): Promise<CheckpointInfo[]> {
  if (list.length <= MAX_CHECKPOINTS) return list
  const keep = list.slice(0, MAX_CHECKPOINTS)
  for (const gone of list.slice(MAX_CHECKPOINTS)) {
    if (gone.kind === 'git') await runGit(['update-ref', '-d', REF_PREFIX + gone.id], root)
    else
      try {
        rmSync(join(dirFor(root), gone.id), { recursive: true, force: true })
      } catch {
        /* leaving stale bytes behind is better than failing the new checkpoint */
      }
  }
  return keep
}

/**
 * Records a restorable point, or returns null when there is nothing this mechanism
 * can hold (no git *and* no file list, an unwritable project, a failed git step).
 *
 * `files` is the run's written-file list, used only on the no-git path.
 * `created: false` means the tree was identical to the newest existing checkpoint,
 * so that one is handed back instead of adding a duplicate — a checkpoint whose
 * bytes match the previous one is not a new point in time.
 */
export async function createCheckpoint(
  root: string,
  label: string,
  opts: {
    runId?: string
    files?: readonly string[]
    /** True for the snapshot taken to make a restore reversible. */
    auto?: boolean
    signal?: AbortSignal
  } = {}
): Promise<CheckpointCreation | null> {
  if (!root || !existsSync(root)) return null
  const list = listCheckpoints(root)
  const newest = list[0]
  const id = nextId()
  const base = {
    id,
    at: Date.now(),
    label: label.slice(0, 200),
    ...(opts.runId ? { runId: opts.runId } : {}),
    ...(opts.auto ? { auto: true } : {})
  }

  let entry: CheckpointInfo
  if (await insideRepo(root, opts.signal)) {
    // Only a `git` point has a tree to compare against; a `files` one left over from
    // before this project had git is simply not a candidate for deduping.
    const prev = newest?.kind === 'git' ? newest : undefined
    const snap = await gitSnapshot(root, `sylor checkpoint: ${base.label}`, prev?.sha, opts.signal)
    if (snap.kind === 'unchanged') return prev ? { checkpoint: prev, created: false } : null
    if (snap.kind === 'failed') return null
    const ref = await runGit(['update-ref', REF_PREFIX + id, snap.sha], root, opts.signal)
    if (!ref.ok) return null
    entry = { ...base, kind: 'git', sha: snap.sha }
  } else {
    const files = opts.files ?? []
    if (files.length === 0) return null
    if (newest && sameAsFileSnapshot(root, newest, files)) {
      return { checkpoint: newest, created: false }
    }
    const captured = fileSnapshot(root, id, files)
    if (captured.length === 0) return null
    entry = { ...base, kind: 'files', files: captured }
  }

  writeIndex(root, await prune(root, [entry, ...list]))
  return { checkpoint: entry, created: true }
}

/**
 * Puts the working tree back to a `git` checkpoint, writing only the files that
 * actually differ.
 *
 * The scratch index is loaded with the snapshot's tree, then `update-index
 * --refresh` re-hashes the working copy against it — that pass is what makes
 * `diff-files` name *genuinely* changed files instead of everything (a freshly
 * read tree carries no stat data, so without it every path looks dirty). Those
 * paths, and only those, are rewritten by `checkout-index`. It exits non-zero when
 * anything needs updating, which is the normal case, so its status is ignored.
 */
async function restoreGit(
  root: string,
  cp: CheckpointInfo,
  signal?: AbortSignal
): Promise<RestoreResult> {
  const idx = tempIndex()
  const env = { GIT_INDEX_FILE: idx }
  try {
    const seeded = await runGit(['read-tree', cp.sha ?? ''], root, signal, env)
    if (!seeded.ok) {
      return { ok: false, error: 'That snapshot is no longer in the repository.' }
    }
    await runGit(['update-index', '--refresh', '-q'], root, signal, env)
    const diff = await runGit(['diff-files', '--name-only', '-z'], root, signal, env)
    if (!diff.ok) return { ok: false, error: 'Could not work out what changed since then.' }
    // Never write the timeline's own record back: if an older `index.json` did get
    // into a snapshot (a project that committed one before this exclusion existed),
    // restoring it would delete the record of newer points — the safety checkpoint
    // included. Skipping it here makes that impossible regardless of the tree.
    const paths = diff.stdout
      .split('\0')
      .filter((p) => p.length > 0 && !p.startsWith(CHECKPOINT_PATHSPEC + '/'))
    if (paths.length === 0) return { ok: true, restored: [] }
    for (let i = 0; i < paths.length; i += RESTORE_BATCH) {
      const batch = paths.slice(i, i + RESTORE_BATCH)
      const out = await runGit(['checkout-index', '-f', '--', ...batch], root, signal, env)
      if (!out.ok) {
        return {
          ok: false,
          error: 'Git refused to write some files back.',
          restored: paths.slice(0, i)
        }
      }
    }
    return { ok: true, restored: paths }
  } finally {
    try {
      rmSync(idx, { force: true })
    } catch {
      /* harmless */
    }
  }
}

/** Puts back the copies a `files` checkpoint holds. */
function restoreFiles(root: string, cp: CheckpointInfo): RestoreResult {
  const restored: string[] = []
  for (const rel of cp.files ?? []) {
    const to = safeJoin(root, rel)
    const from = join(dirFor(root), cp.id, rel)
    if (!to || !existsSync(from)) continue
    try {
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(from, to)
      restored.push(rel)
    } catch {
      /* keep going: a partial restore is still worth having */
    }
  }
  return { ok: true, restored }
}

/**
 * Restores the project to one checkpoint.
 *
 * Takes an automatic checkpoint FIRST — that is the whole reason this is safe to
 * offer as a one-click action: whatever the tree looks like now is recorded before
 * anything is overwritten, so a restore can itself be undone from the same
 * timeline. Nothing is ever deleted, so files created after the checkpoint survive;
 * `restored` names exactly what was rewritten, and an empty list means the tree
 * already matched.
 */
export async function restoreCheckpoint(
  root: string,
  id: string,
  signal?: AbortSignal
): Promise<RestoreResult> {
  const target = listCheckpoints(root).find((c) => c.id === id)
  if (!target) return { ok: false, error: 'That checkpoint is no longer on record.' }

  const safety = await createCheckpoint(root, `Before restoring “${target.label}”`, {
    auto: true,
    files: target.files,
    signal
  })

  const outcome =
    target.kind === 'git' ? await restoreGit(root, target, signal) : restoreFiles(root, target)
  // The escape hatch is only reported when it genuinely exists — claiming one that
  // was never taken is exactly the kind of reassurance that gets someone hurt.
  return safety?.created ? { ...outcome, safety: safety.checkpoint } : outcome
}


