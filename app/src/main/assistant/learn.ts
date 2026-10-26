import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatImage } from '../../shared/types'
import type { Provider } from '../providers/provider'
import { readScreen } from './vision'
import type { Computer } from './computer'

/**
 * Learn-by-watching, then silent practice — the Assistant's training loop.
 *
 * LEARN: while the user demonstrates a task on screen, the assistant takes
 * periodic screenshots (screen share). On stop, the whole strip goes to the
 * vision model ONCE, which turns it into a numbered step list (open / click /
 * type / key actions with coordinates and text). The steps are saved as a
 * reusable skill file under the assistant data dir.
 *
 * PRACTICE: replay a skill silently — run each step, screenshot after it, and
 * ask the vision model whether that step's expected result is on screen; one
 * retry per step, then an honest failure report. No pings, no noise.
 */

export interface LearnedStep {
  action: 'open' | 'click' | 'doubleclick' | 'rightclick' | 'type' | 'key' | 'paste' | 'scroll' | 'wait'
  /** Free-text target, e.g. "the search box top-right". */
  target?: string
  x?: number
  y?: number
  text?: string
  keys?: string
  /** What should be visible after this step — the practice-time check. */
  expect?: string
  /** Pause after this step, ms (defaults to 350). */
  pauseMs?: number
}

export interface LearnedSkill {
  name: string
  goal: string
  steps: LearnedStep[]
  createdAt: string
  model: string
}

export function skillsDir(dataDir: string): string {
  return join(dataDir, 'skills')
}

export function saveSkill(dataDir: string, skill: LearnedSkill): void {
  const dir = skillsDir(dataDir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, slug(skill.name) + '.json'), JSON.stringify(skill, null, 2) + '\n', 'utf8')
}

export function loadSkill(dataDir: string, name: string): LearnedSkill | null {
  const p = join(skillsDir(dataDir), slug(name) + '.json')
  try {
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf8')) as LearnedSkill
  } catch {
    return null
  }
}

