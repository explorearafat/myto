import { describe, expect, it } from 'vitest'
import type { TaskNode } from '@shared/types'
import {
  authoredSectionIds,
  phaseFor,
  phaseRoadmap,
  planSectionBrief,
  renderPhasePlan,
  roadmapComplete
} from '@main/workflow/orchestrator/phasePlan'

const task = (id: string, overrides: Partial<TaskNode> = {}): TaskNode => ({
  id,
  role: 'builder',
  description: `do ${id}`,
  dependsOn: [],
  state: 'pending',
  attempts: 0,
  ...overrides
})

describe('phaseRoadmap', () => {
  it('scales the number of phases to the complexity', () => {
    expect(phaseRoadmap('simple')).toHaveLength(3)
    expect(phaseRoadmap('medium')).toHaveLength(5)
    expect(phaseRoadmap('complex')).toHaveLength(9)
  })

  it('numbers phases from 1 and names every one', () => {
    for (const c of ['simple', 'medium', 'complex'] as const) {
      const road = phaseRoadmap(c)
      expect(road.map((p) => p.n)).toEqual(road.map((_, i) => i + 1))
      for (const p of road) {
        expect(p.name).not.toBe('')
        expect(p.objective).not.toBe('')
      }
    }
  })

  it('opens on foundation work and closes on verification', () => {
    expect(phaseRoadmap('simple')[0].name).toBe('Foundation')
    expect(phaseRoadmap('simple')[2].name).toBe('Verification')
    expect(phaseRoadmap('complex')[0].name).toBe('Discovery and foundation')
    expect(phaseRoadmap('complex')[8].name).toBe('Final polish and audit')
  })
})

describe('phaseFor and roadmapComplete', () => {
  it('points at the phase after the completed ones', () => {
    expect(phaseFor('complex', 0).n).toBe(1)
    expect(phaseFor('complex', 2)).toMatchObject({ n: 3, name: 'Core pages' })
  })

  it('clamps past the end instead of running off the roadmap', () => {
    expect(phaseFor('simple', 99).n).toBe(3)
    expect(phaseFor('simple', -5).n).toBe(1)
  })

  it('knows when the roadmap is finished', () => {
    expect(roadmapComplete('simple', 2)).toBe(false)
    expect(roadmapComplete('simple', 3)).toBe(true)
    expect(roadmapComplete('complex', 8)).toBe(false)
    expect(roadmapComplete('complex', 9)).toBe(true)
  })
})

describe('authoredSectionIds and planSectionBrief', () => {
  it('grows the section list with complexity', () => {
    const simple = authoredSectionIds('simple')
    const medium = authoredSectionIds('medium')
    const complex = authoredSectionIds('complex')
    expect(simple.length).toBeLessThan(medium.length)
    expect(medium.length).toBeLessThan(complex.length)
    // Nothing is ever dropped as the work grows.
    for (const id of simple) expect(medium).toContain(id)
    for (const id of medium) expect(complex).toContain(id)
  })

  it('never asks the model for the sections derived from the task graph', () => {
    const ids = authoredSectionIds('complex')
    expect(ids).not.toContain('tasks')
    expect(ids).not.toContain('order')
    expect(ids).not.toContain('checklist')
    expect(ids).toContain('protect')
    expect(ids).toContain('security')
  })

  it('briefs each authored section with a key and what belongs there', () => {
    const brief = planSectionBrief('medium')
    expect(brief).toContain('- "why" — Why this phase exists:')
    expect(brief).toContain('- "protect" — Files that must NOT be modified:')
    expect(brief).not.toContain('"checklist"')
    expect(brief).not.toContain('"responsive"')
    expect(brief.split('\n')).toHaveLength(authoredSectionIds('medium').length)
  })
})

