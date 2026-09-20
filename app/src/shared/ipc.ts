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

  // Cowork permission prompts: the renderer's answer to a mid-stream approval request.
  /** Renderer → main (send): answer an ApprovalRequest by id (allow / allow_always / deny). */
  ProvidersApprovalDecision: 'providers:approval-decision'
} as const

export type IpcChannel = (typeof IpcChannel)[keyof typeof IpcChannel]
