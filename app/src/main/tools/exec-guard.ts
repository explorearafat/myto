/**
 * A thin, defence-in-depth guard over the string handed to {@link runCommandTool}.
 *
 * The Cowork *permission tier* (ask / auto-approve / bypass) is the real trust
 * boundary for exec — a single-user desktop agent legitimately runs arbitrary
 * build/test/scaffold commands, so a strict charset allowlist (like the one behind
 * OpenClaw's CVE-2026-31990 write-up) would break real use: `&&`, pipes, `$(...)`,
 * quotes and globs are all normal here and stay allowed.
 *
 * What this guard blocks is the narrow class with no legitimate place in a
 * single-line shell command: **control-character injection**. A NUL can truncate a
 * command so a preview/log shows one thing and the shell runs another; an embedded
 * newline/carriage-return smuggles a second command past a one-line review; a raw
 * ESC/other C0 control can spoof the Terminal pane the command is mirrored into.
 * Tab (U+0009) is the one control character that appears in real commands (inside
 * quoted args), so it is allowed.
 *
 * Reimplemented from the described behaviour — no OpenClaw code copied.
 */

/**
 * C0 control characters (U+0000–U+001F) plus DEL (U+007F), EXCEPT tab (U+0009).
 * Covers NUL, LF, CR, ESC and the rest — the injection/spoofing vectors — while
 * leaving every printable shell metacharacter untouched.
 */
const CONTROL_CHAR = /[\u0000-\u0008\u000A-\u001F\u007F]/

/** Human label for the specific offending control character, for the refusal message. */
function controlLabel(code: number): string {
  switch (code) {
    case 0x00:
      return 'a NUL byte'
    case 0x0a:
      return 'a newline'
    case 0x0d:
      return 'a carriage return'
    case 0x1b:
      return 'an escape (ANSI) character'
    default:
      return `a control character (0x${code.toString(16).padStart(2, '0')})`
  }
}

/**
 * Returns a human refusal reason if the command must NOT be run, or `null` when it is
 * fine. Pure and synchronous — the caller ({@link runCommandTool}) turns a non-null
 * reason into the tool's refusal string before anything reaches the shell.
 */
export function unsafeCommandReason(command: string): string | null {
  if (typeof command !== 'string') return 'the command must be a string.'
  const m = CONTROL_CHAR.exec(command)
  if (m) {
    const label = controlLabel(command.charCodeAt(m.index))
    return (
      `the command contains ${label} at position ${m.index}, which is blocked as control-character injection. ` +
      'Write a single-line command and join steps with && or ;.'
    )
  }
  return null
}
