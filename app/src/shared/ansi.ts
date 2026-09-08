/**
 * Terminal escape-sequence stripping, for the two places pty output stops being a
 * terminal stream and becomes plain text: the transcript a model reads back as a
 * tool result, and anything scraped out of a dev server's stdout.
 *
 * A pty emits far more than colour codes. A dev server that prints
 *
 * ```text
 *   ➜  Local:   http://localhost:8080/\x1b[K
 * ```
 *
 * — `\x1b[K` is "erase to end of line", which Vite/webpack progress output emits
 * constantly — used to survive a colour-only stripper, so the URL scraped out of
 * that line came back as `http://localhost:8080/` + an invisible ESC + `[K`, and
 * the preview pane's address bar read `http://localhost:8080/[K`. The same escapes
 * reached the model verbatim in captured command output, so it echoed the broken
 * URL back into the conversation.
 *
 * So the rule is: strip the whole escape grammar, not the fashionable part of it.
 * {@link stripAnsi} covers CSI (`\x1b[…`, of which SGR colour is one final byte out
 * of dozens), OSC (`\x1b]…` window titles and hyperlinks), the string-terminated
 * DCS/SOS/PM/APC families, charset selection (`\x1b(B`) and the plain two-byte
 * escapes (`\x1b7`, `\x1b=`).
 *
 * Live terminal output is NOT stripped — xterm.js in the terminal panel needs every
 * byte to render colour and cursor movement. Only the captured copy is cleaned.
 */

/**
 * One complete escape sequence, in five alternatives:
 *
 *  1. OSC — `\x1b]` … terminated by BEL or ST (window titles, OSC-8 hyperlinks).
 *  2. DCS/SOS/PM/APC — `\x1b` `P`/`X`/`^`/`_` … ST.
 *  3. CSI — `\x1b[` params, intermediates, one final byte in `@`–`~`. SGR colour
 *     (`m`) is one final byte out of dozens; `K`, `J`, `G`, `H` are the erase and
 *     cursor-move ones that a colour-only stripper left behind.
 *  4. nF — `\x1b` + intermediates + final, e.g. charset selection `\x1b(B`.
 *  5. Fp/Fe/Fs — the plain two-byte escapes: `\x1b7`/`\x1b8` (save/restore cursor),
 *     `\x1b=`, `\x1bM`. The `[` of a CSI is deliberately outside this range.
 *
 * Order matters: the string-terminated families must win before the two-byte
 * alternative, which would otherwise eat their introducer and leave the payload as
 * visible text. Each of them also accepts end-of-input as a terminator, so a
 * sequence still arriving when the buffer is read does not leak its payload either.
 */
/* eslint-disable no-control-regex -- matching control bytes is the whole job */
const ESCAPE_RE =
  /\x1b\][\s\S]*?(?:\x07|\x1b\\|$)|\x1b[P^_X][\s\S]*?(?:\x1b\\|\x07|$)|\x1b\[[0-9;:<=>?]*[ -/]*[@-~]|\x1b[ -/]+[0-~]|\x1b[0-?@-Z\\-~]/g
/* eslint-enable no-control-regex */

/**
 * A sequence cut in half — by a chunk boundary, or by the output cap slicing the
 * buffer. Only the introducer forms need handling here: the string-terminated
 * families above already consume to end-of-input when unterminated.
 */
// eslint-disable-next-line no-control-regex
const PARTIAL_ESCAPE_RE = /\x1b(?:\[[0-9;:<=>?]*[ -/]*|[ -/]+)?$/

/**
 * Remove every terminal escape sequence from `text`, including a trailing one that
 * was cut off mid-sequence. Printable characters, tabs and newlines are untouched —
 * this is not a text normalizer, it only takes out what a terminal would have
 * consumed as a control instruction and never displayed.
 */
export function stripAnsi(text: string): string {
  if (!text.includes('\x1b')) return text
  return text.replace(ESCAPE_RE, '').replace(PARTIAL_ESCAPE_RE, '')
}
