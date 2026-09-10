import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannel } from '../shared/ipc'
import type {
  AmbientStatus,
  BrowserViewStatus,
  ChromeStatus,
  CompletionChunk,
  PreviewEvent,
  PreviewInspectRequest,
  ScheduledTask,
  SylorApi,
  WorkflowEvent,
  WorkspaceInfo
} from '../shared/types'

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
    toolDecision: (runId, toolId, decision, detail) => {
      ipcRenderer.send(IpcChannel.WorkflowToolDecision, runId, toolId, decision, detail)
    },
    cancelAgent: (runId, agentId) => {
      ipcRenderer.send(IpcChannel.WorkflowCancelAgent, runId, agentId)
    },
    revokeApproval: (runId, key) => {
      ipcRenderer.send(IpcChannel.WorkflowRevokeApproval, runId, key)
    },
    answerQuestion: (runId, questionId, answer) => {
      ipcRenderer.send(IpcChannel.WorkflowAnswer, runId, questionId, answer)
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
      ipcRenderer.send(IpcChannel.SessionsAppendTerminal, sessionId, data),
    usageStats: () => ipcRenderer.invoke(IpcChannel.SessionsUsageStats)
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
    },
    onInspectRequest: (callback) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: PreviewInspectRequest
      ): void => callback(payload)
      ipcRenderer.on(IpcChannel.PreviewInspectRequest, listener)
      return () => {
        ipcRenderer.removeListener(IpcChannel.PreviewInspectRequest, listener)
      }
    },
    respondInspect: (response) => ipcRenderer.send(IpcChannel.PreviewInspectResult, response)
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
    setRoot: (dir) => ipcRenderer.invoke(IpcChannel.WorkspaceSetRoot, dir),
    get: () => ipcRenderer.invoke(IpcChannel.WorkspaceGet),
    onChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, info: WorkspaceInfo): void =>
        callback(info)
      ipcRenderer.on(IpcChannel.WorkspaceChanged, listener)
      return () => {
        ipcRenderer.removeListener(IpcChannel.WorkspaceChanged, listener)
      }
    }
  },
  memory: {
    get: () => ipcRenderer.invoke(IpcChannel.MemoryGet),
    remember: (note) => ipcRenderer.invoke(IpcChannel.MemoryRemember, note)
  },
  auth: {
    signInWithGoogle: () => ipcRenderer.invoke(IpcChannel.AuthSignInWithGoogle)
  },
  checkpoints: {
    list: () => ipcRenderer.invoke(IpcChannel.CheckpointsList),
    restore: (id) => ipcRenderer.invoke(IpcChannel.CheckpointsRestore, id)
  },
  graph: {
    build: (req) => ipcRenderer.invoke(IpcChannel.GraphBuild, req)
  },
  chrome: {
    status: () => ipcRenderer.invoke(IpcChannel.ChromeGetStatus),
    open: (url) => ipcRenderer.invoke(IpcChannel.ChromeOpen, url),
    close: () => ipcRenderer.invoke(IpcChannel.ChromeClose),
    navigate: (url) => ipcRenderer.invoke(IpcChannel.ChromeNavigate, url),
    evaluate: (expression) => ipcRenderer.invoke(IpcChannel.ChromeEvaluate, expression),
    screenshot: () => ipcRenderer.invoke(IpcChannel.ChromeScreenshot),
    reload: (ignoreCache) => ipcRenderer.invoke(IpcChannel.ChromeReload, ignoreCache),
    stop: () => ipcRenderer.invoke(IpcChannel.ChromeStop),
    go: (delta) => ipcRenderer.invoke(IpcChannel.ChromeGo, delta),
    focus: () => ipcRenderer.invoke(IpcChannel.ChromeFocus),
    signIn: (url) => ipcRenderer.invoke(IpcChannel.ChromeSignIn, url),
    finishSignIn: () => ipcRenderer.invoke(IpcChannel.ChromeFinishSignIn),
    onStatus: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, status: ChromeStatus): void =>
        callback(status)
      ipcRenderer.on(IpcChannel.ChromeStatusChanged, listener)
      return () => {
        ipcRenderer.removeListener(IpcChannel.ChromeStatusChanged, listener)
      }
    }
  },
  browser: {
    status: () => ipcRenderer.invoke(IpcChannel.BrowserGetStatus),
    open: (url) => ipcRenderer.invoke(IpcChannel.BrowserOpen, url),
    setBounds: (bounds) => ipcRenderer.invoke(IpcChannel.BrowserSetBounds, bounds),
    setVisible: (visible) => ipcRenderer.invoke(IpcChannel.BrowserSetVisible, visible),
    close: () => ipcRenderer.invoke(IpcChannel.BrowserClose),
    reload: (ignoreCache) => ipcRenderer.invoke(IpcChannel.BrowserReload, ignoreCache),
    stop: () => ipcRenderer.invoke(IpcChannel.BrowserStop),
    go: (delta) => ipcRenderer.invoke(IpcChannel.BrowserGo, delta),
    setDriver: (driver) => ipcRenderer.invoke(IpcChannel.BrowserSetDriver, driver),
    onStatus: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, status: BrowserViewStatus): void =>
        callback(status)
      ipcRenderer.on(IpcChannel.BrowserStatusChanged, listener)
      return () => {
        ipcRenderer.removeListener(IpcChannel.BrowserStatusChanged, listener)
      }
    }
  },
  scheduler: {
    list: () => ipcRenderer.invoke(IpcChannel.SchedulerList),
    add: (input) => ipcRenderer.invoke(IpcChannel.SchedulerAdd, input),
    update: (id, input) => ipcRenderer.invoke(IpcChannel.SchedulerUpdate, id, input),
    setEnabled: (id, enabled) => ipcRenderer.invoke(IpcChannel.SchedulerSetEnabled, id, enabled),
    remove: (id) => ipcRenderer.invoke(IpcChannel.SchedulerRemove, id),
    onTaskFired: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, task: ScheduledTask): void =>
        callback(task)
      ipcRenderer.on(IpcChannel.SchedulerTaskFired, listener)
      return () => {
        ipcRenderer.removeListener(IpcChannel.SchedulerTaskFired, listener)
      }
    }
  },
  // Two audiences, deliberately split (see `main/ambient-ipc.ts`): the mini widget
  // reads `get`/`onStatus` and asks `focus`/`stop`; the main window only listens on
  // `onFocusLane`/`onStopRequest`. Nothing out at the edges cancels a run itself —
  // the chat window owns the live runId, so a stop arrives here as an intent.
  ambient: {
    get: () => ipcRenderer.invoke(IpcChannel.AmbientGet),
    onStatus: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, status: AmbientStatus): void =>
        callback(status)
      ipcRenderer.on(IpcChannel.AmbientStatusChanged, listener)
      return () => {
        ipcRenderer.removeListener(IpcChannel.AmbientStatusChanged, listener)
      }
    },
    focus: (lane) => ipcRenderer.send(IpcChannel.AmbientFocus, lane ?? null),
    onFocusLane: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, lane: string | null): void =>
        callback(lane)
      ipcRenderer.on(IpcChannel.AmbientFocusLane, listener)
      return () => {
        ipcRenderer.removeListener(IpcChannel.AmbientFocusLane, listener)
      }
    },
    stop: () => ipcRenderer.send(IpcChannel.AmbientStop),
    onStopRequest: (callback) => {
      const listener = (): void => callback()
      ipcRenderer.on(IpcChannel.AmbientStopRun, listener)
      return () => {
        ipcRenderer.removeListener(IpcChannel.AmbientStopRun, listener)
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
