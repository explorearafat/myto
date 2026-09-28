import type { ToolContext, ToolDef, ToolGate } from './registry'
import { detectRuntimes, summarizeRuntimes } from '../cowork-runtimes'

/**
 * `detect_runtimes` — a read-only probe of which script runtimes and Office/PDF/3D
 * toolchains are installed and the EXACT command to invoke each. It exists so the
 * agent (especially a weaker model) picks a command that actually runs before it
 * scripts a deliverable — on Windows `py`/`python`, never `python3` (the Store
 * alias). Cowork-only: Track-1 scripting lands files in the working folder. Always
 * re-probes (no cache) so a re-check after the agent installs something is accurate.
 */
export const detectRuntimesTool: ToolDef = {
  name: 'detect_runtimes',
  description:
    'Detect which script runtimes and document toolchains are installed here (Python, Node, npm, pip, Blender, LibreOffice) and the exact command to invoke each. Call it before scripting a deliverable so you use a real interpreter (on Windows never python3).',
  usage: '{}',
  // Read-only: no sideEffect, so it never raises a Cowork permission prompt.
  schema: { type: 'object', properties: {}, additionalProperties: false },
  available: (gate: ToolGate) => gate.mode === 'cowork' || gate.mode === 'research',
  async run(_input: unknown, ctx: ToolContext): Promise<string> {
    return summarizeRuntimes(await detectRuntimes(ctx.signal))
  }
}
