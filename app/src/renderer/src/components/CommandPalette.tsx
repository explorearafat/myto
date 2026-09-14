/**
 * CommandPalette — Ctrl/Cmd+K: one keyboard entry point to everything.
 *
 * Sylor grew a lot of surfaces (five canvas modes, lanes, restore points, three
 * approval postures, a model list, a chat history) and each of them had exactly one
 * way in: find the right pill or the right tab and click it. That is fine when you
 * know where things are and useless when you don't, so this is the flat, searchable
 * index of the same actions — nothing here is palette-only, it is all reachable by
 * mouse too.
 *
 * Two rules shape it:
 *
 *  - **It never does anything irreversible.** Restoring a checkpoint rewrites files,
 *    so the palette *arms* the restore and the Timeline still asks (see the store's
 *    `armCheckpoint`). A fuzzy match plus a reflexive Enter must not be able to
 *    rewrite a tree.
 *  - **It only offers what is actually there.** Lanes come from the run's own trace,
 *    models from the provider's list, chats from the database. An empty group is
 *    absent rather than greyed out, so the list never advertises a surface that has
 *    nothing behind it.
 *
 * Typed text that isn't a match is still useful: the last row sends it to Sylor as a
 * prompt, through the same `startRun` the composer uses. A leading `/` switches the
 * list to the slash catalogs, so `/install …` works from here exactly as it does in
 * the composer.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore, type CanvasMode } from '@renderer/store/useAppStore'
import { useChatStore } from '@renderer/store/useChatStore'
import { useSessionStore } from '@renderer/store/useSessionStore'
import { lanesOf, LEAD } from '@renderer/lib/lanes'
import { buildSlashItems, loadSlashSources, NO_SLASH_SOURCES } from '@renderer/lib/slashSources'
import { startRun } from '@renderer/lib/startRun'
import { formatClock } from '@renderer/lib/duration'
import type { PermissionMode } from '@shared/types'

/** One row. `run` is fired on Enter/click; the palette closes first either way. */
interface Action {
  id: string
  /** Heading this row files under. Rows keep their group's order. */
  group: string
  label: string
  /** Right-aligned detail — a value, a count, a time. Never load-bearing. */
  detail?: string
  /** Extra words the filter matches but the row doesn't show. */
  keywords?: string
  run: () => void
}

/** How many rows the list shows at once. Enough to scroll, few enough to scan. */
const MAX_ROWS = 40
/** Per-group caps, so one long list (chats, models) can't bury everything else. */
const MAX_PER_GROUP = 8

/**
 * Score `text` against a lowercase `query`: 0 means no match, higher is better.
 *
 * Three tiers, because ranking matters more than cleverness here — a prefix hit
 * ("diff" → "Diff") must beat a mid-word hit ("diff" → "Show the changed files and
 * their diffs"), and both must beat a scattered-letters hit. The subsequence tier is
 * what makes "ocm" find "Open the changed files"; it scores lowest on purpose.
 */
function score(text: string, query: string): number {
  const lower = text.toLowerCase()
  if (lower.startsWith(query)) return 1000 - lower.length
  const at = lower.indexOf(query)
  // A hit right after a space reads as a word start, which is nearly as good.
  if (at === 0 || (at > 0 && lower[at - 1] === ' ')) return 800 - at
  if (at > 0) return 600 - at
  let i = 0
  for (const ch of lower) {
    if (ch === query[i]) i += 1
    if (i === query.length) return 200
  }
  return 0
}

/** Rank the actions for `query`, keeping group order when nothing is typed. */
function filterActions(actions: Action[], query: string): Action[] {
  const q = query.trim().toLowerCase()
  if (!q) return actions.slice(0, MAX_ROWS)
  const hits: Array<{ action: Action; rank: number }> = []
  for (const action of actions) {
    // The label is what the user reads, so it always outranks a keyword-only hit.
    const best = Math.max(
      score(action.label, q),
      action.keywords ? score(action.keywords, q) - 50 : 0,
      score(action.group, q) - 100
    )
    if (best > 0) hits.push({ action, rank: best })
  }
  hits.sort((a, b) => b.rank - a.rank)
  return hits.slice(0, MAX_ROWS).map((h) => h.action)
}

/** Cap each group in place, so a long list can't crowd out the short ones. */
function capGroups(actions: Action[]): Action[] {
  const seen = new Map<string, number>()
  const out: Action[] = []
  for (const action of actions) {
    const n = seen.get(action.group) ?? 0
    if (n >= MAX_PER_GROUP) continue
    seen.set(action.group, n + 1)
    out.push(action)
  }
  return out
}

