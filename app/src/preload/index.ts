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
    create: (projectId) => ipcRenderer.invoke(IpcChannel.SessionsCreate, projectId),
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
      ipcRenderer.send(IpcChannel.SessionsResetMessage, sessionId, id)
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
    pickWorkspace: () => ipcRenderer.invoke(IpcChannel.CoworkPickWorkspace)
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
  }
}

// With contextIsolation enabled, expose the API on the isolated `window.myto`.
if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('myto', api)
} else {
  // Fallback for the unlikely case isolation is disabled.
  ;(globalThis as unknown as { myto: MytoApi }).myto = api
}
