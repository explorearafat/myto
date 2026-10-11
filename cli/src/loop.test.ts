import { describe, expect, it } from 'vitest'
import { runAgentLoop, cliTools, cliSystemPrompt, cliSettings } from './loop'
import type { Provider } from '@app/main/providers/provider'
import type { ChatMessage, CompletionChunk } from '@app/shared/types'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A scripted fake provider: replays pre-recorded "generations" (arrays of
 * chunks) in order, so the loop is exercised end-to-end — parse, execute,
 * feed back — with no network and no real model.
 */
function fakeProvider(scripts: Array<Omit<CompletionChunk, 'streamId'>[]>): Provider {
  let i = 0
  return {
    async listModels() {
      return { ok: true, models: [] }
    },
    async testConnection() {
      return { ok: true, message: 'ok' }
    },
    async getCompletion() {
      return ''
    },
    async streamCompletion(_model, _messages, onChunk, _signal) {
      const script = scripts[Math.min(i++, scripts.length - 1)]
      for (const chunk of script) onChunk(chunk)
    }
  }
}

const toolCallChunk = (name: string, input: unknown): Omit<CompletionChunk, 'streamId'> => ({
  delta: `\n\`\`\`myto:tool\n${JSON.stringify({ tool: name, input })}\n\`\`\`\n`,
  done: false
})
const text = (t: string): Omit<CompletionChunk, 'streamId'> => ({ delta: t, done: false })
const DONE: Omit<CompletionChunk, 'streamId'> = { delta: '', done: true }

function tmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'myto-cli-test-'))
  return dir
}

