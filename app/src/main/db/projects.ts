import type { Project, ProjectKnowledge } from '../../shared/types'
import { getDb } from './db'

/**
 * Typed CRUD over the projects tables (chat-first redesign). Mirrors the shape
 * of {@link file://./sessions.ts sessions.ts}: the main process is the single
 * writer, ids are minted from an injected clock (test-friendly), and every
 * function throws only on genuine programmer error.
 *
 * Projects are global — not scoped to a filesystem root — so they can group
 * chats regardless of each chat's `project_root`. Deleting a project detaches
 * its chats (`sessions.project_id → NULL` via ON DELETE SET NULL) rather than
 * deleting them; its knowledge docs cascade away.
 */

let idCounter = 0

/** Generate a unique id with the given prefix. Time-free (now is passed in). */
function nextId(prefix: string, now: number): string {
  idCounter += 1
  return `${prefix}-${now}-${idCounter}`
}

/** Create a new project (empty instructions) and return its summary. */
export function createProject(name: string, now: number): Project {
  const id = nextId('proj', now)
  getDb()
    .prepare(
      `INSERT INTO projects (id, name, instructions, memory, created_at, updated_at)
       VALUES (?, ?, '', '', ?, ?)`
    )
    .run(id, name, now, now)
  return {
    id,
    name,
    instructions: '',
    memory: '',
    createdAt: now,
    updatedAt: now,
    sessionCount: 0
  }
}

/** All projects, newest-updated first, each with its current chat count. */
export function listProjects(): Project[] {
  const rows = getDb()
    .prepare(
      `SELECT p.id, p.name, p.instructions, p.memory, p.created_at, p.updated_at,
              (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id) AS session_count
       FROM projects p
       ORDER BY p.updated_at DESC`
    )
    .all() as Array<{
    id: string
    name: string
    instructions: string
    memory: string
    created_at: number
    updated_at: number
    session_count: number
  }>
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    instructions: r.instructions,
    memory: r.memory,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    sessionCount: r.session_count
  }))
}

/** Load a single project by id, or null if unknown. */
export function getProject(id: string): Project | null {
  const r = getDb()
    .prepare(
      `SELECT p.id, p.name, p.instructions, p.memory, p.created_at, p.updated_at,
              (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id) AS session_count
       FROM projects p WHERE p.id = ?`
    )
    .get(id) as
    | {
        id: string
        name: string
        instructions: string
        memory: string
        created_at: number
        updated_at: number
        session_count: number
      }
    | undefined
  if (!r) return null
  return {
    id: r.id,
    name: r.name,
    instructions: r.instructions,
    memory: r.memory,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    sessionCount: r.session_count
  }
}

/** Rename a project and bump its updated_at. */
export function renameProject(id: string, name: string, now: number): void {
  getDb()
    .prepare(`UPDATE projects SET name = ?, updated_at = ? WHERE id = ?`)
    .run(name, now, id)
}

/** Replace a project's custom instructions and bump its updated_at. */
export function setProjectInstructions(id: string, instructions: string, now: number): void {
  getDb()
    .prepare(`UPDATE projects SET instructions = ?, updated_at = ? WHERE id = ?`)
    .run(instructions, now, id)
}

/** Read a project's long-term memory note ('' when empty or unknown). */
export function getProjectMemory(id: string): string {
  const r = getDb().prepare(`SELECT memory FROM projects WHERE id = ?`).get(id) as
    | { memory: string }
    | undefined
  return r?.memory ?? ''
}

/** Replace a project's long-term memory note wholesale and bump updated_at. */
export function setProjectMemory(id: string, memory: string, now: number): void {
  getDb().prepare(`UPDATE projects SET memory = ?, updated_at = ? WHERE id = ?`).run(memory, now, id)
}

/**
 * Append a note to a project's long-term memory as a new bullet line, returning
 * the resulting memory text. No-op returning the current memory when `note` is
 * blank or the project is unknown. Kept append-only (never rewrites prior
 * memory) so what Myto has learned accumulates rather than being overwritten.
 */
export function appendProjectMemory(id: string, note: string, now: number): string {
  const trimmed = note.trim()
  const current = getProjectMemory(id)
  if (!trimmed) return current
  const line = `- ${trimmed.replace(/\s+/g, ' ')}`
  const next = current ? `${current}\n${line}` : line
  setProjectMemory(id, next, now)
  return next
}

/** Delete a project; knowledge cascades, chats detach (project_id → NULL). */
export function deleteProject(id: string): void {
  getDb().prepare(`DELETE FROM projects WHERE id = ?`).run(id)
}

/** List a project's knowledge documents, oldest first. */
export function listProjectKnowledge(projectId: string): ProjectKnowledge[] {
  const rows = getDb()
    .prepare(
      `SELECT id, project_id, name, content, created_at
       FROM project_knowledge WHERE project_id = ? ORDER BY created_at`
    )
    .all(projectId) as Array<{
    id: string
    project_id: string
    name: string
    content: string
    created_at: number
  }>
  return rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    content: r.content,
    createdAt: r.created_at
  }))
}

/** Add a knowledge document to a project and return it. Bumps the project. */
export function addProjectKnowledge(
  projectId: string,
  name: string,
  content: string,
  now: number
): ProjectKnowledge {
  const id = nextId('know', now)
  getDb()
    .prepare(
      `INSERT INTO project_knowledge (id, project_id, name, content, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(id, projectId, name, content, now)
  getDb().prepare(`UPDATE projects SET updated_at = ? WHERE id = ?`).run(now, projectId)
  return { id, projectId, name, content, createdAt: now }
}

/** Remove a knowledge document by id. */
export function removeProjectKnowledge(id: string): void {
  getDb().prepare(`DELETE FROM project_knowledge WHERE id = ?`).run(id)
}

/** File a session under a project (or unfile it when projectId is null). */
export function assignSessionToProject(
  sessionId: string,
  projectId: string | null,
  now: number
): void {
  getDb()
    .prepare(`UPDATE sessions SET project_id = ?, updated_at = ? WHERE id = ?`)
    .run(projectId, now, sessionId)
}
