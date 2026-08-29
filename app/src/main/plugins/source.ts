/**
 * Plugin source normalization.
 *
 * A plugin can be named many ways — a GitHub shorthand (`owner/repo`), a full
 * clone URL (`https://github.com/owner/repo.git`), a `github:owner/repo` scheme,
 * an scp-style Git remote (`git@github.com:owner/repo.git`), a browser URL that
 * points at a subpath (`.../tree/main`), or a local folder path. This module
 * turns any of those into a single normalized {@link PluginSource} the installer
 * can act on, plus a slugified plugin name. Pure and total: unrecognized input
 * comes back as `{ ok: false, error }` rather than throwing, so a typo surfaces
 * as a friendly message instead of a crash.
 */

/** A resolved place to fetch a plugin from. */
export type PluginSource =
  | { ok: true; kind: 'git'; url: string; name: string }
  | { ok: true; kind: 'local'; path: string; name: string }
  | { ok: false; error: string }

/** Slugifies a repo/folder name into a safe plugin key (lowercase, ascii, dashed). */
export function pluginSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\.git$/, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64)
}

/** True when `input` looks like a filesystem path rather than a repo reference. */
function looksLocal(input: string): boolean {
  return (
    input.startsWith('.') ||
    input.startsWith('/') ||
    input.startsWith('~') ||
    input.startsWith('\\\\') || // UNC path
    /^[A-Za-z]:[\\/]/.test(input) || // Windows drive path (C:\ or C:/)
    input.startsWith('file://')
  )
}

/** Derives a plugin name from the last meaningful segment of a path/URL. */
function nameFromTail(tail: string): string {
  const segs = tail.split(/[\\/]+/).filter(Boolean)
  const last = segs[segs.length - 1] ?? ''
  return pluginSlug(last)
}

/** Normalizes a `github.com/owner/repo[/...]` pathname to `{ owner, repo }`. */
function githubOwnerRepo(pathname: string): { owner: string; repo: string } | null {
  const segs = pathname.split('/').filter(Boolean)
  if (segs.length < 2) return null
  return { owner: segs[0], repo: segs[1].replace(/\.git$/, '') }
}

/**
 * Resolves a user-supplied plugin source into a normalized {@link PluginSource}.
 * Recognizes (in order): local paths, scp-style Git remotes, the `github:`/`gh:`
 * schemes, full http(s) URLs (GitHub subpaths collapse to owner/repo), and the
 * bare `owner/repo` GitHub shorthand.
 */
export function normalizePluginSource(input: string): PluginSource {
  const raw = input.trim()
  if (!raw) return { ok: false, error: 'Enter a repository URL or owner/repo.' }

  // Local folder — install straight from disk (handy for developing a plugin).
  if (looksLocal(raw)) {
    const path = raw.startsWith('file://') ? raw.slice('file://'.length) : raw
    const name = nameFromTail(path)
    if (!name) return { ok: false, error: 'Could not derive a plugin name from that path.' }
    return { ok: true, kind: 'local', path, name }
  }

  // scp-style Git remote: git@github.com:owner/repo.git
  const scp = /^(?:[^@]+@)?([^:]+):(.+)$/.exec(raw)
  if (scp && !raw.includes('://') && scp[1].includes('.')) {
    const name = nameFromTail(scp[2])
    if (!name) return { ok: false, error: 'Could not derive a plugin name from that remote.' }
    return { ok: true, kind: 'git', url: raw, name }
  }

  // github:owner/repo  /  gh:owner/repo
  const scheme = /^(?:github|gh):(.+)$/i.exec(raw)
  if (scheme) {
    const or = githubOwnerRepo(scheme[1])
    if (!or) return { ok: false, error: 'Use github:owner/repo.' }
    return {
      ok: true,
      kind: 'git',
      url: `https://github.com/${or.owner}/${or.repo}.git`,
      name: pluginSlug(or.repo)
    }
  }

  // Full http(s) URL.
  if (/^https?:\/\//i.test(raw)) {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      return { ok: false, error: `Not a valid URL: ${raw}` }
    }
    // GitHub browser URLs often carry a subpath (/tree/main, /blob/...); collapse
    // to the repo root so the clone URL is always owner/repo.git.
    if (/(^|\.)github\.com$/i.test(url.hostname)) {
      const or = githubOwnerRepo(url.pathname)
      if (!or) return { ok: false, error: 'That GitHub URL has no owner/repo.' }
      return {
        ok: true,
        kind: 'git',
        url: `https://github.com/${or.owner}/${or.repo}.git`,
        name: pluginSlug(or.repo)
      }
    }
    // Any other Git host: clone the URL as given, name from its last segment.
    const name = nameFromTail(url.pathname)
    if (!name) return { ok: false, error: 'Could not derive a plugin name from that URL.' }
    return { ok: true, kind: 'git', url: raw, name }
  }

  // Bare GitHub shorthand: owner/repo (exactly two path-ish segments, no scheme).
  const shorthand = /^([\w.-]+)\/([\w.-]+)$/.exec(raw)
  if (shorthand) {
    const owner = shorthand[1]
    const repo = shorthand[2].replace(/\.git$/, '')
    return {
      ok: true,
      kind: 'git',
      url: `https://github.com/${owner}/${repo}.git`,
      name: pluginSlug(repo)
    }
  }

  return {
    ok: false,
    error: 'Unrecognized source — use owner/repo, a git URL, or a local folder path.'
  }
}
