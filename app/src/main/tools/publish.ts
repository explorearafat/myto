import { resolve } from 'node:path'
import { executeArgv, type RunResult } from './runCode'
import { fsAvailable } from './fs'
import type { ToolContext, ToolDef } from './registry'
import {
  buildRepoCreateArgs,
  deriveRepoName,
  isGhAuthenticated,
  parseRepoUrl,
  vercelNextSteps
} from '../cowork-publish'

/**
 * `git_publish` — one-step "put this project on GitHub". It runs the whole sequence a
 * user would otherwise do by hand: check that git + the GitHub CLI (gh) are installed
 * and logged in, `git init` if the folder isn't a repo yet, stage + commit, then
 * `gh repo create --source=. --push` to make a NEW remote and push to it — and reports
 * the repo URL plus the exact next step to host it on Vercel.
 *
 * The pure name/URL/argv logic lives in ../cowork-publish (unit-tested); this file owns
 * the side-effecting spawns. Every command runs via {@link executeArgv} with an explicit
 * argv (no shell — a repo name or commit message can never be re-interpreted), pinned to
 * the working folder as cwd. It is an exec-tier action (creates a remote + pushes over
 * the network), so the Cowork permission tier always gates it. Non-interactive: git/gh
 * inherit the user's own credentials (credential manager / GH_TOKEN) plus any vault
 * credential scoped to `git`/`gh` injected per-command (see
 * {@link ToolContext.resolveCredentialEnv}); a step that would
 * prompt for a password can't, so the tool is HONEST when auth is missing rather than
 * hanging on a prompt that never comes.
 */

/** Network git/gh operations (create + push) can be slow — give them the git budget. */
const PUBLISH_TIMEOUT_MS = 120_000

