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

/**
 * The prompt behind the built-in `/remember` command. It doesn't save anything
 * itself — it instructs the model to record a durable fact via its `remember_user`
 * tool, so the fact lands in Sylor's global cross-project memory the same way an
 * organically-learned one would. With no argument it asks the user what to keep
 * (rather than saving a blank). Pure/dependency-free so the renderer's `/` menu
 * and any test can build the same string.
 */
export function buildRememberPrompt(argString: string): string {
  const note = argString.trim()
  if (!note) {
    return (
      'I want you to remember something about me for future sessions. Ask me what ' +
      'you should remember — a short, durable fact about who I am, how I like to ' +
      'work, or my taste — then save it to your long-term memory.'
    )
  }
  return (
    `Remember this about me for future sessions, across all my projects: "${note}". ` +
    'Save it now using your remember_user tool, then confirm in one short sentence. ' +
    'Record only this fact — do not start any other work.'
  )
}
