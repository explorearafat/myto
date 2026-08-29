import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannel } from '../shared/ipc'
import type { CompletionChunk, PreviewEvent, SylorApi, WorkflowEvent, WorkspaceInfo } from '../shared/types'

/** Monotonic counter used to correlate streaming chunks with their request. */
let streamCounter = 0

const api: SylorApi = {
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
    }
  },
  workflow: {
    run: (request, onEvent) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: WorkflowEvent): void => {
        // Demux events for this run only (the channel is shared across runs).
        if (payload.runId === request.runId) onEvent(payload)
      }
      ipcRenderer.on(IpcChannel.WorkflowEvent, listener)
      ipcRenderer.send(IpcChannel.WorkflowStart, request)

      // Disposer: cancel the run in the main process and detach the listener.
      return () => {
        ipcRenderer.send(IpcChannel.WorkflowCancel, request.runId)
        ipcRenderer.removeListener(IpcChannel.WorkflowEvent, listener)
      }
    },
    toolDecision: (runId, toolId, decision) => {
      ipcRenderer.send(IpcChannel.WorkflowToolDecision, runId, toolId, decision)
    }
  },
  sessions: {
    list: (projectId) => ipcRenderer.invoke(IpcChannel.SessionsList, projectId),
    create: (projectId) => ipcRenderer.invoke(IpcChannel.SessionsCreate, projectId),
    load: (id) => ipcRenderer.invoke(IpcChannel.SessionsLoad, id),
    rename: (id, title) => ipcRenderer.invoke(IpcChannel.SessionsRename, id, title),
    remove: (id) => ipcRenderer.invoke(IpcChannel.SessionsRemove, id),
    mostRecent: () => ipcRenderer.invoke(IpcChannel.SessionsMostRecent),
    search: (query, projectId) => ipcRenderer.invoke(IpcChannel.SessionsSearch, query, projectId),
    // Fire-and-forget appends (no round-trip, so the live chat/terminal never block).
    appendMessage: (sessionId, msg) =>
      ipcRenderer.send(IpcChannel.SessionsAppendMessage, sessionId, msg),
    updateMessage: (sessionId, id, content, error) =>
      ipcRenderer.send(IpcChannel.SessionsUpdateMessage, sessionId, id, content, error),
    setFeedback: (sessionId, id, feedback, flagged) =>
      ipcRenderer.send(IpcChannel.SessionsSetFeedback, sessionId, id, feedback, flagged),
    resetMessage: (sessionId, id) =>
      ipcRenderer.send(IpcChannel.SessionsResetMessage, sessionId, id),
    appendToolOp: (sessionId, op) =>
      ipcRenderer.send(IpcChannel.SessionsAppendToolOp, sessionId, op),
    appendTerminal: (sessionId, data) =>
      ipcRenderer.send(IpcChannel.SessionsAppendTerminal, sessionId, data)
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
  preview: {
    startStatic: (entry) => ipcRenderer.invoke(IpcChannel.PreviewStartStatic, entry),
    startDev: (command) => ipcRenderer.invoke(IpcChannel.PreviewStartDev, command),
    startAuto: (entry) => ipcRenderer.invoke(IpcChannel.PreviewStartAuto, entry),
    stop: () => ipcRenderer.send(IpcChannel.PreviewStop),
    onEvent: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: PreviewEvent): void =>
        callback(payload)
      ipcRenderer.on(IpcChannel.PreviewEvent, listener)
      return () => {
        ipcRenderer.removeListener(IpcChannel.PreviewEvent, listener)
      }
    }
  },
  mcp: {
    listServers: () => ipcRenderer.invoke(IpcChannel.McpListServers),
    listTools: () => ipcRenderer.invoke(IpcChannel.McpListTools),
    reconnect: () => ipcRenderer.invoke(IpcChannel.McpReconnect),
    setEnabled: (name, enabled) => ipcRenderer.invoke(IpcChannel.McpSetEnabled, name, enabled),
    restoreDefaults: () => ipcRenderer.invoke(IpcChannel.McpRestoreDefaults),
    addServer: (input) => ipcRenderer.invoke(IpcChannel.McpAddServer, input),
    removeServer: (name) => ipcRenderer.invoke(IpcChannel.McpRemoveServer, name),
    configPaths: () => ipcRenderer.invoke(IpcChannel.McpConfigPaths)
  },
  skills: {
    list: () => ipcRenderer.invoke(IpcChannel.SkillsList),
    reload: () => ipcRenderer.invoke(IpcChannel.SkillsReload),
    setEnabled: (name, enabled) =>
      ipcRenderer.invoke(IpcChannel.SkillsSetEnabled, name, enabled),
    restoreDefaults: () => ipcRenderer.invoke(IpcChannel.SkillsRestoreDefaults),
    add: (input) => ipcRenderer.invoke(IpcChannel.SkillsAdd, input),
    remove: (name) => ipcRenderer.invoke(IpcChannel.SkillsRemove, name),
    configPaths: () => ipcRenderer.invoke(IpcChannel.SkillsConfigPaths)
  },
  commands: {
    list: () => ipcRenderer.invoke(IpcChannel.CommandsList),
    reload: () => ipcRenderer.invoke(IpcChannel.CommandsReload),
    add: (input) => ipcRenderer.invoke(IpcChannel.CommandsAdd, input),
    remove: (name) => ipcRenderer.invoke(IpcChannel.CommandsRemove, name),
    configPaths: () => ipcRenderer.invoke(IpcChannel.CommandsConfigPaths)
  },
  plugins: {
    list: () => ipcRenderer.invoke(IpcChannel.PluginsList),
    install: (input) => ipcRenderer.invoke(IpcChannel.PluginsInstall, input),
    remove: (name) => ipcRenderer.invoke(IpcChannel.PluginsRemove, name)
  },
  workspace: {
    select: () => ipcRenderer.invoke(IpcChannel.WorkspaceSelect),
    get: () => ipcRenderer.invoke(IpcChannel.WorkspaceGet),
    onChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, info: WorkspaceInfo): void =>
        callback(info)
      ipcRenderer.on(IpcChannel.WorkspaceChanged, listener)
      return () => {
        ipcRenderer.removeListener(IpcChannel.WorkspaceChanged, listener)
      }
    }
  }
}

// With contextIsolation enabled, expose the API on the isolated `window.sylor`.
if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('sylor', api)
} else {
  // Fallback for the unlikely case isolation is disabled.
  ;(globalThis as unknown as { sylor: SylorApi }).sylor = api
}
