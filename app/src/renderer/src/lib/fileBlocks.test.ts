import { describe, expect, it } from 'vitest'
import {
  basename,
  parseFileBlocks,
  type FileSegment,
  type Segment,
  type ToolSegment
} from './fileBlocks'

/** Narrow to a file segment (throwing on mismatch) so assertions read cleanly. */
function fileAt(segments: Segment[], index: number): FileSegment {
  const seg = segments[index]
  if (seg.kind !== 'file') throw new Error(`segment ${index} is ${seg.kind}, not a file`)
  return seg
}

/** Narrow to a tool segment (throwing on mismatch). */
function toolAt(segments: Segment[], index: number): ToolSegment {
  const seg = segments[index]
  if (seg.kind !== 'tool') throw new Error(`segment ${index} is ${seg.kind}, not a tool`)
  return seg
}

/**
 * The parser's whole job is to separate genuine "here is a file to save" blocks
 * from everything else, without disturbing everything else. So the cases that
 * matter are the boundaries: a path-tagged block becomes a card, a bare snippet
 * stays prose, and a block still streaming in is flagged incomplete so the card
 * can show it being written rather than waiting for the close.
 */
describe('parseFileBlocks', () => {
  it('leaves a reply with no fences as a single prose segment (today’s behaviour)', () => {
    const segments = parseFileBlocks('Just a plain answer.\n\nWith two paragraphs.')
    expect(segments).toHaveLength(1)
    expect(segments[0]).toEqual({ kind: 'prose', text: 'Just a plain answer.\n\nWith two paragraphs.' })
  })

  it('pulls a path-tagged block out as a file, keeping the prose around it', () => {
    const md = 'Here is the file:\n\n```python app.py\nprint("hi")\n```\n\nDone.'
    const segments = parseFileBlocks(md)

    expect(segments.map((s) => s.kind)).toEqual(['prose', 'file', 'prose'])
    expect(fileAt(segments, 1)).toEqual({
      kind: 'file',
      lang: 'python',
      path: 'app.py',
      code: 'print("hi")',
      complete: true
    })
    // The prose on either side survives so Markdown still renders it.
    expect((segments[0] as { text: string }).text).toContain('Here is the file:')
    expect((segments[2] as { text: string }).text).toContain('Done.')
  })

  it('keeps folder structure in the path', () => {
    const md = '```html templates/index.html\n<h1>Hi</h1>\n```'
    const file = fileAt(parseFileBlocks(md), 0)
    expect(file.path).toBe('templates/index.html')
    expect(file.lang).toBe('html')
    expect(file.code).toBe('<h1>Hi</h1>')
  })

  it('accepts a bare path with no language and leaves lang empty for inference', () => {
    const file = fileAt(parseFileBlocks('```app.py\nx = 1\n```'), 0)
    expect(file.lang).toBe('')
    expect(file.path).toBe('app.py')
  })

  it('leaves a plain language-only code block inside the prose, uncarded', () => {
    const md = 'Run this:\n\n```bash\nnpm install\n```'
    const segments = parseFileBlocks(md)
    // No file segment: the whole thing stays a single prose run for Markdown.
    expect(segments).toHaveLength(1)
    expect(segments[0].kind).toBe('prose')
    expect((segments[0] as { text: string }).text).toContain('```bash')
    expect((segments[0] as { text: string }).text).toContain('npm install')
  })

  it('separates several files, with prose between them', () => {
    const md = [
      'Two files:',
      '',
      '```python app.py',
      'print(1)',
      '```',
      '',
      'And the template:',
      '',
      '```html index.html',
      '<h1>Hi</h1>',
      '```'
    ].join('\n')
    const segments = parseFileBlocks(md)

    expect(segments.map((s) => s.kind)).toEqual(['prose', 'file', 'prose', 'file'])
    expect(fileAt(segments, 1).path).toBe('app.py')
    expect(fileAt(segments, 3).path).toBe('index.html')
    expect(fileAt(segments, 1).complete).toBe(true)
    expect(fileAt(segments, 3).complete).toBe(true)
  })

  it('flags a still-streaming block (no closing fence yet) as incomplete', () => {
    // Mid-stream the closing ``` has not arrived; the card shows "Writing…".
    const file = fileAt(parseFileBlocks('```python app.py\nprint(1)'), 0)
    expect(file.complete).toBe(false)
    expect(file.code).toBe('print(1)')
    expect(file.path).toBe('app.py')
  })

  it('does not mistake a code block whose info line is only a language for a file', () => {
    for (const lang of ['js', 'python', 'typescript', 'jsx', 'tsx', 'sh']) {
      const segments = parseFileBlocks('```' + lang + '\ncode\n```')
      expect(segments.every((s) => s.kind === 'prose'), lang).toBe(true)
    }
  })

  it('treats extensionless well-known filenames as files', () => {
    const file = fileAt(parseFileBlocks('```docker Dockerfile\nFROM node\n```'), 0)
    expect(file.path).toBe('Dockerfile')
  })

  it('treats a dotfile as a file even without an extension', () => {
    const file = fileAt(parseFileBlocks('```.gitignore\nnode_modules\n```'), 0)
    expect(file.path).toBe('.gitignore')
  })

  it('preserves an empty file body as an empty string, not a crash', () => {
    const file = fileAt(parseFileBlocks('```txt notes.txt\n```'), 0)
    expect(file.code).toBe('')
    expect(file.complete).toBe(true)
  })
})

