import { create } from 'zustand'
import type { Project, ProjectKnowledge } from '@shared/types'
import { useSessionStore } from './useSessionStore'

/**
 * Projects state: the collection shown in the rail plus its CRUD. Kept
 * deliberately thin — this store owns *only* the projects list and knowledge
 * docs. Which project the recents list is scoped to lives in
 * {@link useSessionStore} as `activeProjectId`, so the coupling stays
 * one-directional (project store → session store) and no cycle forms.
 */
export interface ProjectState {
  projects: Project[]
  /** Knowledge docs for the project currently open in the dialog, or []. */
  knowledge: ProjectKnowledge[]

  /** Reload the projects list from the main process. */
  refresh: () => Promise<void>
  /** Create a project and return it (rail may switch to it). */
  create: (name: string) => Promise<Project>
  /** Rename a project (persisted, then reloads the list). */
  rename: (id: string, name: string) => Promise<void>
  /** Update a project's custom instructions. */
  setInstructions: (id: string, instructions: string) => Promise<void>
  /** Replace a project's long-term memory note (edit/clear from the dialog). */
  setMemory: (id: string, memory: string) => Promise<void>
  /**
   * Delete a project. Sessions filed under it are detached (project_id → NULL,
   * done in the DB layer). If it was the scoped project, reset the rail to
   * "all chats"; otherwise just reload the list.
   */
  remove: (id: string) => Promise<void>

  /** Load one project's knowledge docs into `knowledge` (for the dialog). */
  loadKnowledge: (projectId: string) => Promise<void>
  /** Add a knowledge doc, then refresh `knowledge`. */
  addKnowledge: (projectId: string, name: string, content: string) => Promise<void>
  /** Remove a knowledge doc, then refresh `knowledge`. */
  removeKnowledge: (projectId: string, id: string) => Promise<void>
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  knowledge: [],

  refresh: async () => {
    const projects = await window.myto.projects.list()
    set({ projects })
  },

  create: async (name) => {
    const project = await window.myto.projects.create(name)
    await get().refresh()
    return project
  },

  rename: async (id, name) => {
    await window.myto.projects.rename(id, name)
    await get().refresh()
  },

  setInstructions: async (id, instructions) => {
    await window.myto.projects.setInstructions(id, instructions)
    await get().refresh()
  },

  setMemory: async (id, memory) => {
    await window.myto.projects.setMemory(id, memory)
    await get().refresh()
  },

  remove: async (id) => {
    await window.myto.projects.remove(id)
    const session = useSessionStore.getState()
    if (session.activeProjectId === id) {
      // The scoped project is gone — fall back to the all-chats view (this also
      // refreshes the recents list).
      await session.setActiveProject(null)
    }
    await get().refresh()
  },

  loadKnowledge: async (projectId) => {
    const knowledge = await window.myto.projects.listKnowledge(projectId)
    set({ knowledge })
  },

  addKnowledge: async (projectId, name, content) => {
    await window.myto.projects.addKnowledge(projectId, name, content)
    await get().loadKnowledge(projectId)
  },

  removeKnowledge: async (projectId, id) => {
    await window.myto.projects.removeKnowledge(id)
    await get().loadKnowledge(projectId)
  }
}))
