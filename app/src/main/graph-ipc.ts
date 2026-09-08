import { ipcMain } from 'electron'
import { IpcChannel } from '../shared/ipc'
import type { DepGraph, DepGraphRequest, DepGraphScope } from '../shared/types'
import { buildDepGraph } from './graph/depGraph'
import { contextManager } from './context/manager'

/**
 * Graph IPC — one read-only handler behind the canvas's Graph mode.
 *
 * The index lives in main, so the graph is built there. The renderer supplies only
 * the run's touched paths, which are used purely as keys into that index: nothing
 * here opens a file, so a path the renderer got wrong can at worst fail to match.
 */

/** Keep only plausible project-relative paths, and bound how many we accept. */
const MAX_SEEDS = 400

function paths(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((p): p is string => typeof p === 'string' && p.length > 0).slice(0, MAX_SEEDS)
}

function scopeOf(value: unknown): DepGraphScope {
  return value === 'project' ? 'project' : 'run'
}

export function registerGraphIpc(): void {
  ipcMain.handle(IpcChannel.GraphBuild, (_event, raw: unknown): DepGraph => {
    const req = (raw ?? {}) as Partial<DepGraphRequest>
    const request: DepGraphRequest = {
      scope: scopeOf(req.scope),
      touched: paths(req.touched),
      written: paths(req.written)
    }
    try {
      return buildDepGraph(contextManager.projectIndex(), request)
    } catch (err) {
      console.error('[sylor] failed to build the dependency graph:', err)
      // An empty graph reads as "nothing to draw", which is what the UI should show
      // when the index isn't there — better than a dialog about a diagram.
      return { scope: request.scope, nodes: [], edges: [], omitted: 0, indexed: 0 }
    }
  })
}