/**
 * Tool use rides the reply as two adjacent fenced blocks — a `sylor:tool` call and
 * a `sylor:tool_result <name>` result (written by main/tools). The parser coalesces
 * them into a single card, shows a call still waiting on its result as "running",
 * and must not disturb the file/prose parsing around it.
 */
describe('parseFileBlocks — tool segments', () => {
  it('coalesces a call and its result into one tool segment', () => {
    const md = [
      'Let me search.',
      '',
      '```sylor:tool',
      '{"tool": "web_search", "input": {"query": "webgpu 2026"}}',
      '```',
      '',
      '```sylor:tool_result web_search',
      '1. WebGPU is widely supported',
      '```',
      '',
      'WebGPU is supported.'
    ].join('\n')
    const segments = parseFileBlocks(md)

    expect(segments.map((s) => s.kind)).toEqual(['prose', 'tool', 'prose'])
    const tool = toolAt(segments, 1)
    expect(tool.name).toBe('web_search')
    expect(tool.input).toEqual({ query: 'webgpu 2026' })
    expect(tool.result).toBe('1. WebGPU is widely supported')
    expect(tool.complete).toBe(true)
  })

  it('shows a call whose result has not arrived as running (result null, complete)', () => {
    const md = '```sylor:tool\n{"tool": "web_fetch", "input": {"url": "https://x.com"}}\n```'
    const tool = toolAt(parseFileBlocks(md), 0)
    expect(tool.name).toBe('web_fetch')
    expect(tool.result).toBeNull()
    expect(tool.complete).toBe(true) // call block closed; the tool is now running
  })

  it('flags a still-streaming call block (no closing fence) as incomplete', () => {
    const tool = toolAt(parseFileBlocks('```sylor:tool\n{"tool": "web_search"'), 0)
    expect(tool.result).toBeNull()
    expect(tool.complete).toBe(false)
  })

  it('tolerates a malformed call body, keeping the raw text as input', () => {
    const tool = toolAt(parseFileBlocks('```sylor:tool\n{not json}\n```'), 0)
    expect(tool.name).toBeNull()
    expect(tool.input).toBe('{not json}')
  })

  it('does not disturb file or prose parsing around a tool block', () => {
    const md = [
      'Here:',
      '',
      '```python app.py',
      'print(1)',
      '```',
      '',
      '```sylor:tool',
      '{"tool": "web_search", "input": {}}',
      '```',
      '',
      '```sylor:tool_result web_search',
      'ok',
      '```'
    ].join('\n')
    const segments = parseFileBlocks(md)

    expect(segments.map((s) => s.kind)).toEqual(['prose', 'file', 'tool'])
    expect(fileAt(segments, 1).path).toBe('app.py')
    expect(toolAt(segments, 2).result).toBe('ok')
  })

  it('survives a result block that itself contains a fenced code block', () => {
    // main/tools widens the result fence past any inner backtick run, so an inner
    // ``` never closes the block early.
    const md = [
      '````sylor:tool_result web_fetch',
      'Example:',
      '```js',
      'console.log(1)',
      '```',
      '````'
    ].join('\n')
    const tool = toolAt(parseFileBlocks(md), 0)
    expect(tool.name).toBe('web_fetch')
    expect(tool.result).toContain('console.log(1)')
    expect(tool.complete).toBe(true)
  })
})

describe('basename', () => {
  it('returns the last path segment', () => {
    expect(basename('templates/index.html')).toBe('index.html')
    expect(basename('app.py')).toBe('app.py')
    expect(basename('a/b/c/deep.txt')).toBe('deep.txt')
  })

  it('handles Windows separators and trailing slashes', () => {
    expect(basename('static\\css\\style.css')).toBe('style.css')
    expect(basename('dir/')).toBe('dir')
  })
})
