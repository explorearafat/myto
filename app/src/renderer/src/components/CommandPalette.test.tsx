import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { ActivityStep, AgentCardUI } from '@renderer/store/useChatStore'
import type { CheckpointInfo, CommandInfo, SessionSummary } from '@shared/types'

/**
 * The palette is a *shortcut* surface, so the two things worth testing are the two
 * rules its header states: it only offers what is actually there (an empty group is
 * absent, not greyed out), and it never does anything irreversible — a fuzzy match
 * plus a reflexive Enter must not be able to rewrite a tree, so a restore row only
 * ARMS the restore and the Timeline still asks.
 *
 * `startRun` is faked because sending a turn is the one action here that reaches the
 * engine; everything else runs the real store action, so the assertions are on real
 * state (`canvasMode`, `logLane`, `armedCheckpoint`) rather than on a spy.
 */
const { startRun } = vi.hoisted(() => ({ startRun: vi.fn() }))
vi.mock('@renderer/lib/startRun', () => ({ startRun }))

// jsdom has no scroll layout at all, so this method simply does not exist on an
// element; the palette calls it to keep the highlighted row in view while arrowing.
Element.prototype.scrollIntoView = vi.fn()

const { CommandPalette } = await import('@renderer/components/CommandPalette')
const { useAppStore } = await import('@renderer/store/useAppStore')
const { useChatStore } = await import('@renderer/store/useChatStore')
const { useSessionStore } = await import('@renderer/store/useSessionStore')

const listCheckpoints = window.sylor.checkpoints.list as Mock
const restore = window.sylor.checkpoints.restore as Mock
const listCommands = window.sylor.commands.list as Mock

const POINT: CheckpointInfo = {
  id: 'cp-1',
  at: 1_700_000_000_000,
  label: 'Before writing src/app.ts',
  kind: 'git',
  sha: 'abc123'
}

const SHIP: CommandInfo = {
  name: 'ship',
  description: 'Cut a release',
  argumentHint: '<version>',
  body: 'Ship $ARGUMENTS',
  source: 'project',
  path: '/test/.sylor/commands/ship.md'
}

function step(id: string, over: Partial<ActivityStep> = {}): ActivityStep {
  return {
    id,
    at: 1_700_000_000_000,
    kind: 'phase',
    stage: 'reading',
    message: 'Reading src/index.ts',
    done: false,
    ...over
  }
}

function agent(over: Partial<AgentCardUI> = {}): AgentCardUI {
  return {
    agentId: 'a1',
    runId: 'run-1',
    afterMessageId: 'm-1',
    role: 'builder',
    task: 'edit the router',
    status: 'running',
    content: '',
    ...over
  }
}

function chat(id: string, title: string): SessionSummary {
  return {
    id,
    title,
    projectRoot: '/test',
    projectId: null,
    createdAt: 1,
    updatedAt: 2,
    messageCount: 3
  }
}

/** Every row currently listed, top to bottom. */
function rows(): string[] {
  return screen.queryAllByRole('button').map((b) => b.textContent ?? '')
}

/** Type into the palette's search box. */
function type(text: string): void {
  fireEvent.change(screen.getByLabelText('Search actions'), { target: { value: text } })
}

function press(name: string): void {
  fireEvent.keyDown(screen.getByRole('dialog'), { key: name })
}

function open(): void {
  act(() => {
    useAppStore.setState({ paletteOpen: true })
  })
}

beforeEach(() => {
  startRun.mockClear()
  restore.mockClear()
  listCheckpoints.mockClear()
  listCheckpoints.mockResolvedValue([])
  listCommands.mockClear()
  listCommands.mockResolvedValue([])
  useChatStore.setState({
    activity: [],
    agents: [],
    checkpoints: [],
    running: false,
    cancelAgent: vi.fn(),
    cancel: vi.fn()
  })
  useSessionStore.setState({
    sessions: [],
    activeSessionId: null,
    newDraft: vi.fn().mockResolvedValue(undefined),
    open: vi.fn().mockResolvedValue(undefined)
  })
  useAppStore.setState({
    paletteOpen: false,
    canvasOpen: false,
    canvasMode: 'log',
    logLane: null,
    armedCheckpoint: null,
    permissionMode: 'ask',
    railOpen: true,
    settingsOpen: false,
    previewOpen: false,
    browserOpen: false,
    models: [{ id: 'm-active', name: 'Active model' }],
    settings: { ...useAppStore.getState().settings, modelId: 'm-active' },
    selectModel: vi.fn().mockResolvedValue(undefined)
  })
})