/** A short unique id per command run so the Terminal pane can show each as its own row. */
function publishRunId(): string {
  return `pub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Mirror one command's combined output to the renderer's Terminal pane (display-only). */
function mirror(command: string, r: RunResult, cwd: string, ctx: ToolContext): void {
  const output = r.spawnError
    ? r.spawnError
    : [r.stdout, r.stderr].map((s) => s.trimEnd()).filter(Boolean).join('\n') ||
      (r.timedOut ? `(timed out after ${PUBLISH_TIMEOUT_MS / 1000}s)` : '(no output)')
  // The Terminal pane is a SEPARATE channel the central runTool redactor never sees, so
  // scrub any injected secret here too (e.g. a token echoed in a push URL on failure).
  const safeOutput = ctx.redactSecrets?.(output) ?? output
  ctx.onCommand?.({ id: publishRunId(), command, output: safeOutput, exitCode: r.spawnError ? null : r.exitCode, cwd })
}

/** The first non-empty line of some output, for a compact one-line failure reason. */
function firstLine(s: string): string {
  return s.split('\n').map((l) => l.trim()).find(Boolean) ?? 'no output'
}

/** Read a trimmed string field out of a tool input, or null. */
function readString(input: unknown, key: string): string | null {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>)[key] : undefined
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null
}

/** Whether a boolean-ish field is explicitly true. */
function readBool(input: unknown, key: string): boolean {
  return input && typeof input === 'object' ? (input as Record<string, unknown>)[key] === true : false
}

export const gitPublishTool: ToolDef = {
  name: 'git_publish',
  description:
    "Publish the working folder to GitHub in ONE step: initialise git if needed, commit, create a NEW GitHub repo with the gh CLI, and push — then report the repo URL and the exact next step to host it on Vercel. Needs git and the GitHub CLI (gh) installed with `gh auth login` done; it says so honestly and prepares what it can locally if they're missing. Use after the project builds. An exec-tier action (creates a remote + pushes), so it is approval-gated.",
  usage: '{"name": "my-app", "private": true, "description": "…", "commitMessage": "initial commit"}',
  sideEffect: 'exec',
  available: fsAvailable,
  async run(input, ctx): Promise<string> {
    const cwd = ctx.workspaceDir ? resolve(ctx.workspaceDir) : null
    if (!cwd) return 'git_publish needs an open working folder (Cowork mode).'

    const run = async (cmd: string, args: string[]): Promise<RunResult> => {
      const command = `${cmd} ${args.join(' ')}`
      // Scoped vault injection: a credential scoped to `git`/`gh` enters the child env for
      // a matching command (push, `gh repo create`) and nothing else — this is what lets a
      // one-time saved GitHub token drive the whole publish without the user re-exporting it.
      const injected = ctx.resolveCredentialEnv?.(command)
      const r = await executeArgv(cmd, args, ctx.signal, {
        cwd,
        timeoutMs: PUBLISH_TIMEOUT_MS,
        env: injected ? { ...process.env, ...injected } : undefined
      })
      mirror(command, r, cwd, ctx)
      return r
    }
    const steps: string[] = []

    // 1. Is git even here? Without it there is nothing to do.
    const gitVersion = await run('git', ['--version'])
    if (gitVersion.spawnError) {
      return `git_publish: git isn't installed or on PATH (${gitVersion.spawnError}). Install Git first, then try again.`
    }

    // 2. Is the GitHub CLI installed and logged in? Both are needed to CREATE the remote;
    //    we still do the local git prep and give manual steps when either is missing.
    const ghVersion = await run('gh', ['--version'])
    const ghInstalled = !ghVersion.spawnError
    let ghAuthed = false
    if (ghInstalled) {
      const auth = await run('gh', ['auth', 'status'])
      ghAuthed = isGhAuthenticated(`${auth.stdout}\n${auth.stderr}`)
    }

    // 3. Initialise the repo if the folder isn't one yet (modern `git init -b main`,
    //    with a fallback for older git that lacks -b).
    const inside = await run('git', ['rev-parse', '--is-inside-work-tree'])
    const isRepo = inside.exitCode === 0 && /true/.test(inside.stdout)
    if (!isRepo) {
      const init = await run('git', ['init', '-b', 'main'])
      if (init.spawnError || init.exitCode !== 0) {
        await run('git', ['init'])
        await run('git', ['checkout', '-B', 'main'])
      }
      steps.push('Initialised a new git repository on branch main.')
    }

    // 4. Stage everything and commit. "nothing to commit" is fine (an unchanged repo);
    //    a missing author identity is the common real failure — name it precisely.
    await run('git', ['add', '-A'])
    const message = readString(input, 'commitMessage') ?? readString(input, 'message') ?? 'Initial commit'
    const commit = await run('git', ['commit', '-m', message])
    const commitOut = `${commit.stdout}\n${commit.stderr}`
    if (commit.exitCode === 0) {
      steps.push(`Committed changes ("${message}").`)
    } else if (/nothing to commit/i.test(commitOut)) {
      steps.push('No new changes to commit — the working tree was already clean.')
    } else if (/identity unknown|user\.email|Please tell me who you are/i.test(commitOut)) {
      steps.push(
        'git has no author identity set — run `git config --global user.email "you@example.com"` and `git config --global user.name "Your Name"`, then run git_publish again.'
      )
      return steps.join('\n')
    } else {
      steps.push(`git commit did not succeed: ${firstLine(commit.stderr || commit.stdout)}`)
    }

    // Need at least one commit before anything can be pushed.
    const head = await run('git', ['rev-parse', 'HEAD'])
    if (head.exitCode !== 0) {
      steps.push('Nothing has been committed yet, so there is nothing to push — add some files to the folder first.')
      return steps.join('\n')
    }

    // 5. If a remote already exists, just push to it. Otherwise create one with gh.
    const originUrl = await run('git', ['remote', 'get-url', 'origin'])
    const hasOrigin = originUrl.exitCode === 0 && originUrl.stdout.trim().length > 0
    const report = (url: string | null): string => [...steps, '', ...vercelNextSteps(url)].join('\n')

    if (hasOrigin) {
      const url = parseRepoUrl(originUrl.stdout)
      const push = await run('git', ['push', '-u', 'origin', 'HEAD'])
      if (push.exitCode === 0) {
        steps.push(`Pushed to the existing remote${url ? ` ${url}` : ''}.`)
      } else {
        steps.push(`Push to the existing origin failed: ${firstLine(push.stderr || push.stdout)}`)
      }
      return report(url)
    }

    // No remote yet — creating one needs gh, installed and authenticated.
    if (!ghInstalled) {
      steps.push(
        'The GitHub CLI (gh) is not installed, so I could not create the remote automatically. Install it from https://cli.github.com, run `gh auth login`, then run git_publish again — or create an empty repo on github.com and I will push to it once `origin` is set.'
      )
      return report(null)
    }
    if (!ghAuthed) {
      steps.push(
        'The GitHub CLI (gh) is installed but not logged in. Run `gh auth login` once, then run git_publish again and I will create the repo and push.'
      )
      return report(null)
    }

    const name = deriveRepoName(cwd, readString(input, 'name'))
    const isPrivate = readBool(input, 'private')
    const create = await run(
      'gh',
      buildRepoCreateArgs({ name, private: isPrivate, description: readString(input, 'description') })
    )
    const createOut = `${create.stdout}\n${create.stderr}`
    if (create.exitCode === 0) {
      const url = parseRepoUrl(createOut)
      steps.push(`Created ${isPrivate ? 'private' : 'public'} GitHub repo "${name}" and pushed${url ? `: ${url}` : ''}.`)
      return report(url)
    }
    steps.push(`gh repo create failed: ${firstLine(create.stderr || create.stdout)}`)
    if (/already exists|Name already exists/i.test(createOut)) {
      steps.push(`A repo named "${name}" may already exist — pass a different {"name": "…"} or remove the existing one, then retry.`)
    }
    return report(null)

  }
}

