import { describe, it, expect } from 'vitest'
import { stripAnsi } from './ui'
import { welcome, runHeader, summary, diffBlock, stepLine, box, twoColumn, vlen, bullet, todos, blockWordmark, suggestions, toolCall, toolResult } from './tui'

const plain = (s: string): string => stripAnsi(s)

describe('welcome frame', () => {
  it('greets, shows the setup lines and the numbered tips', () => {
    const out = plain(
      welcome(
        { version: '1.2.0', provider: 'OpenAI-compatible', providerUrl: 'https://api.x/v1', model: 'claude-sonnet-5', ready: true, workspace: '/w' },
        ['Explain this codebase', 'Build a dashboard']
      )
    )
    expect(out).toContain('Welcome to Myto!')
    expect(out).toContain('/status')
    expect(out).toContain('/w')
    expect(out).toContain('claude-sonnet-5')
    expect(out).toContain('Explain this codebase')
    expect(out).toContain('Tips for getting started')
  })
})

describe('runHeader frame', () => {
  it('echoes the task and the model without reprinting the folder', () => {
    const out = plain(runHeader({ version: '1.2.0', task: 'do a thing', model: 'gpt-4o', workspace: '/w', byok: true }))
    expect(out).toContain('do a thing')
    expect(out).toContain('gpt-4o')
    expect(out).toContain('BYOK')
    expect(out).not.toContain('/w')
  })
})

describe('summary frame', () => {
  it('reports files changed, counts and tests', () => {
    const out = plain(summary({ files: 2, add: 14, del: 3, turns: 6, tests: '18/18' }))
    expect(out).toContain('Done')
    expect(out).toContain('2')
    expect(out).toContain('+14')
    expect(out).toContain('18/18')
  })
})

describe('tool frames', () => {
  it('renders a call line with its target and meta', () => {
    const out = plain(toolCall('Write', 'src/app.ts', 'write', '+12 lines'))
    expect(out).toContain('Write')
    expect(out).toContain('src/app.ts')
    expect(out).toContain('+12 lines')
  })
  it('renders a result line with the ⎿ mark', () => {
    const out = plain(toolResult('wrote 12 lines', true))
    expect(out).toContain('⎿')
    expect(out).toContain('wrote 12 lines')
  })
})

describe('activity primitives', () => {
  it('block wordmark keeps the six ANSI-shadow rows', () => {
    expect(blockWordmark().length).toBe(6)
    expect(plain(blockWordmark()[0])).toContain('█')
  })
  it('bullet and todos render their markers', () => {
    expect(plain(bullet('Thinking', 'reasoning here', 'think'))).toContain('Thinking')
    const t = plain(todos([{ done: true, text: 'a' }, { done: false, text: 'b' }]))
    expect(t).toContain('TODOs')
    expect(t).toContain('☑')
    expect(t).toContain('☐')
  })
  it('suggestions numbers each tip', () => {
    const s = plain(suggestions(['one', 'two']))
    expect(s).toContain('1. one')
    expect(s).toContain('2. two')
  })
})

describe('diffBlock', () => {
  it('headers the file with +/- counts and renders rows', () => {
    const out = plain(diffBlock('a.ts', [{ n: 1, type: 'add', text: 'const x = 1' }, { n: 2, type: 'del', text: 'old' }]).join('\n'))
    expect(out).toContain('a.ts')
    expect(out).toContain('+1')
    expect(out).toContain('-1')
    expect(out).toContain('const x = 1')
  })
})

describe('layout primitives', () => {
  it('box pads every line to the exact width', () => {
    const lines = box({ lines: ['hi', 'longer line here'], width: 30 })
    for (const l of lines) expect(vlen(l)).toBe(30)
  })
  it('stepLine right-aligns the meta and keeps the label', () => {
    const out = plain(stepLine('done', 'Reading foo', '2s', 60))
    expect(out).toContain('Reading foo')
    expect(out).toContain('2s')
    expect(out.length).toBe(60)
  })
  it('twoColumn draws a divider between the panes', () => {
    const out = twoColumn(['left'], ['right'], 10).map(plain)
    expect(out[0]).toContain('│')
    expect(out[0]).toContain('left')
    expect(out[0]).toContain('right')
  })
})
