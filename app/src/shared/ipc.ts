/**
 * IPC channel names shared across main, preload, and renderer.
 * Centralised so the three processes never drift on string literals.
 */
export const IpcChannel = {
  WindowMinimize: 'window:minimize',
  WindowToggleMaximize: 'window:toggle-maximize',
  WindowClose: 'window:close',
  WindowIsMaximized: 'window:is-maximized',
  WindowMaximizedChanged: 'window:maximized-changed',

  // Model providers (Phase 2)
  ProvidersGetSettings: 'providers:get-settings',
  ProvidersSaveSettings: 'providers:save-settings',
  ProvidersListModels: 'providers:list-models',
  ProvidersTestConnection: 'providers:test-connection',
  ProvidersGetCompletion: 'providers:get-completion',
  /** Renderer → main: begin a streaming completion (carries a client streamId). */
  ProvidersStreamStart: 'providers:stream-start',
  /** Renderer → main: cancel an in-flight stream by streamId. */
  ProvidersStreamCancel: 'providers:stream-cancel',
  /** Main → renderer: a chunk for an in-flight stream. */
  ProvidersStreamChunk: 'providers:stream-chunk',

  // Session persistence (Phase 5)
  /** Renderer → main (invoke): list sessions for the active project root. */
  SessionsList: 'sessions:list',
  /** Renderer → main (invoke): create a new session. */
  SessionsCreate: 'sessions:create',
  /** Renderer → main (invoke): load a session's full contents. */
  SessionsLoad: 'sessions:load',
  /** Renderer → main (invoke): rename a session. */
  SessionsRename: 'sessions:rename',
  /** Renderer → main (invoke): delete a session. */
  SessionsRemove: 'sessions:remove',
  /** Renderer → main (invoke): id of the most-recently-updated session. */
  SessionsMostRecent: 'sessions:most-recent',
  /** Renderer → main (invoke): search sessions by title + message content. */
  SessionsSearch: 'sessions:search',
  /** Renderer → main (send): append a chat message. */
  SessionsAppendMessage: 'sessions:append-message',
  /** Renderer → main (send): set a message's local feedback + report flag. */
  SessionsSetFeedback: 'sessions:set-feedback',
  /** Renderer → main (send): reset an assistant message for Rewrite/regenerate. */
  SessionsResetMessage: 'sessions:reset-message',
  /** Renderer → main (invoke): rewind a session's files + chat to a message (#1). */
  SessionsRewind: 'sessions:rewind',
  /** Renderer → main (invoke): the pre-change bytes for a file card's overwrite diff (#5). */
  SessionsSnapshotBefore: 'sessions:snapshot-before',
  /** Renderer → main (invoke): before/after text of a working-tree file, for the Files pane diff. */
  SessionsFileDiff: 'sessions:file-diff',

  // Projects (chat-first redesign)
  /** Renderer → main (invoke): list all projects with chat counts. */
  ProjectsList: 'projects:list',
  /** Renderer → main (invoke): create a project by name. */
  ProjectsCreate: 'projects:create',
  /** Renderer → main (invoke): rename a project. */
  ProjectsRename: 'projects:rename',
  /** Renderer → main (invoke): replace a project's instructions. */
  ProjectsSetInstructions: 'projects:set-instructions',
  /** Renderer → main (invoke): replace a project's long-term memory note. */
  ProjectsSetMemory: 'projects:set-memory',
  /** Renderer → main (invoke): delete a project (chats detach). */
  ProjectsRemove: 'projects:remove',
  /** Renderer → main (invoke): file/unfile a chat under a project. */
  ProjectsAssignSession: 'projects:assign-session',
  /** Renderer → main (invoke): list a project's knowledge documents. */
  ProjectsKnowledgeList: 'projects:knowledge-list',
  /** Renderer → main (invoke): add a knowledge document to a project. */
  ProjectsKnowledgeAdd: 'projects:knowledge-add',
  /** Renderer → main (invoke): remove a knowledge document. */
  ProjectsKnowledgeRemove: 'projects:knowledge-remove',

  // Attachments (chat-first redesign)
  /** Renderer → main (invoke): store a file's bytes + a pending row. */
  AttachmentsAdd: 'attachments:add',
  /** Renderer → main (invoke): bind pending attachments to a user message. */
  AttachmentsAttachToMessage: 'attachments:attach-to-message',
  /** Renderer → main (invoke): read an attachment's bytes as a data URL. */
  AttachmentsRead: 'attachments:read',
  /** Renderer → main (invoke): delete an attachment (disk file + row). */
  AttachmentsRemove: 'attachments:remove',

  // Browser-mediated Google sign-in: the renderer asks main to open the system browser
  // to the website, which relays the Google ID token back via a loopback listener.
  /** Renderer → main (invoke): run the browser sign-in; resolves the relayed token or a failure. */
  AuthSignInWithGoogle: 'auth:sign-in-google',

  // File download (file cards): save a single generated file to disk via native Save As.
  /** Renderer → main (invoke): open a Save As dialog and write a generated file. */
  FilesSave: 'files:save',

  // Cowork (agentic mode): pick the working folder the filesystem tools are scoped to.
  /** Renderer → main (invoke): open a folder picker; resolves the chosen path or null. */
  CoworkPickWorkspace: 'cowork:pick-workspace',
  /** Renderer → main (invoke): list workspace-relative paths matching an `@file` query. */
  CoworkListFiles: 'cowork:list-files',

  // Credential vault (per-site secrets): saved once in the workspace's git-ignored,
  // safeStorage-encrypted `.data/<site>/` and auto-injected (scoped by command program)
  // into terminal tools so Myto can push/deploy on the user's behalf. Values NEVER cross
  // this boundary toward the renderer — only masked metadata (site/label/var names/scopes).
  /** Renderer → main (invoke): list saved credentials as masked metadata (no values). */
  CredentialsList: 'credentials:list',
  /** Renderer → main (invoke): save (or replace) one site's credential; resolves masked metadata. */
  CredentialsSave: 'credentials:save',
  /** Renderer → main (invoke): delete one site's credential; resolves the remaining metadata. */
  CredentialsDelete: 'credentials:delete',

  // Myto browser setup: open a standalone, interactive browser window on the same
  // persistent profile the in-app browser tools drive, so the user can log into
  // Gmail / WhatsApp / Facebook / Telegram / etc. by hand once and have those logins
  // reused automatically when Myto later browses on their behalf.
  /** Renderer → main (invoke): open the "Setup Myto Browser" window; resolves when shown. */
  BrowserOpenSetup: 'browser:open-setup',

  // Cowork permission prompts: the renderer's answer to a mid-stream approval request.
  /** Renderer → main (send): answer an ApprovalRequest by id (allow / allow_always / deny). */
  ProvidersApprovalDecision: 'providers:approval-decision',
  /** Renderer → main (send): answer a QuestionRequest (the ask_user tool) by id. */
  ProvidersQuestionAnswer: 'providers:question-answer',

  // Myto's preview pane: open a preview target in the user's external browser.
  /** Renderer → main (send): open a preview URL (file:// or http(s)) in the default browser. */
  PreviewOpenExternal: 'preview:open-external',

  // Connectors (MCP servers): manage and probe the servers whose tools Myto can call.
  /** Renderer → main (invoke): current live status of every configured connector. */
  McpStatus: 'mcp:status',
  /** Renderer → main (invoke): (re)connect to all enabled connectors, then return statuses. */
  McpSync: 'mcp:sync',
  /** Renderer → main (invoke): probe one connector config without saving it; resolves ok/error + tool count. */
  McpTest: 'mcp:test',
  /** Main → renderer: connector statuses changed (a connect/disconnect settled). */
  McpStatusChanged: 'mcp:status-changed',

  // Voice: speech-to-text.
  /** Renderer → main (invoke): transcribe a recorded audio clip via the gateway's Whisper endpoint. */
  VoiceTranscribe: 'voice:transcribe',

  // Screenshot (#11): capture the primary display so the user can drop a screenshot into chat.
  /** Renderer → main (invoke): grab the primary screen; resolves a PNG data URL or null. */
  ScreenshotCapture: 'screenshot:capture',

  // Scheduled tasks (#12): durable prompts the main-process scheduler fires on a cron.
  /** Renderer → main (invoke): list every persisted scheduled task. */
  ScheduledTasksList: 'scheduled-tasks:list',
  /** Renderer → main (invoke): create a task (computes its next_run_at). */
  ScheduledTasksCreate: 'scheduled-tasks:create',
  /** Renderer → main (invoke): patch a task's fields (recomputes next_run_at). */
  ScheduledTasksUpdate: 'scheduled-tasks:update',
  /** Renderer → main (invoke): delete a task by id. */
  ScheduledTasksRemove: 'scheduled-tasks:remove',
  /** Renderer → main (invoke): fire a task immediately ("Run now"). */
  ScheduledTasksRunNow: 'scheduled-tasks:run-now',
  /** Main → renderer: a task came due (or Run now) — open a fresh run with its prompt. */
  ScheduledTaskFire: 'scheduled-tasks:fire',

  // Interactive terminal (#2): a real PTY (node-pty) per session, driven by an xterm.js
  // frontend. The PTY lives in main keyed by sessionId and survives frontend remounts
  // (tab switch, preview taking the shared slot); a rolling output buffer is replayed on
  // re-attach so scrollback is preserved without a second layout slot.
  /** Renderer → main (invoke): spawn (or re-attach to) the session's PTY; resolves the replay buffer. */
  TerminalSpawn: 'terminal:spawn',
  /** Renderer → main (send): write keystrokes / pasted text to the session's PTY. */
  TerminalWrite: 'terminal:write',
  /** Renderer → main (send): resize the session's PTY to cols×rows. */
  TerminalResize: 'terminal:resize',
  /** Renderer → main (send): kill the session's PTY (explicit user action / restart). */
  TerminalKill: 'terminal:kill',
  /** Main → renderer: a chunk of PTY output for a session. */
  TerminalData: 'terminal:data',
  /** Main → renderer: a session's PTY exited (carries the exit code). */
  TerminalExit: 'terminal:exit'
} as const

export type IpcChannel = (typeof IpcChannel)[keyof typeof IpcChannel]
