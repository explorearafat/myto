/**
 * Pure helpers for interpreting call speech — extracted from call-session so
 * they are unit-testable without the Electron module graph. No imports.
 */

/** Map a spoken yes/no to an approval decision (null = not a yes/no). */
export function yesNo(text: string): 'allow' | 'deny' | null {
  const t = text.toLowerCase().trim()
  if (/^(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|approve|allowed|confirm|please do)\b/.test(t)) {
    return 'allow'
  }
  if (/^(no|nope|nah|don't|do not|stop|cancel|deny|decline|negative)\b/.test(t)) return 'deny'
  return null
}

export interface QuickCommand {
  command: string
  longRunning?: boolean
  say?: string
}

/**
 * The quick-command fast path: crisp utterances that map straight to PowerShell,
 * skipping the model round-trip (the single biggest latency win for "check my
 * directory"-class commands). Everything else goes to the agent, which plans
 * and uses its own tools.
 */
export function matchQuickCommand(text: string): QuickCommand | null {
  const t = text.toLowerCase().trim().replace(/[?.!]+$/, '')
  if (/^(open|start|launch)\s+(powershell|a powershell|terminal|a terminal)$/.test(t)) {
    return { command: 'Start-Process pwsh', say: 'Opening PowerShell.' }
  }
  if (/^(open|start|launch)\s+(vs ?code|visual studio code)$/.test(t)) {
    return { command: 'Start-Process code', say: 'Opening VS Code.' }
  }
  if (/(what('| i)?s )?(my|the|current|working) (directory|folder|path)|where am i|current directory$/.test(t)) {
    return { command: 'Get-Location | Select-Object -ExpandProperty Path', say: 'Checking.' }
  }
  if (/^(list|show)( me)? (the )?files?( in (the )?(current|this) (directory|folder))?$/.test(t)) {
    return { command: 'Get-ChildItem -Name', say: 'Listing the folder.' }
  }
  if (/^git (status|log|diff|branch)$/.test(t)) {
    return { command: t, say: `Running ${t}.` }
  }
  const run = /^(run|execute)\s+(.+)$/.exec(t)
  if (run && /^(npm|pnpm|yarn|node|npx|python|pip|pytest|tsc|dotnet|flutter|cargo|go|git)\b/.test(run[2])) {
    return { command: run[2], say: `Running ${run[2]}.` }
  }
  return null
}

/** A short spoken wrap of a command result (numbers/paths in, dumps out). */
export function describeResult(exitCode: number | null, output: string, timedOut: boolean): string {
  if (timedOut) return 'The command timed out, so I stopped it.'
  const firstLine = output.split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? ''
  if (exitCode === 0) {
    if (!firstLine) return 'Done — the command finished cleanly.'
    if (firstLine.length <= 120) return `Done. ${firstLine}`
    return 'Done — it finished cleanly; the full output is in the call log.'
  }
  const errLine = firstLine.slice(0, 120)
  return `The command failed${errLine ? `: ${errLine}` : ''}.`
}

/** Heuristic: does this utterance describe a long-running project task? */
export function looksLikeTask(text: string): boolean {
  const t = text.toLowerCase()
  return (
    /\b(finish|complete|implement|build|create|fix all|refactor|write tests|set up|add)\b/.test(t) &&
    /\b(project|app|feature|system|endpoint|auth|authentication|tests?|api|screen|page|component)\b/.test(t) &&
    text.length > 25
  )
}
