/**
 * Publish-to-GitHub — the PURE, dependency-free core of the `git_publish` tool
 * (tools/publish.ts). It holds the fiddly, testable logic — turning a working-folder
 * path into a GitHub-legal repo name, reading `gh auth status`, plucking the repo URL
 * out of CLI output, and building the `gh repo create` argv — while the tool itself
 * owns the side-effecting sequence of git/gh spawns. Same "extract the pure core so it
 * is unit-testable without spawning" pattern as cowork-runtimes.ts / cowork-scaffold.ts.
 *
 * Why the tool exists: the user asked for "boro project e auto github e push, vercel e
 * host" — one-step publishing. The raw git tools + run_command could already do it, but
 * only by having a weak model assemble a correct multi-command sequence AND guess whether
 * git/gh are installed and logged in. git_publish does the sequence once, correctly, and
 * is HONEST about missing prerequisites instead of failing cryptically.
 */

/** GitHub's longest allowed repository name. */
const MAX_REPO_NAME = 100

/**
 * Coerce arbitrary text into a valid GitHub repository name: GitHub allows only
 * ASCII letters, digits, `.`, `_`, and `-`, so every other run of characters becomes
 * a single hyphen; repeated hyphens collapse; leading/trailing `.`/`-` are trimmed
 * (a name can't be `.`/`..` or end in a dot), and it's capped at 100 chars. Falls back
 * to `project` when nothing usable survives, so the caller always has a legal name.
 */
export function sanitizeRepoName(raw: string): string {
  const cleaned = (raw || '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, MAX_REPO_NAME)
    .replace(/[-.]+$/g, '')
  return cleaned || 'project'
}

/**
 * The repo name to create: an explicit name (sanitized) wins; otherwise derive it from
 * the working folder's own basename (handling both `/` and `\` separators), sanitized.
 */
export function deriveRepoName(workspaceDir: string, explicit?: string | null): string {
  if (explicit && explicit.trim()) return sanitizeRepoName(explicit)
  const slash = Math.max(workspaceDir.lastIndexOf('/'), workspaceDir.lastIndexOf('\\'))
  const base = slash >= 0 ? workspaceDir.slice(slash + 1) : workspaceDir
  return sanitizeRepoName(base)
}

/**
 * Whether `gh auth status` output says a GitHub account is logged in. gh prints
 * "not logged in" phrasing on failure (and historically writes the whole report to
 * stderr), so an explicit not-logged-in wins over any positive marker, then a
 * "Logged in to" / "Active account" / "Token:" line confirms a live session.
 */
export function isGhAuthenticated(output: string): boolean {
  if (!output) return false
  if (/not logged in|You are not logged into/i.test(output)) return false
  return /Logged in to|Active account:|Token:/i.test(output)
}

/**
 * Pull the first `https://github.com/owner/repo` URL out of CLI output (e.g. what
 * `gh repo create` prints, or `git remote get-url origin`), stripping a trailing
 * `.git`. Null when there is none — the caller then reports without a URL.
 */
export function parseRepoUrl(output: string): string | null {
  const m = output.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+/)
  return m ? m[0].replace(/\.git$/, '') : null
}

/**
 * Build the argv for `gh repo create`. `--source=.` + `--remote=origin` + `--push`
 * makes gh create the remote, wire it up as origin, and push the current commits in
 * one shot; visibility is explicit; a non-empty description is passed as its own argv
 * element (no shell, so nothing to escape).
 */
export function buildRepoCreateArgs(opts: {
  name: string
  private?: boolean
  description?: string | null
}): string[] {
  const args = [
    'repo',
    'create',
    opts.name,
    opts.private ? '--private' : '--public',
    '--source=.',
    '--remote=origin',
    '--push'
  ]
  if (opts.description && opts.description.trim()) args.push('--description', opts.description.trim())
  return args
}

/**
 * The honest "now host it on Vercel" next-steps block. Deliberately does NOT claim an
 * automatic deploy — importing a repo on Vercel is an OAuth/dashboard step, and the CLI
 * path needs a token this tool never fabricates. Points at the repo (when we have its
 * URL) and at the scaffold_deploy workflow secrets as the two real paths to hosting.
 */
export function vercelNextSteps(repoUrl: string | null): string[] {
  return [
    'Next — host it on Vercel:',
    repoUrl
      ? `- Import ${repoUrl} at https://vercel.com/new — Vercel detects the framework and redeploys on every push.`
      : '- Once it is on GitHub, import the repo at https://vercel.com/new.',
    '- Or, if you ran scaffold_deploy, add the VERCEL_TOKEN / VERCEL_ORG_ID / VERCEL_PROJECT_ID repo secrets and the bundled deploy workflow ships on each push — no manual import needed.'
  ]
}