const MODE_LABEL: Record<PermissionMode, string> = {
  plan: 'Plan mode — read-only, explore and propose a plan',
  ask: 'Ask before every edit and command',
  'auto-edit': 'Auto-apply edits, ask before commands',
  autonomous: 'Hands-free — auto-run edits, commands and tools'
}

const CANVAS_LABEL: Record<CanvasMode, string> = {
  log: 'Open the run log',
  diff: 'Open the diff',
  tree: 'Open the changed files',
  graph: 'Open the dependency graph',
  timeline: 'Open the restore points'
}

const CANVAS_KEYWORDS: Record<CanvasMode, string> = {
  log: 'trace steps timestamps activity terminal',
  diff: 'changes edit write monaco',
  tree: 'files touched written folder',
  graph: 'imports dependencies map',
  timeline: 'checkpoint restore rollback undo history'
}

export function CommandPalette() {
  const open = useAppStore((s) => s.paletteOpen)
  const closePalette = useAppStore((s) => s.closePalette)

  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  const actions = usePaletteActions(query, closePalette)
  // A slash line's arguments are not search terms. `/remember I prefer tabs` is a
  // complete instruction, and filtering the list by the whole line would drop the
  // very row that sends it — the name is what `buildSlashItems` matched on, so the
  // filter sees the name alone while the row still carries the arguments.
  const filter = query.trimStart().startsWith('/') ? query.trim().split(/\s+/)[0] : query
  const rows = useMemo(() => capGroups(filterActions(actions, filter)), [actions, filter])

  // A fresh open is a fresh search: a leftover query from last time would hide the
  // list behind a filter the user has forgotten typing.
  useEffect(() => {
    if (!open) return
    setQuery('')
    setIndex(0)
    // The overlay mounts this frame; focus after it lands or the input misses it.
    const id = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [open])

  // Keep the highlight in range as the filter narrows.
  useEffect(() => {
    setIndex((i) => (i >= rows.length ? 0 : i))
  }, [rows.length])

  // Keep the highlighted row visible while arrowing through a list taller than the box.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row="${index}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [index, rows])

  if (!open) return null

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closePalette()
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setIndex((i) => (rows.length === 0 ? 0 : (i + 1) % rows.length))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setIndex((i) => (rows.length === 0 ? 0 : (i - 1 + rows.length) % rows.length))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      rows[index]?.run()
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center pt-[12vh]"
      role="presentation"
      onMouseDown={(event) => {
        // Only a click on the backdrop itself dismisses — a drag that ends outside
        // the box shouldn't close the thing the user is typing into.
        if (event.target === event.currentTarget) closePalette()
      }}
    >
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[1px]" aria-hidden="true" />
      <div
        role="dialog"
        aria-label="Command palette"
        aria-modal="true"
        className="relative flex max-h-[70vh] w-[min(38rem,92vw)] flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-2xl"
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <span className="font-mono text-[12px] text-muted/70" aria-hidden="true">
            &gt;
          </span>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setIndex(0)
            }}
            placeholder="Search actions, lanes, chats — or type a prompt"
            aria-label="Search actions"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-text outline-none placeholder:text-muted/60"
          />
          <kbd className="shrink-0 rounded border border-border px-1 font-mono text-[9.5px] text-muted/70">
            esc
          </kbd>
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1">
          {rows.length === 0 && (
            <p className="px-3 py-4 text-center text-[12px] text-muted">
              Nothing matches “{query.trim()}”.
            </p>
          )}
          {rows.map((action, i) => {
            const first = i === 0 || rows[i - 1].group !== action.group
            return (
              <div key={action.id}>
                {first && (
                  <div className="px-3 pb-0.5 pt-2 text-[9.5px] uppercase tracking-wider text-muted/60">
                    {action.group}
                  </div>
                )}
                <button
                  type="button"
                  data-row={i}
                  onMouseEnter={() => setIndex(i)}
                  onClick={action.run}
                  className={
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors ' +
                    (index === i ? 'bg-surface-2' : 'hover:bg-surface-2/60')
                  }
                >
                  <span
                    className={
                      'min-w-0 flex-1 truncate text-[12.5px] ' +
                      (index === i ? 'text-text' : 'text-text/85')
                    }
                  >
                    {action.label}
                  </span>
                  {action.detail && (
                    <span className="shrink-0 font-mono text-[10px] text-muted/70">
                      {action.detail}
                    </span>
                  )}
                </button>
              </div>
            )
          })}
        </div>

        <div className="flex items-center gap-3 border-t border-border px-3 py-1.5 text-[10px] text-muted/70">
          <span>↑↓ move</span>
          <span>↵ run</span>
          <span className="ml-auto">{rows.length} of {actions.length}</span>
        </div>
      </div>
    </div>
  )
}