describe('cli loop', () => {
  it('runs a scripted tool call and feeds the result back', async () => {
    const ws = tmpWorkspace()
    try {
      const provider = fakeProvider([
        [toolCallChunk('write_file', { path: 'hello.txt', content: 'hi from myto' }), DONE],
        [text('Wrote the file.'), DONE]
      ])
      const result = await runAgentLoop({
        provider,
        modelId: 'test-model',
        workspaceDir: ws,
        task: 'create hello.txt'
      })
      expect(existsSync(join(ws, 'hello.txt'))).toBe(true)
      expect(readFileSync(join(ws, 'hello.txt'), 'utf8')).toBe('hi from myto')
      expect(result.finalText).toContain('Wrote the file')
      expect(result.toolCalls).toBe(1)
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it('drains batched calls without re-generating (RC-7 behaviour)', async () => {
    const ws = tmpWorkspace()
    try {
      // One generation carrying TWO calls, then a final answer generation.
      const provider = fakeProvider([
        [toolCallChunk('write_file', { path: 'a.txt', content: 'A' }), toolCallChunk('write_file', { path: 'b.txt', content: 'B' }), DONE],
        [text('Both files are written.'), DONE]
      ])
      const result = await runAgentLoop({
        provider,
        modelId: 'test-model',
        workspaceDir: ws,
        task: 'create a.txt and b.txt'
      })
      expect(existsSync(join(ws, 'a.txt'))).toBe(true)
      expect(existsSync(join(ws, 'b.txt'))).toBe(true)
      expect(result.toolCalls).toBe(2)
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it('auto-persists narrated files the model printed as prose (RC-5 behaviour)', async () => {
    const ws = tmpWorkspace()
    try {
      const prose = [
        'Here is the app file:',
        '',
        '```javascript app.js',
        ...Array.from({ length: 12 }, (_, i) => `console.log(${i});`),
        '```',
        '',
        'That is the whole file.'
      ].join('\n')
      const provider = fakeProvider([
        [text(prose), DONE],
        [text('All done.'), DONE]
      ])
      const result = await runAgentLoop({
        provider,
        modelId: 'test-model',
        workspaceDir: ws,
        task: 'create app.js'
      })
      expect(existsSync(join(ws, 'app.js'))).toBe(true)
      expect(readFileSync(join(ws, 'app.js'), 'utf8')).toContain('console.log(0);')
      expect(result.finalText).toContain('All done')
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it('nudges on an empty reply instead of finishing (RC guard)', async () => {
    const ws = tmpWorkspace()
    try {
      const provider = fakeProvider([
        [text('   '), DONE],
        [text('Here is the real answer.'), DONE]
      ])
      const result = await runAgentLoop({
        provider,
        modelId: 'test-model',
        workspaceDir: ws,
        task: 'say something'
      })
      expect(result.finalText).toContain('real answer')
      expect(result.turns).toBeGreaterThanOrEqual(2)
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it('surfaces a provider error instead of hanging', async () => {
    const ws = tmpWorkspace()
    try {
      const provider = fakeProvider([[{ delta: '', done: true, error: 'HTTP 401 — bad key' }]])
      const result = await runAgentLoop({
        provider,
        modelId: 'test-model',
        workspaceDir: ws,
        task: 'anything'
      })
      expect(result.finalText).toContain('401')
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })
})

describe('cli tool catalogue + prompt', () => {
  it('advertises the fs, command, search, plan and think tools', () => {
    const settings = cliSettings({
      activeProvider: 'gateway',
      ollama: { baseUrl: 'http://localhost:11434' },
      gateway: { baseUrl: '', apiKey: '', authSchema: 'bearer', authHeaderName: 'Authorization' },
      modelId: 'm'
    })
    const gate = { settings, mode: 'cowork' as const, workspaceDir: '/tmp' }
    const names = cliTools().filter((t) => t.available(gate)).map((t) => t.name)
    for (const expected of ['list_dir', 'read_file', 'write_file', 'edit_file', 'delete_file', 'search_code', 'find_files', 'run_command', 'run_code', 'update_plan', 'think']) {
      expect(names).toContain(expected)
    }
  })

  it('the system prompt teaches the myto:tool protocol', () => {
    const settings = cliSettings({
      activeProvider: 'gateway',
      ollama: { baseUrl: 'http://localhost:11434' },
      gateway: { baseUrl: '', apiKey: '', authSchema: 'bearer', authHeaderName: 'Authorization' },
      modelId: 'm'
    })
    const gate = { settings, mode: 'cowork' as const, workspaceDir: '/tmp' }
    const prompt = cliSystemPrompt(gate, '/tmp/project')
    expect(prompt).toContain('```myto:tool')
    expect(prompt).toContain('write_file')
    expect(prompt).toContain('/tmp/project')
  })

  it('messages passed to the provider carry the system prompt and task (spy)', async () => {
    const ws = tmpWorkspace()
    try {
      const seen: ChatMessage[][] = []
      const provider: Provider = {
        async listModels() {
          return { ok: true, models: [] }
        },
        async testConnection() {
          return { ok: true, message: 'ok' }
        },
        async getCompletion() {
          return ''
        },
        async streamCompletion(_m, messages, onChunk) {
          seen.push(messages)
          onChunk({ delta: 'ok', done: false })
          onChunk(DONE)
        }
      }
      await runAgentLoop({ provider, modelId: 'm', workspaceDir: ws, task: 'do the thing' })
      expect(seen.length).toBeGreaterThan(0)
      expect(seen[0]?.[0]?.role).toBe('system')
      expect(seen[0]?.[0]?.content).toContain('myto:tool')
      expect(seen[0]?.[1]?.role).toBe('user')
      expect(seen[0]?.[1]?.content).toBe('do the thing')
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })
})

describe('cli tool result feedback', () => {
  it('write_file errors become readable tool results, not throws', async () => {
    const ws = tmpWorkspace()
    try {
      // The model tries to escape the sandbox; the refusal comes back as a result
      // the loop feeds back, and the run continues to the final answer.
      const provider = fakeProvider([
        [toolCallChunk('write_file', { path: '../escape.txt', content: 'x' }), DONE],
        [text('Understood — staying inside the folder.'), DONE]
      ])
      const result = await runAgentLoop({
        provider,
        modelId: 'test-model',
        workspaceDir: ws,
        task: 'try to escape'
      })
      expect(existsSync(join(ws, '..', 'escape.txt'))).toBe(false)
      expect(result.finalText).toContain('staying inside')
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })
})

// Re-exported for a direct writeFileSync usage check in the narration test above.
void writeFileSync
