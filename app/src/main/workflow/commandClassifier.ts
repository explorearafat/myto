/**
 * Command classification for shell commands (Principle 7 #2).
 *
 * Classifies a command line into one of three risk classes, which the permission
 * matrix uses to gate execution. The classifier is lightweight and conservative:
 * prefix-based with a small parse for redirects/pipes, in the spirit of Claude
 * Code's approach. A false negative (classifying a destructive command as mutating)
 * is safer than a false positive (blocking a safe command), so the destructive list
 * is explicit and narrow.
 *
 * **Read-only:** commands that observe state without changing it. Auto in more
 * modes (plan/ask/auto-edit when the mode permits commands at all).
 *
 * **Mutating:** commands that change state within the workspace. Gated by mode.
 *
 * **Destructive:** commands that irreversibly delete data, force-overwrite without
 * backup, or reach outside the workspace. Always ask, even under
 * `bypassPermissions` (mirroring the browse `delete`-always-asks rule).
 *
 * Examples:
 *  - read-only: `ls`, `cat`, `grep`, `git status`, `git log`, `npm ls`, `tsc --noEmit`
 *  - mutating: `npm install`, `git commit`, `mv`, redirects into workspace files
 *  - destructive: `rm -rf`, `git reset --hard`, `git clean -f`, `dd`, `sudo`,
 *    redirects outside workspace
 */

export type CommandClass = 'read-only' | 'mutating' | 'destructive'

/**
 * Commands that are known to be read-only (observe, don't change). Prefix match,
 * case-insensitive. A command not in this list is assumed mutating unless it hits
 * a destructive pattern.
 */
const READ_ONLY_COMMANDS = [
  'ls', 'dir', 'cat', 'head', 'tail', 'less', 'more', 'grep', 'find', 'locate',
  'which', 'where', 'pwd', 'echo', 'printf', 'test', '[',
  'git status', 'git diff', 'git log', 'git show', 'git ls-files', 'git ls-tree',
  'git blame', 'git branch', 'git tag', 'git remote', 'git config --get',
  'npm ls', 'npm list', 'npm view', 'npm search', 'npm outdated',
  'yarn list', 'yarn info', 'yarn why',
  'pnpm list', 'pnpm why',
  'pip list', 'pip show', 'pip search',
  'cargo search', 'cargo tree',
  'docker ps', 'docker images', 'docker inspect',
  'kubectl get', 'kubectl describe',
  'node --version', 'npm --version', 'python --version', 'java -version',
  'tsc --noEmit', 'tsc --version',
  'eslint', 'prettier --check',
  'jest --listTests', 'vitest list',
  'make --dry-run', 'make -n',
  'curl', 'wget --spider', 'ping', 'traceroute', 'nslookup', 'dig', 'host',
  'ps', 'top', 'htop', 'df', 'du', 'free', 'uptime', 'uname', 'hostname',
  'env', 'printenv', 'set', 'export -p',
  'file', 'stat', 'wc', 'sort', 'uniq', 'cut', 'paste', 'diff', 'cmp',
  'man', 'help', 'info', '--help', '-h', '--version', '-v'
]

/**
 * Patterns that indicate a destructive command. Checked BEFORE the read-only list,
 * so they override. Regex patterns are matched against the whole command line,
 * case-insensitive.
 */