describe('renderPhasePlan', () => {
  const base = {
    phase: { n: 3, name: 'Core pages', objective: 'The primary screens, built on the shell.' },
    totalPhases: 9,
    complexity: 'complex' as const,
    request: 'Build me a modern university admission website',
    tasks: [task('t1'), task('t2'), task('t3', { dependsOn: ['t1', 't2'] })]
  }

  it('heads the plan with the phase, its objective and the request', () => {
    const out = renderPhasePlan(base)
    expect(out).toContain('# Plan — Phase 3 of 9: Core pages')
    expect(out).toContain('**Objective:** The primary screens, built on the shell.')
    expect(out).toContain('**Complexity:** complex')
    expect(out).toContain('> Build me a modern university admission website')
  })

  it('renders every mandated section for a production build, in order', () => {
    const out = renderPhasePlan(base)
    const headings = [
      'Why this phase exists',
      'Current project state',
      'Existing relevant architecture',
      'Requirements',
      'Assumptions',
      'Constraints',
      'Dependencies',
      'Files to inspect',
      'Files to create',
      'Files to modify',
      'Files that must NOT be modified',
      'Architecture strategy',
      'UI/UX strategy',
      'Data strategy',
      'Implementation strategy',
      'Execution order',
      'Detailed tasks',
      'Component responsibilities',
      'Interaction requirements',
      'Responsive requirements',
      'Error, loading and empty states',
      'Security considerations',
      'Performance considerations',
      'Testing strategy',
      'Verification checklist',
      'Risks',
      'Rollback and recovery',
      'Completion criteria',
      'Next phase prediction'
    ]
    let at = -1
    for (const h of headings) {
      const found = out.indexOf(`## ${h}\n`)
      expect(found, `missing section: ${h}`).toBeGreaterThan(at)
      at = found
    }
  })

  it('keeps a small change small — but never drops the safety sections', () => {
    const out = renderPhasePlan({
      ...base,
      complexity: 'simple',
      phase: { n: 1, name: 'Foundation', objective: 'Put the change in place.' },
      totalPhases: 3,
      tasks: [task('t1')]
    })
    expect(out).not.toContain('## Component responsibilities')
    expect(out).not.toContain('## Responsive requirements')
    expect(out).not.toContain('## Security considerations')
    expect(out).toContain('## Files that must NOT be modified')
    expect(out).toContain('## Verification checklist')
    expect(out).toContain('## Completion criteria')
    expect(out.length).toBeLessThan(renderPhasePlan(base).length)
  })

  it('names what belongs in a section the model skipped instead of dropping it', () => {
    const out = renderPhasePlan(base)
    expect(out).toContain('## Risks\n\n_To be determined — what could go wrong')
    expect(out).toContain('_To be determined — working code this phase must leave alone._')
  })

  it('uses the authored body when the model supplied one', () => {
    const out = renderPhasePlan({
      ...base,
      sections: {
        risks: '- The API contract may not be final yet.',
        protect: '- `src/db/schema.sql` — migrations are live.'
      }
    })
    expect(out).toContain('## Risks\n\n- The API contract may not be final yet.')
    expect(out).toContain('- `src/db/schema.sql` — migrations are live.')
    expect(out).not.toContain('_To be determined — what could go wrong')
  })

  it('derives the task list from the real graph, with unchecked boxes for the nudge', () => {
    const out = renderPhasePlan({
      ...base,
      tasks: [
        task('t1', { role: 'frontend', filesHint: ['src/pages/Home.tsx'] }),
        task('t2', { dependsOn: ['t1'] })
      ]
    })
    expect(out).toContain('- [ ] **t1** (Frontend Engineer) do t1 — files: src/pages/Home.tsx')
    expect(out).toContain('- [ ] **t2** (Builder) do t2 _(depends on: t1)_')
  })

  it('lays the execution order out in dependency waves', () => {
    const out = renderPhasePlan(base)
    const order = out.split('## Execution order\n\n')[1].split('\n\n')[0]
    expect(order).toBe('1. **t1** do t1; **t2** do t2 (in parallel)\n2. **t3** do t3')
  })

  it('collapses a single-task phase to one line', () => {
    const out = renderPhasePlan({ ...base, tasks: [task('t1')] })
    expect(out).toContain('## Execution order\n\n1. **t1** — do t1\n')
  })

  it('says so plainly when a phase has no tasks', () => {
    const out = renderPhasePlan({ ...base, tasks: [] })
    expect(out).toContain('## Execution order\n\n_No tasks in this phase._')
    expect(out).toContain('## Detailed tasks\n\n_No tasks in this phase._')
  })

  it('names the real verification commands in the checklist', () => {
    const out = renderPhasePlan({ ...base, verifyCommands: ['npm run typecheck', 'npm test'] })
    expect(out).toContain('2. `npm run typecheck` passes')
    expect(out).toContain('3. `npm test` passes')
    expect(out).toContain('The preview reflects the current code, not a previous build')
    expect(out).toContain('Layout holds at mobile, tablet and desktop widths')
    expect(out).toContain('This plan archived and the next phase planned')
  })

  it("falls back to naming the project's own checks when none were detected", () => {
    const out = renderPhasePlan(base)
    expect(out).toContain("2. The project's own checks pass (build, typecheck, lint, test")
  })

  it('leaves the responsive and a11y checks out of a small change', () => {
    const out = renderPhasePlan({ ...base, complexity: 'simple', tasks: [task('t1')] })
    expect(out).not.toContain('Layout holds at mobile')
    expect(out).not.toContain('Keyboard and screen-reader paths work')
    expect(out).toContain('1. Every task above is complete')
  })

  // The engine's continue-nudge fires while plan.md holds any `- [ ]`, so only the
  // task list may carry boxes — a checklist box would nudge forever.
  it('gives the checklist no checkboxes, so only real tasks are unchecked work', () => {
    const out = renderPhasePlan({ ...base, tasks: [task('t1'), task('t2')] })
    expect(out.match(/^- \[ \]/gm)).toHaveLength(2)
  })

  it('falls back to the planner file hints for the file sections', () => {
    const out = renderPhasePlan({
      ...base,
      tasks: [task('t1', { filesHint: ['src/a.ts', 'src/b.ts'] }), task('t2', { filesHint: ['src/a.ts'] })]
    })
    const create = out.split('## Files to create\n\n')[1].split('\n##')[0]
    expect(create).toContain('From the task hints')
    expect(create).toContain('- `src/a.ts`')
    expect(create).toContain('- `src/b.ts`')
    // De-duplicated across tasks.
    expect(create.match(/src\/a\.ts/g)).toHaveLength(1)
  })

  it('quotes and clips a very long request', () => {
    const out = renderPhasePlan({ ...base, request: `${'spec '.repeat(400)}TAIL` })
    expect(out).toContain('> spec spec')
    expect(out).not.toContain('TAIL')
    expect(out).toContain('…')
  })

  it('blockquotes every line of a multi-line request', () => {
    const out = renderPhasePlan({ ...base, request: 'line one\nline two' })
    expect(out).toContain('> line one\n> line two')
  })

  it('ends with exactly one trailing newline and no triple blank lines', () => {
    const out = renderPhasePlan(base)
    expect(out.endsWith('\n')).toBe(true)
    expect(out.endsWith('\n\n')).toBe(false)
    expect(out).not.toMatch(/\n{3}/)
  })
})