/**
 * Everything the palette can do right now, in group order.
 *
 * Built fresh on each render from live store state — which is the point: a lane that
 * just started, a checkpoint just taken, a chat just renamed all show up without the
 * palette subscribing to anything special. `close` runs before each action so the
 * overlay is gone by the time the surface it opened is on screen.
 */
function usePaletteActions(query: string, close: () => void): Action[] {
  const activity = useChatStore((s) => s.activity)
  const agents = useChatStore((s) => s.agents)
  const running = useChatStore((s) => s.running)
  const checkpoints = useChatStore((s) => s.checkpoints)
  const cancelAgent = useChatStore((s) => s.cancelAgent)
  const cancelRun = useChatStore((s) => s.cancel)

  const sessions = useSessionStore((s) => s.sessions)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const openSession = useSessionStore((s) => s.open)
  const newDraft = useSessionStore((s) => s.newDraft)

  const paletteOpen = useAppStore((s) => s.paletteOpen)
  const canvasOpen = useAppStore((s) => s.canvasOpen)
  const logLane = useAppStore((s) => s.logLane)
  const permissionMode = useAppStore((s) => s.permissionMode)
  const planFirst = useAppStore((s) => s.planFirst)
  const railOpen = useAppStore((s) => s.railOpen)
  const models = useAppStore((s) => s.models)
  const activeModelId = useAppStore((s) => s.settings.modelId)
  const setCanvasMode = useAppStore((s) => s.setCanvasMode)
  const closeCanvas = useAppStore((s) => s.closeCanvas)
  const showLane = useAppStore((s) => s.showLane)
  const armCheckpoint = useAppStore((s) => s.armCheckpoint)
  const setPermissionMode = useAppStore((s) => s.setPermissionMode)
  const setPlanFirst = useAppStore((s) => s.setPlanFirst)
  const toggleRail = useAppStore((s) => s.toggleRail)
  const openSettings = useAppStore((s) => s.openSettings)
  const selectModel = useAppStore((s) => s.selectModel)
  const openPreview = useAppStore((s) => s.openPreview)
  const openBrowser = useAppStore((s) => s.openBrowser)

  const [sources, setSources] = useState(NO_SLASH_SOURCES)

  // Load, once per opening, the lists the palette can't derive locally: the slash
  // catalogs and (if they've never been fetched) the provider's models, plus a fresh
  // read of the restore points, which are files on disk another window may have added.
  // Everything is read through `getState()` so the effect depends on the open alone —
  // re-running because the model list arrived would just re-fetch the rest.
  useEffect(() => {
    if (!paletteOpen) return
    let alive = true
    void (async () => {
      const next = await loadSlashSources()
      if (alive) setSources(next)
    })()
    const app = useAppStore.getState()
    if (app.models.length === 0) void app.refreshModels()
    useChatStore.getState().refreshCheckpoints()
    return () => {
      alive = false
    }
  }, [paletteOpen])

  const act = useCallback(
    (fn: () => void) => () => {
      close()
      fn()
    },
    [close]
  )

  const lanes = useMemo(() => lanesOf(activity, agents), [activity, agents])
  const typed = query.trim()
  const slash = typed.startsWith('/')

  return useMemo(() => {
    const out: Action[] = []

    // A typed slash line means the user wants a command, so those lead. `startRun`
    // expands the template, exactly as the composer's menu does.
    if (slash) {
      const parts = typed.slice(1).split(/\s+/)
      const args = parts.slice(1).join(' ')
      for (const item of buildSlashItems(sources, parts[0] ?? '', MAX_PER_GROUP)) {
        out.push({
          id: 'slash:' + item.name,
          group: 'Commands',
          label: '/' + item.name + (item.hint ? ' ' + item.hint : ''),
          detail: item.kind === 'skill' ? 'skill' : item.kind === 'builtin' ? 'built-in' : 'command',
          keywords: item.description,
          run: act(() => void startRun(`/${item.name}${args ? ' ' + args : ''}`))
        })
      }
    }

    for (const mode of Object.keys(CANVAS_LABEL) as CanvasMode[]) {
      out.push({
        id: 'canvas:' + mode,
        group: 'Canvas',
        label: CANVAS_LABEL[mode],
        keywords: CANVAS_KEYWORDS[mode],
        run: act(() => setCanvasMode(mode))
      })
    }
    if (canvasOpen) {
      out.push({
        id: 'canvas:close',
        group: 'Canvas',
        label: 'Close the canvas',
        keywords: 'hide panel',
        run: act(closeCanvas)
      })
    }

    // Only offer lanes once there is a trace to filter; before that the strip in the
    // log doesn't exist either.
    if (activity.length > 0) {
      for (const lane of lanes) {
        out.push({
          id: 'lane:' + lane.key,
          group: 'Lanes',
          label: `Jump to ${lane.label}${lane.key === LEAD ? '’s own steps' : ''}`,
          detail: `${lane.count} step${lane.count === 1 ? '' : 's'}`,
          keywords: (lane.current ?? '') + ' subagent lane filter',
          run: act(() => showLane(lane.key))
        })
      }
      if (logLane != null) {
        out.push({
          id: 'lane:all',
          group: 'Lanes',
          label: 'Show every lane',
          keywords: 'clear filter all',
          run: act(() => showLane(null))
        })
      }
      for (const lane of lanes) {
        if (lane.state !== 'running' || lane.cancelling) continue
        out.push({
          id: 'cancel:' + lane.key,
          group: 'Lanes',
          label: `Stop the ${lane.label} subagent`,
          detail: 'the run continues',
          keywords: 'cancel kill abort',
          run: act(() => cancelAgent(lane.key))
        })
      }
    }
    if (running) {
      out.push({
        id: 'run:stop',
        group: 'Run',
        label: 'Stop this run',
        keywords: 'cancel abort interrupt halt',
        run: act(cancelRun)
      })
    }

    // Arming, not restoring: the Timeline row still asks before it rewrites files.
    for (const point of checkpoints) {
      out.push({
        id: 'restore:' + point.id,
        group: 'Restore points',
        label: point.label,
        detail: formatClock(point.at),
        keywords: 'checkpoint restore rollback undo ' + point.kind,
        run: act(() => armCheckpoint(point.id))
      })
    }

    for (const mode of Object.keys(MODE_LABEL) as PermissionMode[]) {
      if (mode === permissionMode) continue
      out.push({
        id: 'perm:' + mode,
        group: 'Approvals',
        label: MODE_LABEL[mode],
        detail: mode,
        keywords: 'permission auto approve mode ' + mode,
        run: act(() => setPermissionMode(mode))
      })
    }
    out.push({
      id: 'plan-first',
      group: 'Approvals',
      label: planFirst ? 'Stop asking me to approve the plan first' : 'Approve the plan first',
      detail: planFirst ? 'on' : 'off',
      keywords: 'plan first toggle',
      run: act(() => void setPlanFirst(!planFirst))
    })

    for (const model of models) {
      if (model.id === activeModelId) continue
      out.push({
        id: 'model:' + model.id,
        group: 'Model',
        label: `Switch to ${model.name || model.id}`,
        keywords: model.id,
        run: act(() => void selectModel(model.id, model.name))
      })
    }

    out.push({
      id: 'chat:new',
      group: 'Chats',
      label: 'Start a new chat',
      keywords: 'draft blank fresh',
      run: act(() => void newDraft())
    })
    for (const session of sessions) {
      if (session.id === activeSessionId) continue
      out.push({
        id: 'chat:' + session.id,
        group: 'Chats',
        label: session.title || 'Untitled chat',
        detail: `${session.messageCount} msg`,
        keywords: 'open chat history session',
        run: act(() => void openSession(session.id))
      })
    }

    out.push(
      {
        id: 'panel:preview',
        group: 'Workspace',
        label: 'Open the live preview',
        keywords: 'dev server localhost browser page',
        run: act(openPreview)
      },
      {
        id: 'panel:browser',
        group: 'Workspace',
        label: 'Open the browser',
        keywords: 'web page url sylorium browse',
        run: act(openBrowser)
      },
      {
        id: 'rail',
        group: 'Workspace',
        label: railOpen ? 'Hide the sidebar' : 'Show the sidebar',
        keywords: 'rail history nav',
        run: act(toggleRail)
      },
      {
        id: 'settings',
        group: 'Workspace',
        label: 'Open settings',
        keywords: 'provider api key model theme preferences',
        run: act(() => openSettings())
      }
    )

    // Last, and only with something typed: hand the words to Sylor. Pinned to the
    // bottom on purpose — a search for "diff" should find the diff, not fire a turn.
    if (typed && !running && !slash) {
      out.push({
        id: 'ask',
        group: 'Send',
        label: `Ask Sylor: ${typed}`,
        detail: '↵',
        run: act(() => void startRun(typed))
      })
    }

    return out
  }, [
    act,
    activeModelId,
    activeSessionId,
    activity.length,
    armCheckpoint,
    canvasOpen,
    cancelAgent,
    cancelRun,
    checkpoints,
    closeCanvas,
    lanes,
    logLane,
    models,
    newDraft,
    openBrowser,
    openPreview,
    openSession,
    openSettings,
    permissionMode,
    planFirst,
    railOpen,
    running,
    selectModel,
    sessions,
    setCanvasMode,
    setPermissionMode,
    setPlanFirst,
    showLane,
    slash,
    sources,
    toggleRail,
    typed
  ])
}
