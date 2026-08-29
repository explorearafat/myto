/**
 * Pure slash-command helpers shared by the main process (the engine + commands
 * registry) and the renderer (the composer's `/` menu + submit-time expansion).
 *
 * Kept dependency-free (plain string ops, no Node/Electron) so both processes can
 * import it and there is a single source of truth for how a `/name args` line is
 * parsed and how a command's template body is expanded.
 */

/**
 * Splits a composer line into a leading `/name` and the rest, or null when the
 * line is not a slash invocation. The name is the run of word characters (and
 * dashes) after a single leading `/`; everything after the first whitespace is
 * the argument string. A bare `/` or `//…` (no name) is not a command.
 */
export function parseSlash(text: string): { name: string; args: string } | null {
  const m = /^\/([A-Za-z0-9][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/.exec(text.trimStart())
  if (!m) return null
  return { name: m[1], args: (m[2] ?? '').trim() }
}

/**
 * Expands a command's template body against the user's argument string. `$1`,
 * `$2`, … resolve to the whitespace-split positional words (an absent one → ''),
 * and `$ARGUMENTS` to the whole argument string. If the body references neither
 * yet arguments were supplied, they are appended so they are never silently
 * dropped. Mirrors the Claude CLI's custom-command substitution.
 */
export function expandCommand(body: string, argString: string): string {
  const args = argString.trim()
  const words = args ? args.split(/\s+/) : []
  // Detect references in the ORIGINAL body — after substitution the markers are
  // gone. A template that already consumes its args (via $ARGUMENTS or any $N)
  // must not also get them appended.
  const referencesArgs = /\$ARGUMENTS\b/.test(body) || /\$\d+/.test(body)
  let out = body.replace(/\$(\d+)/g, (_, d: string) => words[Number(d) - 1] ?? '')
  out = out.replace(/\$ARGUMENTS\b/g, args)
  if (!referencesArgs && args) out = `${out.trim()}\n\n${args}`
  return out.trim()
}