export function listSkills(dataDir: string): LearnedSkill[] {
  const dir = skillsDir(dataDir)
  if (!existsSync(dir)) return []
  const out: LearnedSkill[] = []
  let files: string[] = []
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  for (const f of files) {
    try {
      out.push(JSON.parse(readFileSync(join(dir, f), 'utf8')) as LearnedSkill)
    } catch {
      /* skip broken files */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'skill'
}

/** Delete a learned skill by name. */
export function removeSkill(dataDir: string, name: string): boolean {
  const p = join(skillsDir(dataDir), slug(name) + '.json')
  try {
    if (!existsSync(p)) return false
    unlinkSync(p)
    return true
  } catch {
    return false
  }
}

/** The one-shot teaching prompt: screenshots in, steps out. */
export function learningQuestion(goal: string): string {
  return [
    `The user is teaching me a computer task: "${goal}".`,
    'These screenshots show the task being performed in order (oldest first).',
    'Convert what you see into a numbered step list I can replay, as compact JSON lines, one per line:',
    '{"action":"open","text":"app-or-url","expect":"what is visible after this"}',
    '{"action":"click","x":123,"y":456,"expect":"..."}',
    '{"action":"type","text":"...","expect":"..."}',
    '{"action":"key","keys":"ctrl+s","expect":"..."}',
    '{"action":"wait","pauseMs":800,"expect":"..."}',
    'Rules: coordinates are pixel positions in the LAST screenshot where the click happens;',
    'type only the exact visible text; keep the list minimal but complete;',
    'output ONLY the JSON lines, nothing else.'
  ].join(' ')
}

/** Parse the vision model's JSON-line step list — tolerant of fences and prose. */
export function parseSteps(read: string): LearnedStep[] {
  const steps: LearnedStep[] = []
  for (const line of read.split(/\r?\n/)) {
    const m = /\{.*\}/.exec(line)
    if (!m) continue
    try {
      const o = JSON.parse(m[0]) as Record<string, unknown>
      const action = String(o.action ?? '')
      if (!['open', 'click', 'doubleclick', 'rightclick', 'type', 'key', 'paste', 'scroll', 'wait'].includes(action)) continue
      steps.push({
        action: action as LearnedStep['action'],
        target: typeof o.target === 'string' ? o.target : undefined,
        x: typeof o.x === 'number' ? o.x : undefined,
        y: typeof o.y === 'number' ? o.y : undefined,
        text: typeof o.text === 'string' ? o.text : undefined,
        keys: typeof o.keys === 'string' ? o.keys : undefined,
        expect: typeof o.expect === 'string' ? o.expect : undefined,
        pauseMs: typeof o.pauseMs === 'number' ? o.pauseMs : undefined
      })
    } catch {
      /* not a step line */
    }
  }
  return steps
}

export interface LearnDeps {
  provider: Provider
  modelId: string
  computer: Computer
  capture: () => Promise<ChatImage | null>
}

export class LearningSession {
  private frames: ChatImage[] = []
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: LearnDeps, private readonly goal: string) {}

  start(intervalMs = 2000): void {
    if (this.timer) return
    void this.grab()
    this.timer = setInterval(() => void this.grab(), intervalMs)
  }

  private async grab(): Promise<void> {
    const shot = await this.deps.capture()
    if (shot) this.frames.push(shot)
    if (this.frames.length > 24) this.frames.shift() // keep the last ~48s of watching
  }

  /** Stop watching and distil the frames into a saved skill. */
  async stop(dataDir: string, name: string): Promise<LearnedSkill> {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    const read = await readScreen(this.deps.provider, this.deps.modelId, this.frames, learningQuestion(this.goal))
    if (!read.ok) throw new Error(read.text)
    const steps = parseSteps(read.text)
    if (steps.length === 0) throw new Error('the model could not extract steps from the recording — try again and move slower')
    const skill: LearnedSkill = {
      name,
      goal: this.goal,
      steps,
      createdAt: new Date().toISOString(),
      model: this.deps.modelId
    }
    saveSkill(dataDir, skill)
    return skill
  }
}

export interface PracticeReport {
  skill: string
  ok: boolean
  steps: Array<{ index: number; action: string; ok: boolean; detail: string }>
  detail: string
}

/** The verification question for one practice step. */
function verifyQuestion(step: LearnedStep): string {
  return `Does this screenshot show that this step just happened: "${step.expect ?? step.action}${step.target ? ' on ' + step.target : ''}"? Answer exactly YES or NO, then one short line on what you actually see.`
}

/** Replay a learned skill silently, verifying each step via vision (one retry). */
export async function practiceSkill(deps: LearnDeps, dataDir: string, name: string): Promise<PracticeReport> {
  const skill = loadSkill(dataDir, name)
  if (!skill) return { skill: name, ok: false, steps: [], detail: `no skill named "${name}"` }
  const report: PracticeReport = { skill: name, ok: true, steps: [], detail: '' }
  for (let i = 0; i < skill.steps.length; i++) {
    const step = skill.steps[i]
    const run = await runStep(deps.computer, step)
    let ok = run.ok
    let detail = run.detail
    if (ok && step.expect) {
      const shot = await deps.capture()
      const check = shot ? await readScreen(deps.provider, deps.modelId, [shot], verifyQuestion(step)) : { ok: false, text: 'capture failed' }
      ok = /^yes\b/i.test(check.text)
      detail = check.text.split('\n').slice(0, 2).join(' ')
      if (!ok) {
        // One silent retry.
        const again = await runStep(deps.computer, step)
        const shot2 = await deps.capture()
        const check2 = shot2 ? await readScreen(deps.provider, deps.modelId, [shot2], verifyQuestion(step)) : { ok: false, text: '' }
        ok = again.ok && /^yes\b/i.test(check2.text)
        detail = ok ? 'retry succeeded' : `${detail} — retry did not verify either`
      }
    }
    report.steps.push({ index: i + 1, action: step.action, ok, detail })
    if (!ok) {
      report.ok = false
      report.detail = `stopped at step ${i + 1} (${step.action})`
      return report
    }
    await new Promise((r) => setTimeout(r, step.pauseMs ?? 350))
  }
  report.detail = `all ${skill.steps.length} steps verified`
  return report
}

async function runStep(computer: Computer, step: LearnedStep): Promise<{ ok: boolean; detail: string }> {
  const fail = (d: string): { ok: boolean; detail: string } => ({ ok: false, detail: d })
  switch (step.action) {
    case 'open': {
      const r = await computer.open(step.text ?? step.target ?? '')
      return r.ok ? { ok: true, detail: 'opened' } : fail(`open failed: ${r.detail}`)
    }
    case 'click':
    case 'doubleclick':
    case 'rightclick': {
      if (typeof step.x !== 'number' || typeof step.y !== 'number') return fail('missing x/y')
      const r = await computer.click(step.x, step.y, step.action === 'click' ? 'left' : step.action === 'doubleclick' ? 'double' : 'right')
      return r.ok ? { ok: true, detail: 'clicked' } : fail(`click failed: ${r.detail}`)
    }
    case 'type': {
      const r = await computer.type(step.text ?? '')
      return r.ok ? { ok: true, detail: 'typed' } : fail(`type failed: ${r.detail}`)
    }
    case 'paste': {
      const r = await computer.paste(step.text ?? '', false)
      return r.ok ? { ok: true, detail: 'pasted' } : fail(`paste failed: ${r.detail}`)
    }
    case 'key': {
      const r = await computer.key(step.keys ?? '')
      return r.ok ? { ok: true, detail: 'pressed' } : fail(`key failed: ${r.detail}`)
    }
    case 'scroll': {
      const r = await computer.scroll(3)
      return r.ok ? { ok: true, detail: 'scrolled' } : fail(`scroll failed: ${r.detail}`)
    }
    case 'wait':
      return { ok: true, detail: 'waited' }
    default:
      return fail(`unknown action "${step.action}"`)
  }
}