const DESTRUCTIVE_PATTERNS = [
  // Recursive deletes and force removes
  /\brm\s+.*-[a-z]*r/i, // rm -r, rm -rf, rm -fr
  /\brm\s+.*--recursive/i,
  /\brmdir\s+.*-[a-z]*r/i,
  // Windows recursive/force delete: rmdir /s, rd /s, del /s (any flag order, e.g.
  // `rmdir /r /s build`, `del /f /s *`). Windows is the primary platform, so these
  // slash-switch forms must be caught as surely as their POSIX `-rf` cousins.
  /\brmdir\b[^|;&]*\s\/s\b/i,
  /\brd\b[^|;&]*\s\/s\b/i,
  /\bdel\b[^|;&]*\s\/s\b/i,
  // Git destructive operations
  /\bgit\s+reset\s+--hard/i,
  /\bgit\s+clean\s+-[a-z]*f/i, // git clean -f, -fd, -fdx
  /\bgit\s+push\s+.*--force/i,
  /\bgit\s+push\s+-f\b/i,
  /\bgit\s+branch\s+-D/i, // force delete branch
  // Disk operations
  /\bdd\b/i,
  /\bformat\b/i,
  /\bmkfs\./i,
  /\bfdisk\b/i,
  // Privilege escalation
  /\bsudo\b/i,
  /\bsu\b/i,
  /\brunas\b/i,
  // Package manager destructive ops
  /\bnpm\s+uninstall\b/i,
  /\byarn\s+remove\b/i,
  /\bpip\s+uninstall\b/i,
  // Docker/container destructive
  /\bdocker\s+(rm|rmi|prune)\b/i,
  /\bkubectl\s+delete\b/i,
  // System-level changes
  /\bchmod\s+[0-7]*[0-2][0-7]*\b/i, // removing permissions
  /\bchown\b/i,
  /\bkill\s+-9/i, // SIGKILL
  /\bpkill\b/i,
  /\bkillall\b/i,
  // Shell redirects that overwrite (checked separately for path)
  />\s*[^>]/i // single > (not >>), will be path-checked
]

/**
 * Classifies a shell command line into its risk class. Conservative: anything not
 * explicitly recognised as read-only or destructive is assumed mutating.
 */
export function classifyCommand(command: string, workspaceRoot: string): CommandClass {
  const trimmed = command.trim()
  if (!trimmed) return 'read-only' // empty command is no-op

  // Destructive patterns take precedence.
  for (const pattern of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(trimmed)) {
      // Special case: single > redirect. Check if it's writing outside workspace.
      if (pattern.source.includes('>')) {
        if (hasRedirectOutsideWorkspace(trimmed, workspaceRoot)) {
          return 'destructive'
        }
        // Redirect inside workspace is mutating, not destructive.
        return 'mutating'
      }
      return 'destructive'
    }
  }

  // Check if it's a known read-only command (prefix match). Both sides are
  // lower-cased so the match is case-insensitive — the list entries carry their
  // natural casing (e.g. `tsc --noEmit`), and the input was lower-cased above.
  const lower = trimmed.toLowerCase()
  for (const cmd of READ_ONLY_COMMANDS) {
    const needle = cmd.toLowerCase()
    if (lower.startsWith(needle)) {
      // Verify it's actually the command, not a substring (e.g. "list" shouldn't match "listen").
      const after = lower[needle.length]
      if (!after || /\s/.test(after)) {
        return 'read-only'
      }
    }
  }

  // Check for redirects outside workspace (mutating inside, destructive outside).
  if (hasRedirectOutsideWorkspace(trimmed, workspaceRoot)) {
    return 'destructive'
  }

  // Default: mutating (changes state, but not irreversibly destructive).
  return 'mutating'
}

/**
 * True if the command has a redirect (> or >>) pointing outside the workspace root.
 * Redirects inside the workspace are mutating; redirects outside are destructive
 * (writing to the user's home directory, /etc, etc.).
 */
function hasRedirectOutsideWorkspace(command: string, workspaceRoot: string): boolean {
  // Naive parse: look for > or >> followed by a path. This is heuristic and will
  // miss complex shell quoting, but it's conservative: a false negative (missing an
  // outside-redirect) just classifies it as mutating instead of destructive, which
  // is still gated.
  const redirectMatch = /(?:^|[|;&])\s*[^|;&]*\s+(>>?)\s+([^\s|;&]+)/.exec(command)
  if (!redirectMatch) return false

  const target = redirectMatch[2].trim()
  // Absolute path outside workspace, or relative path starting with ../ (up-and-out).
  if (target.startsWith('/') || target.startsWith('\\')) {
    // Absolute: destructive unless it's under workspaceRoot.
    return !target.startsWith(workspaceRoot)
  }
  if (target.startsWith('../') || target.startsWith('..\\')) {
    // Relative up-and-out: assume destructive (a conservative false positive, since
    // we don't know the cwd, but safer than missing an escape).
    return true
  }
  // Relative path inside workspace: mutating, not destructive.
  return false
}
