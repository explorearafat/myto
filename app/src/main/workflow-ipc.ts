import { ipcMain, type IpcMainEvent } from 'electron'
import { IpcChannel } from '../shared/ipc'
import type {
  ToolDecision,
  ToolDecisionDetail,
  WorkflowEvent,
  WorkflowRunRequest
} from '../shared/types'
import { publishAmbient } from './ambient'
import {
  cancelAgent,
  cancelWorkflow,
  resolveQuestion,
  resolveToolDecision,
  revokeStandingApproval,
  runWorkflow
} from './workflow/engine'

/**
 * Registers the workflow IPC handlers. A run is started fire-and-forget; its
 * events stream back to the originating renderer over {@link
 * IpcChannel.WorkflowEvent}, keyed by runId so the renderer can demux.
 *
 * Tool approvals flow the other way: the renderer resolves a pending
 * `tool-request` via {@link IpcChannel.WorkflowToolDecision}, unblocking the
 * engine mid-run. Clarifying-question answers unblock it the same way, over
 * {@link IpcChannel.WorkflowAnswer}.
 */
export function registerWorkflowIpc(): void {
  ipcMain.on(IpcChannel.WorkflowStart, (event: IpcMainEvent, request: WorkflowRunRequest) => {
    const sender = event.sender
    const emit = (payload: WorkflowEvent): void => {
      // Stamp the wall clock HERE and nowhere else: every event the renderer ever
      // sees passes through this one sink, so the run log gets real times and
      // durations without 16 emit sites having to remember. An event that already
      // carries `at` (a replayed/forwarded one) keeps its own time.
      const stamped: WorkflowEvent = payload.at != null ? payload : { ...payload, at: Date.now() }
      // The tray, the taskbar dot and the floating widget all read the run from
      // here — the same sink, so an ambient surface can never describe a different
      // turn than the chat does (see `ambient.ts`).
      publishAmbient(stamped)
      if (!sender.isDestroyed()) sender.send(IpcChannel.WorkflowEvent, stamped)
    }
    // The interactive terminal pane was removed; agent command output now surfaces
    // in the chat's tool-result cards, so there's nowhere to mirror live output.
    const onTerminal = (): void => {}
    // Fire-and-forget: runWorkflow never throws (it reports errors as events).
    void runWorkflow(request, emit, onTerminal)
  })

  ipcMain.on(IpcChannel.WorkflowCancel, (_event, runId: string) => {
    cancelWorkflow(runId)
  })

  // One lane, not the turn: stops that subagent and lets the rest of the run finish.
  ipcMain.on(IpcChannel.WorkflowCancelAgent, (_event, runId: string, agentId: string) => {
    cancelAgent(runId, agentId)
  })

  ipcMain.on(
    IpcChannel.WorkflowToolDecision,
    (_event, runId: string, toolId: string, decision: ToolDecision, detail?: ToolDecisionDetail) => {
      resolveToolDecision(runId, toolId, decision, detail)
    }
  )

  // Hands back an "Always" grant. The key is re-checked against the run's own set,
  // so a stale key from a finished run simply does nothing.
  ipcMain.on(IpcChannel.WorkflowRevokeApproval, (_event, runId: string, key: string) => {
    revokeStandingApproval(runId, key)
  })

  ipcMain.on(
    IpcChannel.WorkflowAnswer,
    (_event, runId: string, questionId: string, answer: string) => {
      resolveQuestion(runId, questionId, answer)
    }
  )
}
