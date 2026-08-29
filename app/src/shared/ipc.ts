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

  // AI workflow engine (Phase 3)
  /** Renderer → main: start a workflow run (carries a client runId). */
  WorkflowStart: 'workflow:start',
  /** Renderer → main: cancel an in-flight run by runId. */
  WorkflowCancel: 'workflow:cancel',
  /** Main → renderer: a workflow event (intent/status/delta/tool/done/error). */
  WorkflowEvent: 'workflow:event',
  /** Renderer → main: resolve a pending tool-request (approve/reject). */
  WorkflowToolDecision: 'workflow:tool-decision',

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
  /** Renderer → main (send): finalize a streamed assistant turn. */
  SessionsUpdateMessage: 'sessions:update-message',
  /** Renderer → main (send): set a message's local feedback + report flag. */
  SessionsSetFeedback: 'sessions:set-feedback',
  /** Renderer → main (send): reset an assistant message for Rewrite/regenerate. */
  SessionsResetMessage: 'sessions:reset-message',
  /** Renderer → main (send): append a completed tool operation. */
  SessionsAppendToolOp: 'sessions:append-tool-op',
  /** Renderer → main (send): append a raw terminal output chunk. */
  SessionsAppendTerminal: 'sessions:append-terminal',

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

  // Live preview (chat-first redesign)
  /** Renderer → main (invoke): boot/point the static file server; returns its URL. */
  PreviewStartStatic: 'preview:start-static',
  /** Renderer → main (invoke): spawn a dev server; returns the scraped localhost URL. */
  PreviewStartDev: 'preview:start-dev',
  /** Renderer → main (invoke): preview however this project actually renders (dev server or static). */
  PreviewStartAuto: 'preview:start-auto',
  /** Renderer → main (send): stop the preview (dev server + static server + watcher). */
  PreviewStop: 'preview:stop',
  /** Main → renderer (send): a preview lifecycle event (starting/ready/reload/stopped/error). */
  PreviewEvent: 'preview:event',

  // MCP client (extensibility)
  /** Renderer → main (invoke): current status of every configured MCP server. */
  McpListServers: 'mcp:list-servers',
  /** Renderer → main (invoke): all tools discovered across connected servers. */
  McpListTools: 'mcp:list-tools',
  /** Renderer → main (invoke): reload mcp.json + reconnect all servers; returns status. */
  McpReconnect: 'mcp:reconnect',
  /** Renderer → main (invoke): absolute paths of the global + project config files. */
  McpConfigPaths: 'mcp:config-paths',
  /** Renderer → main (invoke): enable/disable an MCP server by name; returns updated status. */
  McpSetEnabled: 'mcp:set-enabled',
  /** Renderer → main (invoke): clear all MCP overrides (restore recommended defaults); returns status. */
  McpRestoreDefaults: 'mcp:restore-defaults',
  /** Renderer → main (invoke): add/import a custom server into mcp.json, then reconnect. */
  McpAddServer: 'mcp:add-server',
  /** Renderer → main (invoke): remove a custom server's mcp.json entry, then reconnect. */
  McpRemoveServer: 'mcp:remove-server',

  // Skills (model-invoked capability folders; extensibility)
  /** Renderer → main (invoke): every discovered skill with its enabled flag. */
  SkillsList: 'skills:list',
  /** Renderer → main (invoke): re-scan disk for skills; returns the fresh list. */
  SkillsReload: 'skills:reload',
  /** Renderer → main (invoke): enable/disable a skill by name; returns updated list. */
  SkillsSetEnabled: 'skills:set-enabled',
  /** Renderer → main (invoke): clear all skill overrides (restore recommended defaults); returns list. */
  SkillsRestoreDefaults: 'skills:restore-defaults',
  /** Renderer → main (invoke): author a new SKILL.md on disk, then re-scan; returns list. */
  SkillsAdd: 'skills:add',
  /** Renderer → main (invoke): delete a disk skill's SKILL.md, then re-scan; returns list. */
  SkillsRemove: 'skills:remove',
  /** Renderer → main (invoke): absolute paths of the global + project skills dirs. */
  SkillsConfigPaths: 'skills:config-paths',

  // Commands (disk-authored slash-command templates; extensibility)
  /** Renderer → main (invoke): every discovered command (global + project). */
  CommandsList: 'commands:list',
  /** Renderer → main (invoke): re-scan disk for commands; returns the fresh list. */
  CommandsReload: 'commands:reload',
  /** Renderer → main (invoke): author a new command `.md` on disk, then re-scan. */
  CommandsAdd: 'commands:add',
  /** Renderer → main (invoke): delete a command's `.md`, then re-scan; returns list. */
  CommandsRemove: 'commands:remove',
  /** Renderer → main (invoke): absolute paths of the global + project commands dirs. */
  CommandsConfigPaths: 'commands:config-paths',

  // Plugins (git-installed bundles of skills / commands / connectors)
  /** Renderer → main (invoke): every installed plugin. */
  PluginsList: 'plugins:list',
  /** Renderer → main (invoke): clone + unpack a plugin's contents; returns the record. */
  PluginsInstall: 'plugins:install',
  /** Renderer → main (invoke): withdraw a plugin's contents + its record. */
  PluginsRemove: 'plugins:remove',

  // Workspace (folder-first Code mode; requirement A)
  /** Renderer → main (invoke): open the OS folder picker; retarget the agent root. */
  WorkspaceSelect: 'workspace:select',
  /** Renderer → main (invoke): current workspace root + whether it was chosen. */
  WorkspaceGet: 'workspace:get',
  /** Main → renderer (send): the workspace root changed (new WorkspaceInfo). */
  WorkspaceChanged: 'workspace:changed'
} as const

export type IpcChannel = (typeof IpcChannel)[keyof typeof IpcChannel]