describe('CommandPalette', () => {
  it('renders nothing at all while closed', () => {
    const { container } = render(<CommandPalette />)
    expect(container.firstChild).toBeNull()
  })

  it('opens on the store flag, focused, with the canvas modes listed', async () => {
    open()
    render(<CommandPalette />)

    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeTruthy()
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText('Search actions'))
    )
    expect(rows()[0]).toContain('Open the run log')
    expect(screen.getByText('Open the dependency graph')).toBeTruthy()
  })

  it('leaves out the groups that have nothing behind them', () => {
    open()
    render(<CommandPalette />)

    // No trace yet, so no lane to jump to; nothing running, so nothing to stop;
    // no checkpoints on disk, so no restore points. Absent, not greyed out.
    expect(screen.queryByText('Lanes')).toBeNull()
    expect(screen.queryByText('Run')).toBeNull()
    expect(screen.queryByText('Restore points')).toBeNull()
    // The canvas is closed, so there is nothing to close.
    expect(screen.queryByText('Close the canvas')).toBeNull()
    // The only known model is the active one, so there is nothing to switch to.
    expect(screen.queryByText('Model')).toBeNull()
  })

  it('offers to close the canvas only once it is open', () => {
    useAppStore.setState({ canvasOpen: true })
    open()
    render(<CommandPalette />)
    expect(screen.getByText('Close the canvas')).toBeTruthy()
  })

  it('runs the highlighted row on Enter, closing first', () => {
    open()
    render(<CommandPalette />)

    press('ArrowDown')
    press('Enter')
    // Row 1 is "Open the diff": the overlay is gone by the time the surface it asked
    // for is on screen.
    expect(useAppStore.getState().paletteOpen).toBe(false)
    expect(useAppStore.getState().canvasMode).toBe('diff')
    expect(useAppStore.getState().canvasOpen).toBe(true)
  })

  it('wraps the highlight round the ends rather than stopping', () => {
    open()
    render(<CommandPalette />)
    const all = rows()

    press('ArrowUp')
    press('Enter')
    // Up from the first row lands on the last one.
    expect(all[all.length - 1]).toContain('Open settings')
    expect(useAppStore.getState().settingsOpen).toBe(true)
  })

  it('closes on Escape and on the backdrop, but not on a click inside the box', () => {
    open()
    render(<CommandPalette />)

    fireEvent.mouseDown(screen.getByRole('dialog'))
    expect(useAppStore.getState().paletteOpen).toBe(true)

    press('Escape')
    expect(useAppStore.getState().paletteOpen).toBe(false)

    open()
    fireEvent.mouseDown(screen.getByRole('presentation'))
    expect(useAppStore.getState().paletteOpen).toBe(false)
  })

  it('ranks the surface above the prompt when the words match both', () => {
    open()
    render(<CommandPalette />)
    type('diff')

    // The whole point of pinning the send row last: searching for "diff" finds the
    // diff, it does not fire a turn about the word "diff".
    expect(rows()[0]).toContain('Open the diff')
    expect(screen.getByText('Ask Sylor: diff')).toBeTruthy()
    expect(startRun).not.toHaveBeenCalled()
  })

  it('sends typed words to Sylor through the same path as the composer', () => {
    open()
    render(<CommandPalette />)
    type('add a login page')

    fireEvent.click(screen.getByText('Ask Sylor: add a login page'))
    expect(startRun).toHaveBeenCalledWith('add a login page')
    expect(useAppStore.getState().paletteOpen).toBe(false)
  })

  it('offers no send row while a run is going, only a way to stop it', () => {
    const cancel = vi.fn()
    useChatStore.setState({ running: true, cancel })
    open()
    render(<CommandPalette />)

    type('add a login page')
    expect(screen.queryByText('Ask Sylor: add a login page')).toBeNull()

    type('')
    fireEvent.click(screen.getByText('Stop this run'))
    expect(cancel).toHaveBeenCalled()
  })

  it('switches to the slash catalogs on a leading slash', async () => {
    listCommands.mockResolvedValue([SHIP])
    open()
    render(<CommandPalette />)
    type('/')

    // The two built-ins plus the one command on disk, and nothing else: a slash line
    // means the user wants a command, not a canvas mode.
    await waitFor(() => expect(rows()).toHaveLength(3))
    expect(screen.getByText('/install <owner/repo> [project]')).toBeTruthy()
    expect(screen.getByText('/remember <fact to remember>')).toBeTruthy()
    expect(screen.getByText('/ship <version>')).toBeTruthy()
    // No "Ask Sylor: /ship" — the command row already sends it, expanded.
    expect(screen.queryByText(/^Ask Sylor/)).toBeNull()
  })

  it('keeps the arguments typed after the command name', () => {
    open()
    render(<CommandPalette />)
    type('/remember I prefer tabs')

    // The words after the name are the argument, not a search term — filtering the
    // list by the whole line would drop the row that sends it.
    expect(rows()).toHaveLength(1)
    fireEvent.click(screen.getByText('/remember <fact to remember>'))
    // The raw line goes to `startRun`, which is what expands it — the palette does
    // not build the prompt itself.
    expect(startRun).toHaveBeenCalledWith('/remember I prefer tabs')
  })

  it('always leaves the typed words as an offer, however little matches', () => {
    open()
    render(<CommandPalette />)
    type('zzzzqqq')

    // Nothing in Sylor is called that, but the words are still worth something, so
    // the send row is the floor: the list is never blank while you are typing.
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toContain('Ask Sylor: zzzzqqq')
  })

  it('says so plainly when nothing matches and there is nothing to send', () => {
    useChatStore.setState({ running: true })
    open()
    render(<CommandPalette />)
    type('zzzzqqq')

    // A run is going, so there is no send row to fall back on.
    expect(screen.getByText('Nothing matches “zzzzqqq”.')).toBeTruthy()
    expect(rows()).toHaveLength(0)
  })

  it('lists a lane per worker, and jumps the log to it', () => {
    useChatStore.setState({
      activity: [step('1'), step('2', { agentId: 'a1', agentRole: 'builder' })],
      agents: [agent()]
    })
    open()
    render(<CommandPalette />)

    expect(screen.getByText('Jump to Sylor’s own steps')).toBeTruthy()
    fireEvent.click(screen.getByText('Jump to Builder'))
    expect(useAppStore.getState().logLane).toBe('a1')
    // Jumping to a lane means showing the log that filters by it.
    expect(useAppStore.getState().canvasMode).toBe('log')
    expect(useAppStore.getState().canvasOpen).toBe(true)
  })

  it('offers to stop a running lane, and stops offering once it is closed', () => {
    const cancelAgent = vi.fn()
    useChatStore.setState({
      activity: [step('2', { agentId: 'a1', agentRole: 'builder' })],
      agents: [agent()],
      cancelAgent
    })
    open()
    const first = render(<CommandPalette />)

    fireEvent.click(screen.getByText('Stop the Builder subagent'))
    expect(cancelAgent).toHaveBeenCalledWith('a1')
    first.unmount()

    // A lane already asked to stop is not an offer — the engine is unwinding it.
    useChatStore.setState({ agents: [agent({ cancelling: true })] })
    open()
    const second = render(<CommandPalette />)
    expect(screen.queryByText('Stop the Builder subagent')).toBeNull()
    second.unmount()

    // Nor is one that has finished, though its steps are still there to jump to.
    useChatStore.setState({ agents: [agent({ status: 'complete', ok: true })] })
    open()
    render(<CommandPalette />)
    expect(screen.queryByText('Stop the Builder subagent')).toBeNull()
    expect(screen.getByText('Jump to Builder')).toBeTruthy()
  })

  it('arms a restore point instead of restoring it', async () => {
    listCheckpoints.mockResolvedValue([POINT])
    open()
    render(<CommandPalette />)

    await waitFor(() => expect(screen.getByText('Before writing src/app.ts')).toBeTruthy())
    fireEvent.click(screen.getByText('Before writing src/app.ts'))

    // Armed and shown on the timeline, which is where the confirm lives. A restore
    // rewrites files, so a fuzzy match plus a reflexive Enter must not be enough.
    expect(useAppStore.getState().armedCheckpoint).toBe('cp-1')
    expect(useAppStore.getState().canvasMode).toBe('timeline')
    expect(restore).not.toHaveBeenCalled()
  })

  it('lists the approval postures it is not already in', () => {
    open()
    render(<CommandPalette />)

    expect(screen.queryByText('Ask before every edit and command')).toBeNull()
    fireEvent.click(screen.getByText('Auto-apply edits, ask before commands'))
    expect(useAppStore.getState().permissionMode).toBe('auto-edit')
  })

  it('lists the other models and the other chats, never the active one', () => {
    useAppStore.setState({
      models: [
        { id: 'm-active', name: 'Active model' },
        { id: 'm-other', name: 'Other model' }
      ]
    })
    useSessionStore.setState({
      sessions: [chat('s-1', 'This chat'), chat('s-2', 'An older chat')],
      activeSessionId: 's-1'
    })
    open()
    render(<CommandPalette />)

    expect(screen.queryByText('Switch to Active model')).toBeNull()
    expect(screen.getByText('Switch to Other model')).toBeTruthy()
    expect(screen.queryByText('This chat')).toBeNull()
    expect(screen.getByText('An older chat')).toBeTruthy()
    expect(screen.getByText('Start a new chat')).toBeTruthy()
  })
})
