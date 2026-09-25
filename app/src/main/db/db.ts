import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * SQLite persistence backend (Phase 5), built on Node's built-in `node:sqlite`
 * (`DatabaseSync`). This is deliberately **electron-free**: the DB file path is
 * injected via {@link setDbPath} by the main process at startup rather than
 * derived from Electron's `app.getPath('userData')` here. That keeps this module
 * (and everything layered on it) unit-testable under Vitest, which runs on plain
 * Node where `require('electron')` yields a string path, not the `app` module.
 *
 * `node:sqlite` ships in Electron 43's bundled Node 24 with no experimental flag
 * and no native compilation — the reason it was chosen over better-sqlite3 given
 * the no-MSVC / OneDrive constraints of this machine.
 */

let dbPath: string | null = null
let db: DatabaseSync | null = null

/**
 * Set the on-disk DB file path. Called once by the main process before any
 * query. Changing the path closes any open handle so the next {@link getDb}
 * reopens against the new location (used by tests via {@link __setDbPathForTest}).
 */
export function setDbPath(path: string): void {
  if (path === dbPath) return
  closeDb()
  dbPath = path
}

/**
 * Test-only seam (mirrors `__setPtyBackendForTest`): point the layer at a temp
 * file or `:memory:` DB so suites never touch the real userData database.
 */
export function __setDbPathForTest(path: string): void {
  setDbPath(path)
}

/** Current schema version; bump + extend {@link migrate} for additive changes. */
export const SCHEMA_VERSION = 11

/**
 * Open the database once (lazily), applying pragmas and running migrations. All
 * later calls return the cached handle. Throws if no path was set — a wiring bug,
 * never expected at runtime.
 */
export function getDb(): DatabaseSync {
  if (db) return db
  if (!dbPath) throw new Error('DB path not set; call setDbPath() before getDb()')

  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })

  const handle = new DatabaseSync(dbPath)
  // Enforce cascade deletes and use WAL for durability under the app's crashy,
  // OneDrive-synced home. Both are per-connection pragmas set on every open.
  handle.exec('PRAGMA foreign_keys = ON')
  handle.exec('PRAGMA journal_mode = WAL')
  // Wait (up to 5s) for a lock instead of failing instantly with SQLITE_BUSY.
  // The app has no single-instance lock, so a second launch (or the WAL
  // checkpointer / OneDrive touching the file) can briefly hold the DB; without
  // this, a contended write throws and the fire-and-forget `safe()` wrapper in
  // the IPC layer swallows it — a silently dropped message/tool op. Retrying
  // under the timeout keeps those persistence writes reliable.
  handle.exec('PRAGMA busy_timeout = 5000')
  migrate(handle)
  db = handle
  return db
}

/** Close the handle if open (app shutdown, or a test path swap). */
export function closeDb(): void {
  if (db) {
    try {
      db.close()
    } catch {
      // Already closed.
    }
    db = null
  }
}

/**
 * Create tables on a fresh DB and record the schema version. Uses
 * `PRAGMA user_version` as the migration marker so future bumps are additive
 * (each version guarded by a `< N` check). Idempotent: a DB already at the
 * current version is left untouched.
 */
