import type { ScheduledTask } from '@shared/types'
import { useChatStore } from '../store/useChatStore'
import { useSessionStore } from '../store/useSessionStore'
import { useAppStore } from '../store/useAppStore'

/**
 * Renderer fire-path for scheduled tasks (Phase 4).
 *
 * When the main-process scheduler fires a task it broadcasts it here (via
 * `window.sylor.scheduler.onTaskFired`). This module turns that event into a
 * real run the same way a person would: it opens a *fresh* chat and sends the
 * task's prompt through the ordinary {@link useChatStore.send} path — so the run
 * still streams into a visible conversation and still pauses at sensitive tools
 * for approval. Nothing runs silently.
 *
 * Two safety rails:
 *  - **Idle-gated.** A fire waits until the visible chat is idle before opening a
 *    new one, so a scheduled task never yanks the user away from a live run.
 *  - **Serialized.** Fires are queued and drained one at a time (each waits for
 *    its run to finish), so two tasks due in the same tick can't clobber each
 *    other's chat.
 *
 * A task's optional `mode` is honored by briefly setting the app's work mode
 * around the synchronous `send()` call — `startRun` captures it immediately, so
 * the toggle never visibly flips and the change is never persisted.
 */

const queue: ScheduledTask[] = []
let draining = false

/** Resolve once the visible chat has no run in flight. */
function waitForIdle(): Promise<void> {
  if (!useChatStore.getState().running) return Promise.resolve()
  return new Promise((resolve) => {
    const unsub = useChatStore.subscribe((state) => {
      if (!state.running) {
        unsub()
        resolve()
      }
    })
  })
}

/** Open a fresh chat and run one task's prompt, honoring its work mode. */
async function runTask(task: ScheduledTask): Promise<void> {
  const prompt = task.prompt.trim()
  if (!prompt) return

  // A brand-new conversation for every fire (never appended to the open chat).
  await useSessionStore.getState().newDraft()
  await useSessionStore.getState().create()

  // Borrow the task's work mode just for the synchronous send: startRun reads it
  // immediately, so we can restore before React re-renders (no visible flip) and
  // without persisting (setState, not the persisting setWorkMode action).
  const prevMode = useAppStore.getState().workMode
  const desiredMode = task.mode ?? prevMode
  if (desiredMode !== prevMode) useAppStore.setState({ workMode: desiredMode })
  try {
    useChatStore.getState().send(prompt)
  } finally {
    if (desiredMode !== prevMode) useAppStore.setState({ workMode: prevMode })
  }

  // Title the fresh chat from the prompt (fire-and-forget), then wait for the run
  // to settle before draining the next queued task.
  void useSessionStore.getState().autoName(prompt)
  await waitForIdle()
}

/** Drain the queue one task at a time, each gated on the chat being idle first. */
async function drain(): Promise<void> {
  if (draining) return
  draining = true
  try {
    while (queue.length > 0) {
      await waitForIdle()
      const task = queue.shift()
      if (!task) break
      try {
        await runTask(task)
      } catch (err) {
        console.error('[sylor] scheduled task run failed:', err)
      }
    }
  } finally {
    draining = false
  }
}

/** Enqueue a fired task and kick the drainer (called from the onTaskFired listener). */
export function enqueueScheduledTask(task: ScheduledTask): void {
  queue.push(task)
  void drain()
}
