import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannel } from '../shared/ipc'
import type { CompletionChunk, MytoApi } from '../shared/types'

/** Monotonic counter used to correlate streaming chunks with their request. */
let streamCounter = 0

const api: MytoApi = {
  window: {
    minimize: () => ipcRenderer.send(IpcChannel.WindowMinimize),
    toggleMaximize: () => ipcRenderer.send(IpcChannel.WindowToggleMaximize),
    close: () => ipcRenderer.send(IpcChannel.WindowClose),
    isMaximized: () => ipcRenderer.invoke(IpcChannel.WindowIsMaximized),
    onMaximizedChange: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, isMaximized: boolean) =>
        callback(isMaximized)
      ipcRenderer.on(IpcChannel.WindowMaximizedChanged, listener)
      return () => {
        ipcRenderer.removeListener(IpcChannel.WindowMaximizedChanged, listener)
      }
    }
  },
  platform: process.platform,
  // OS account name, used only to greet the user on the zero-state dashboard.
  userName: process.env.USERNAME || process.env.USER || '',
  providers: {
    getSettings: () => ipcRenderer.invoke(IpcChannel.ProvidersGetSettings),
    saveSettings: (settings) => ipcRenderer.invoke(IpcChannel.ProvidersSaveSettings, settings),
    listModels: (kind, config) => ipcRenderer.invoke(IpcChannel.ProvidersListModels, kind, config),
    testConnection: (kind, config, modelId) =>
      ipcRenderer.invoke(IpcChannel.ProvidersTestConnection, kind, config, modelId),
    getCompletion: (request) => ipcRenderer.invoke(IpcChannel.ProvidersGetCompletion, request),
    streamCompletion: async (request, onChunk) => {
      const streamId = `stream-${++streamCounter}`
      const listener = (_event: Electron.IpcRendererEvent, chunk: CompletionChunk) => {
        // Ignore chunks from other in-flight streams sharing this channel.
        if (chunk.streamId === streamId) onChunk(chunk)
      }
      ipcRenderer.on(IpcChannel.ProvidersStreamChunk, listener)

      const cleanup = (): void => {
        ipcRenderer.removeListener(IpcChannel.ProvidersStreamChunk, listener)
      }

      // Kick off the stream in the main process (fire-and-forget; chunks arrive via events).
      void ipcRenderer.invoke(IpcChannel.ProvidersStreamStart, streamId, request).finally(cleanup)

      // Disposer: cancel the main-process stream and detach the listener.
      return () => {
        ipcRenderer.send(IpcChannel.ProvidersStreamCancel, streamId)
        cleanup()
      }
    },
    decideApproval: (approvalId, decision) =>
      ipcRenderer.send(IpcChannel.ProvidersApprovalDecision, approvalId, decision),
    answerQuestions: (questionId, answers) =>
      ipcRenderer.send(IpcChannel.ProvidersQuestionAnswer, questionId, answers)
  },
  sessions: {
    list: (projectId) => ipcRenderer.invoke(IpcChannel.SessionsList, projectId),
    create: (projectId, mode) => ipcRenderer.invoke(IpcChannel.SessionsCreate, projectId, mode),
    load: (id) => ipcRenderer.invoke(IpcChannel.SessionsLoad, id),
    rename: (id, title) => ipcRenderer.invoke(IpcChannel.SessionsRename, id, title),
    remove: (id) => ipcRenderer.invoke(IpcChannel.SessionsRemove, id),
    mostRecent: () => ipcRenderer.invoke(IpcChannel.SessionsMostRecent),
    search: (query, projectId) => ipcRenderer.invoke(IpcChannel.SessionsSearch, query, projectId),
    // Fire-and-forget appends (no round-trip, so the live chat never blocks).
    appendMessage: (sessionId, msg) =>
      ipcRenderer.send(IpcChannel.SessionsAppendMessage, sessionId, msg),
    setFeedback: (sessionId, id, feedback, flagged) =>
      ipcRenderer.send(IpcChannel.SessionsSetFeedback, sessionId, id, feedback, flagged),
    resetMessage: (sessionId, id) =>
      ipcRenderer.send(IpcChannel.SessionsResetMessage, sessionId, id),
    rewind: (sessionId, afterMsgId) =>
      ipcRenderer.invoke(IpcChannel.SessionsRewind, sessionId, afterMsgId),
    snapshotBefore: (sessionId, after) =>
      ipcRenderer.invoke(IpcChannel.SessionsSnapshotBefore, sessionId, after)
  },
  projects: {
    list: () => ipcRenderer.invoke(IpcChannel.ProjectsList),
    create: (name) => ipcRenderer.invoke(IpcChannel.ProjectsCreate, name),
    rename: (id, name) => ipcRenderer.invoke(IpcChannel.ProjectsRename, id, name),
    setInstructions: (id, instructions) =>
      ipcRenderer.invoke(IpcChannel.ProjectsSetInstructions, id, instructions),
    setMemory: (id, memory) => ipcRenderer.invoke(IpcChannel.ProjectsSetMemory, id, memory),
    remove: (id) => ipcRenderer.invoke(IpcChannel.ProjectsRemove, id),
    assignSession: (sessionId, projectId) =>
      ipcRenderer.invoke(IpcChannel.ProjectsAssignSession, sessionId, projectId),
    listKnowledge: (projectId) => ipcRenderer.invoke(IpcChannel.ProjectsKnowledgeList, projectId),
    addKnowledge: (projectId, name, content) =>
      ipcRenderer.invoke(IpcChannel.ProjectsKnowledgeAdd, projectId, name, content),
    removeKnowledge: (id) => ipcRenderer.invoke(IpcChannel.ProjectsKnowledgeRemove, id)
  },
  attachments: {
    add: (input) => ipcRenderer.invoke(IpcChannel.AttachmentsAdd, input),
    attachToMessage: (ids, messageId) =>
      ipcRenderer.invoke(IpcChannel.AttachmentsAttachToMessage, ids, messageId),
    read: (id) => ipcRenderer.invoke(IpcChannel.AttachmentsRead, id),
    remove: (id) => ipcRenderer.invoke(IpcChannel.AttachmentsRemove, id)
  },
  auth: {
    signInWithGoogle: () => ipcRenderer.invoke(IpcChannel.AuthSignInWithGoogle)
  },
  files: {
    save: (name, content) => ipcRenderer.invoke(IpcChannel.FilesSave, name, content)
  },
  cowork: {
    pickWorkspace: () => ipcRenderer.invoke(IpcChannel.CoworkPickWorkspace),
    listFiles: (query: string) => ipcRenderer.invoke(IpcChannel.CoworkListFiles, query),
    openBrowserSetup: () => ipcRenderer.invoke(IpcChannel.BrowserOpenSetup)
  },
  preview: {
    openExternal: (url) => ipcRenderer.send(IpcChannel.PreviewOpenExternal, url)
  },
  mcp: {
    status: () => ipcRenderer.invoke(IpcChannel.McpStatus),
    sync: () => ipcRenderer.invoke(IpcChannel.McpSync),
    test: (config) => ipcRenderer.invoke(IpcChannel.McpTest, config),
    onStatusChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, statuses: Parameters<typeof callback>[0]) =>
        callback(statuses)
      ipcRenderer.on(IpcChannel.McpStatusChanged, listener)
      return () => {
        ipcRenderer.removeListener(IpcChannel.McpStatusChanged, listener)
      }
    }
  },
  voice: {
    transcribe: (input) => ipcRenderer.invoke(IpcChannel.VoiceTranscribe, input)
  },
  screenshot: {
    capture: () => ipcRenderer.invoke(IpcChannel.ScreenshotCapture)
  },
  scheduledTasks: {
    list: () => ipcRenderer.invoke(IpcChannel.ScheduledTasksList),
    create: (input) => ipcRenderer.invoke(IpcChannel.ScheduledTasksCreate, input),
    update: (id, input) => ipcRenderer.invoke(IpcChannel.ScheduledTasksUpdate, id, input),
    remove: (id) => ipcRenderer.invoke(IpcChannel.ScheduledTasksRemove, id),
    runNow: (id) => ipcRenderer.invoke(IpcChannel.ScheduledTasksRunNow, id),
    onFire: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, fire: Parameters<typeof callback>[0]) =>
        callback(fire)
      ipcRenderer.on(IpcChannel.ScheduledTaskFire, listener)
      return () => {
        ipcRenderer.removeListener(IpcChannel.ScheduledTaskFire, listener)
      }
    }
  },
  terminal: {
    spawn: (sessionId, cwd, cols, rows) =>
      ipcRenderer.invoke(IpcChannel.TerminalSpawn, sessionId, cwd, cols, rows),
    write: (sessionId, data) => ipcRenderer.send(IpcChannel.TerminalWrite, sessionId, data),
    resize: (sessionId, cols, rows) =>
      ipcRenderer.send(IpcChannel.TerminalResize, sessionId, cols, rows),
    kill: (sessionId) => ipcRenderer.send(IpcChannel.TerminalKill, sessionId),
    onData: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, evt: Parameters<typeof callback>[0]) =>
        callback(evt)
      ipcRenderer.on(IpcChannel.TerminalData, listener)
      return () => {
        ipcRenderer.removeListener(IpcChannel.TerminalData, listener)
      }
    },
    onExit: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, evt: Parameters<typeof callback>[0]) =>
        callback(evt)
      ipcRenderer.on(IpcChannel.TerminalExit, listener)
      return () => {
        ipcRenderer.removeListener(IpcChannel.TerminalExit, listener)
      }
    }
  }
}

// With contextIsolation enabled, expose the API on the isolated `window.myto`.
if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('myto', api)
} else {
  // Fallback for the unlikely case isolation is disabled.
  ;(globalThis as unknown as { myto: MytoApi }).myto = api
}