function migrate(handle: DatabaseSync): void {
  const row = handle.prepare('PRAGMA user_version').get() as { user_version: number } | undefined
  const current = row?.user_version ?? 0
  if (current >= SCHEMA_VERSION) return

  if (current < 1) {
    handle.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id           TEXT PRIMARY KEY,
        title        TEXT NOT NULL,
        project_root TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id         TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq        INTEGER NOT NULL,
        role       TEXT NOT NULL,
        content    TEXT NOT NULL,
        error      TEXT
      );

      CREATE TABLE IF NOT EXISTS tool_ops (
        id            TEXT PRIMARY KEY,
        session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq           INTEGER NOT NULL,
        after_msg_id  TEXT NOT NULL,
        run_id        TEXT NOT NULL,
        auto          INTEGER NOT NULL,
        decision      TEXT,
        proposal_json TEXT NOT NULL,
        result_json   TEXT
      );

      CREATE TABLE IF NOT EXISTS terminal_logs (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq        INTEGER NOT NULL,
        data       TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
      CREATE INDEX IF NOT EXISTS idx_tool_ops_session ON tool_ops(session_id, seq);
      CREATE INDEX IF NOT EXISTS idx_terminal_session ON terminal_logs(session_id, seq);
    `)
  }

  if (current < 2) {
    // Projects (chat-first redesign): a named grouping of chats with per-project
    // instructions + knowledge docs, plus a nullable `sessions.project_id` link.
    // Projects are global (not root-scoped); a session still belongs to a root
    // and may additionally be filed under a project. Created before the ALTER so
    // the new foreign-key column has a table to reference.
    handle.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        instructions TEXT NOT NULL DEFAULT '',
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_knowledge (
        id         TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        content    TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_knowledge_project ON project_knowledge(project_id, created_at);
    `)
    // Add the link column separately (ALTER TABLE takes one change at a time).
    // ON DELETE SET NULL detaches a project's chats rather than deleting them or
    // blocking the delete; a column added with a REFERENCES clause must default
    // to NULL, which it does (existing rows become unfiled).
    handle.exec(
      `ALTER TABLE sessions ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL`
    )
    handle.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id)`)
  }

  if (current < 3) {
    // Attachments (chat-first redesign): files the user drops into the composer.
    // Bytes live on disk under userData/attachments/<sessionId>/; only metadata is
    // stored here. session_id CASCADE cleans rows when a chat is deleted (the disk
    // files are removed by the IPC layer). message_id is a plain column (set on
    // send), deliberately NOT a foreign key: the user-message append is
    // fire-and-forget while the attach-to-message update is an invoke, so a FK
    // would risk a constraint failure if the update raced ahead of the append.
    // Messages are only ever deleted with their whole session, which the
    // session_id cascade already covers.
    handle.exec(`
      CREATE TABLE IF NOT EXISTS attachments (
        id         TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        message_id TEXT,
        name       TEXT NOT NULL,
        mime       TEXT NOT NULL,
        path       TEXT NOT NULL,
        size       INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_attachments_session ON attachments(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);
    `)
  }

  if (current < 4) {
    // Per-project long-term memory (power feature): one growing note per project
    // that the engine injects into every chat filed under it and that Myto
    // appends to via the `remember` tool. Distinct from `instructions` (user's
    // standing guidance) and `project_knowledge` (curated docs): memory is what
    // Myto learns over time. A single TEXT column keeps "one project = one
    // memory" literally true; existing rows default to empty.
    handle.exec(`ALTER TABLE projects ADD COLUMN memory TEXT NOT NULL DEFAULT ''`)
  }

  if (current < 5) {
    // Per-message feedback + report markers (Phase 5 message actions). These are
    // local-only annotations the user toggles from the chat (Like/Dislike =
    // `feedback`, Report = `flagged`); nothing is ever sent anywhere. Additive
    // columns: `feedback` is NULL until set ('like' | 'dislike'), `flagged`
    // defaults to 0 so every existing message upgrades with no data loss.
    handle.exec(`ALTER TABLE messages ADD COLUMN feedback TEXT`)
    handle.exec(`ALTER TABLE messages ADD COLUMN flagged INTEGER NOT NULL DEFAULT 0`)
  }

  if (current < 6) {
    // Per-card content offset (think → act → think interleaving). The character
    // offset into the anchor message's content at which a tool card was proposed,
    // so a reloaded chat renders prose and cards in the streamed order rather than
    // all prose then all cards. Additive + nullable: pre-existing ops default to
    // NULL and fall back to end-of-message ordering in the renderer.
    handle.exec(`ALTER TABLE tool_ops ADD COLUMN content_offset INTEGER`)
  }

  if (current < 7) {
    // Durable scheduled tasks (Phase 4). A stored prompt the scheduler enqueues on
    // a cron cadence. Only tasks the user marks *durable* land here; session-only
    // tasks live in memory and vanish on quit. This is a standalone table with no
    // foreign keys — a task isn't tied to any one session (it opens a fresh chat
    // each time it fires). `enabled`/`durable` are 0/1 ints; `mode` and the two
    // timestamps are nullable. Rows are keyed by the scheduler's own `sched-*` id.
    handle.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        prompt      TEXT NOT NULL,
        cron        TEXT NOT NULL,
        enabled     INTEGER NOT NULL DEFAULT 1,
        durable     INTEGER NOT NULL DEFAULT 1,
        mode        TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        last_run_at INTEGER,
        next_run_at INTEGER
      );
    `)
  }

  if (current < 8) {
    // Activity analytics (the zero-state dashboard). Two additive, nullable
    // columns on messages: `created_at` is the wall-clock time the turn was first
    // written (the table only had a per-session `seq`, which says nothing about
    // *when*), and `model` is the display label of the model that produced an
    // assistant turn. Both nullable so every pre-existing row upgrades untouched:
    // the stats layer dates undated messages from their session's created_at and
    // leaves model-less turns out of the favourite-model tally.
    handle.exec(`ALTER TABLE messages ADD COLUMN created_at INTEGER`)
    handle.exec(`ALTER TABLE messages ADD COLUMN model TEXT`)
  }

  if (current < 9) {
    // Run-log columns on tool_ops (harness overhaul, Pass A). `agent_id`/`agent_role`
    // were already declared on PersistedToolOp — and documented as the header label
    // "on reload" — but the INSERT dropped them, so reopening a conversation lost
    // which subagent did what. `started_at`/`ended_at` are the wall clock the op was
    // proposed and the ms its result landed, which is what lets a restored log show
    // real times and durations. All four nullable: pre-existing rows upgrade
    // untouched and the UI shows no attribution/time rather than inventing one.
    handle.exec(`ALTER TABLE tool_ops ADD COLUMN agent_id TEXT`)
    handle.exec(`ALTER TABLE tool_ops ADD COLUMN agent_role TEXT`)
    handle.exec(`ALTER TABLE tool_ops ADD COLUMN started_at INTEGER`)
    handle.exec(`ALTER TABLE tool_ops ADD COLUMN ended_at INTEGER`)
  }

  if (current < 10) {
    // Per-session chat mode (Chat vs Cowork). A session is fixed to one mode at
    // creation and never mixes the two, so opening it restores the right toolset
    // and the sidebar can tag each row. NOT NULL DEFAULT 'chat' upgrades every
    // pre-existing row to a plain chat — the mode they were all created in before
    // Cowork sessions were distinguished. (Unrelated to the `mode` column on
    // scheduled_tasks from v7.)
    handle.exec(`ALTER TABLE sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'chat'`)
  }

  if (current < 11) {
    // File snapshots (checkpoint / rewind, #1). Every mutation tool (write, edit,
    // delete) records the file's bytes BEFORE and AFTER the change, keyed by the
    // session + the user-message the run answers + the run id. Rewind replays these
    // in reverse from newest down to a chosen point, restoring `before_content`
    // (or deleting files whose `existed` was 0). `kind` distinguishes the op so a
    // rewind knows whether the pre-image is "no file" vs empty. Standalone-ish:
    // session_id CASCADE cleans rows when a chat is deleted; after_msg_id is a
    // plain column (like attachments.message_id — not an FK — since snapshots are
    // written fire-and-forget from the tool loop and must never block on a race
    // with the message append).
    handle.exec(`
      CREATE TABLE IF NOT EXISTS file_snapshots (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        after_msg_id   TEXT,
        run_id         TEXT NOT NULL,
        path           TEXT NOT NULL,
        before_content TEXT,
        after_content  TEXT,
        kind           TEXT NOT NULL,
        existed        INTEGER NOT NULL,
        created_at     INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_snapshots_session ON file_snapshots(session_id, id);
    `)
  }

  handle.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
}
