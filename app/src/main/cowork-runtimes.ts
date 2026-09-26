/**
 * Runtime detection for Cowork "Track 1" — producing real deliverables (Excel,
 * PowerPoint, Word, PDF, data, 3D) by WRITING AND RUNNING a script, rather than
 * opening a GUI app or pasting file contents into chat. Before the agent scripts a
 * deliverable it needs to know what is actually installed and — the Windows footgun
 * this exists for — the CORRECT command to invoke: `python3` is not a thing on
 * Windows (it hits the Microsoft Store App-Execution alias), so a weaker model that
 * reaches for the Linux idiom stalls. {@link detectRuntimes} probes the machine; the
 * pure helpers ({@link parseUsableVersion}, {@link buildRuntimeReport},
 * {@link summarizeRuntimes}) hold the logic so it is unit-testable without spawning.
 *
 * Kept dependency-light (only the shell primitives from {@link ./tools/runCode}) and
 * out of {@link ./provider-ipc} so it stays unit-testable — same reasoning as
 * {@link ./cowork-guards}.
 */
import { executeArgv, resolveShell } from './tools/runCode'

/** How long a single `<cmd> --version` probe may run before it is killed. */
const PROBE_TIMEOUT_MS = 5_000

/** One detected tool: the command to actually invoke, plus its parsed version. */
export interface RuntimeInfo {
  command: string
  version: string | null
}

/** What Track-1 scripting can rely on, per logical runtime (null = not found). */
export interface RuntimeReport {
  python: RuntimeInfo | null
  pip: RuntimeInfo | null
  node: RuntimeInfo | null
  npm: RuntimeInfo | null
  blender: RuntimeInfo | null
  libreoffice: RuntimeInfo | null
}

/**
 * Output that reads as "this is a Windows Store placeholder, not a real interpreter"
 * — printed by the `python`/`python3` App-Execution-Alias stubs when the real thing
 * isn't installed. Rejected even if it somehow exits 0.
 */
const STORE_STUB = /was not found|Microsoft Store|execution alias/i

/**
 * Pull a version like `3.14.6` / `24.18.0` out of a `--version` line, or null when the
 * command was missing (`command not found`, `is not recognized`), was the Store stub,
 * or printed nothing parseable. stdout and stderr are searched together — tools
 * disagree on which stream carries `--version`.
 */
export function parseUsableVersion(output: string): string | null {
  if (!output || STORE_STUB.test(output)) return null
  const m = output.match(/(\d+\.\d+(?:\.\d+)?)/)
  return m ? m[1] : null
}
/**
 * The command names to try for each runtime, in preference order, per platform.
 * Windows leads with the `py` launcher (the dependable one) and `soffice`; POSIX
 * leads with `python3` and `libreoffice`. The FIRST candidate that yields a real
 * version wins, so the report always names a command that actually runs here.
 */
export function runtimeCandidates(platform: NodeJS.Platform): Record<keyof RuntimeReport, string[]> {
  const win = platform === 'win32'
  return {
    python: win ? ['py', 'python'] : ['python3', 'python'],
    pip: win ? ['pip', 'pip3'] : ['pip3', 'pip'],
    node: ['node'],
    npm: ['npm'],
    blender: ['blender'],
    libreoffice: win ? ['soffice', 'libreoffice'] : ['libreoffice', 'soffice']
  }
}

/**
 * Fold raw probe outputs (command → combined stdout+stderr) into a
 * {@link RuntimeReport}. Pure, so it is directly testable: for each runtime it takes
 * the first candidate whose output parses to a version. A command that ran but
 * printed no version, or was never probed, counts as absent.
 */
