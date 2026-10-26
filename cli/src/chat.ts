/*
 * Chat mode — Myto's general-purpose assistant: a plain streaming conversation
 * with no tools and no workspace access. Deltas print live as they arrive, the
 * thinking stream (when the model emits one and it's switched on) rides under a
 * dim bullet, and Esc / Ctrl-C cancels the in-flight turn without leaving chat.
 */
import type { Provider } from '@app/main/providers/provider'
import type { ChatMessage } from '@app/shared/types'
import { setThinking, thinkingOn } from './loop'
import * as tui from './tui'
import * as input from './input'
import * as ui from './ui'
import { watchInterrupt } from './interrupt'

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const CHAT_SYSTEM =
  'You are Myto Chat, the general-purpose assistant of the Myto coding agent. ' +
  'You have no tools in this mode: answer from what you know, think step by step when it helps, ' +
  'and keep answers tight and well-formatted markdown. If a task clearly needs file access or ' +
  'shell commands, say so and suggest switching to Cowork mode.'

export interface ChatOptions {
  provider: Provider
  modelId: string
  isTty: boolean
}

/** One streamed chat turn. Returns the visible reply (empty when interrupted). */
export async function chatTurn(opts: ChatOptions, messages: ChatMessage[]): Promise<{ text: string; interrupted: boolean; error?: string }> {
  const controller = new AbortController()
  const paused = { value: false }
  const stopWatch = watchInterrupt(controller, paused, opts.isTty)
  const out = process.stdout
  let visible = ''
  let thinking = false

  try {
    await opts.provider.streamCompletion(
      opts.modelId,
      messages,
      (chunk) => {
        if (chunk.thinking) {
          // Live chain-of-thought, same contract as the cowork loop.
          if (!thinkingOn()) return
          if (!thinking) {
            out.write('\n' + tui.bullet('Thinking', '', 'think') + '\n  ')
            thinking = true
          }
          out.write(chunk.thinking)
          return
        }
        if (chunk.delta) {
          if (thinking) {
            out.write('\n')
            thinking = false
          }
          visible += chunk.delta
          out.write(chunk.delta)
        }
        if (chunk.done && chunk.error) out.write(ui.paint.red(`\n${chunk.error}\n`))
      },
      controller.signal
    )
    if (thinking) out.write('\n')
    return { text: visible, interrupted: false }
  } catch (err) {
    if (controller.signal.aborted) {
      out.write(ui.paint.amber('\n⏹  Interrupted\n'))
      return { text: visible, interrupted: true }
    }
    return { text: visible, interrupted: false, error: msg(err) }
  } finally {
    stopWatch()
  }
}

/**
 * A chat session: loops turns until the user asks out (/back, /menu, Ctrl-C on
 * an empty prompt). Each exchange stays in `messages` so follow-ups carry
 * context.
 */
export async function chatSession(opts: ChatOptions): Promise<void> {
  const out = process.stdout
  const p = ui.paint
  const messages: ChatMessage[] = [{ role: 'system', content: CHAT_SYSTEM }]

  out.write(
    p.dim(`  Chat — plain conversation, no tools. `) +
      p.gray('/back for the menu · /clear resets · Esc interrupts\n\n')
  )

  for (;;) {
    const raw = await input.readTask([], { hint: 'chat · /back for the menu · /clear resets' })
    if (raw === null) return // Ctrl-C / EOF leaves chat
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('/')) {
      const cmd = line.slice(1).split(/\s+/)[0] ?? ''
      if (cmd === 'back' || cmd === 'menu' || cmd === 'quit' || cmd === 'exit') return
      if (cmd === 'clear') {
        messages.length = 1
        out.write(p.green(`${ui.sym.check} chat cleared\n`))
        continue
      }
      if (cmd === 'help') {
        out.write(
          p.dim('  /back menu · /clear reset · Esc interrupts a reply · anything else is a message\n')
        )
        continue
      }
      out.write(p.red(`  unknown command /${cmd}`) + p.dim(' — /back leaves chat\n'))
      continue
    }

    messages.push({ role: 'user', content: line })
    out.write('\n')
    const r = await chatTurn(opts, messages)
    if (r.error) {
      out.write(p.red(`\n  chat failed: ${r.error}\n`))
      messages.pop() // don't keep the failed exchange in context
      continue
    }
    if (r.text.trim()) messages.push({ role: 'assistant', content: r.text })
    else if (r.interrupted) messages.pop()
    out.write('\n\n')
  }
}