export function buildRuntimeReport(
  candidates: Record<keyof RuntimeReport, string[]>,
  outputs: Record<string, string>
): RuntimeReport {
  const pick = (cmds: string[]): RuntimeInfo | null => {
    for (const command of cmds) {
      const version = parseUsableVersion(outputs[command] ?? '')
      if (version !== null) return { command, version }
    }
    return null
  }
  return {
    python: pick(candidates.python),
    pip: pick(candidates.pip),
    node: pick(candidates.node),
    npm: pick(candidates.npm),
    blender: pick(candidates.blender),
    libreoffice: pick(candidates.libreoffice)
  }
}
/**
 * A single prompt-ready block telling the model what it can script with and — for
 * each present runtime — the exact interpreter and install command, so it never
 * guesses `python3` on Windows. Absent runtimes are listed with what they'd unlock,
 * so the model can tell the user "install X" instead of silently failing.
 */
export function summarizeRuntimes(report: RuntimeReport): string {
  const { python: py, node, npm, blender, libreoffice: lo } = report
  const lines = [
    py
      ? `- Python: ${py.command} ${py.version ?? ''} — xlsx (openpyxl), pptx (python-pptx), docx (python-docx), pdf (reportlab/fpdf2), data (pandas). Install: ${py.command} -m pip install <pkg>`
      : '- Python: not found — use the Node libraries below for Office/PDF here.',
    node
      ? `- Node: ${node.command} ${node.version ?? ''} — xlsx (exceljs), pptx (pptxgenjs), docx (docx), pdf (pdf-lib).${npm ? ` Install: ${npm.command} i <pkg>` : ''}`
      : '- Node: not found.',
    blender
      ? `- Blender: ${blender.command} ${blender.version ?? ''} — headless 3D/render: ${blender.command} --background --python <script.py>`
      : '- Blender: not found — 3D/render tasks need it installed first.',
    lo
      ? `- LibreOffice: ${lo.command} ${lo.version ?? ''} — convert/render: ${lo.command} --headless --convert-to <fmt> <file>`
      : '- LibreOffice: not found — document format-conversion/rendering needs it.'
  ]
  return (
    'Runtimes on this machine — build deliverables by writing and RUNNING a script with one of these, not by opening a GUI app and not by pasting file contents into chat:\n' +
    lines.join('\n') +
    '\nWrite the real file into the working folder, then verify it (re-open/parse it) before reporting done.'
  )
}
/**
 * Probe the machine for every candidate command in parallel (`<cmd> --version` via
 * the same shell Cowork commands run through, so PATH resolution matches reality) and
 * fold the results into a {@link RuntimeReport}. Never throws for a missing tool — an
 * absent command simply yields no version and reads as not-found.
 */
export async function detectRuntimes(
  signal: AbortSignal,
  platform: NodeJS.Platform = process.platform
): Promise<RuntimeReport> {
  const candidates = runtimeCandidates(platform)
  const shell = resolveShell()
  const commands = Array.from(new Set(Object.values(candidates).flat()))
  const outputs: Record<string, string> = {}
  await Promise.all(
    commands.map(async (command) => {
      const r = await executeArgv(shell.cmd, [shell.flag, `${command} --version`], signal, {
        timeoutMs: PROBE_TIMEOUT_MS
      })
      outputs[command] = `${r.stdout}\n${r.stderr}`.trim()
    })
  )
  return buildRuntimeReport(candidates, outputs)
}

/**
 * Process-lifetime cache of {@link detectRuntimes} for the per-turn system-prompt
 * injection, which would otherwise re-probe on every Cowork turn. Runtimes don't
 * change within a session, so the first successful report is reused; only successes
 * are cached, so a cancelled/failed probe is retried next turn. The `detect_runtimes`
 * TOOL deliberately does NOT use this — it always re-probes so a re-check after the
 * agent installs something reflects reality.
 */
let cachedReport: RuntimeReport | null = null

/** Cached {@link detectRuntimes} for turn-start injection (see {@link cachedReport}). */
export async function detectRuntimesCached(signal: AbortSignal): Promise<RuntimeReport> {
  if (cachedReport) return cachedReport
  const report = await detectRuntimes(signal)
  cachedReport = report
  return report
}

/** Clear the cache — for tests, and if a future flow needs a forced re-probe. */
export function resetRuntimeCache(): void {
  cachedReport = null
}
