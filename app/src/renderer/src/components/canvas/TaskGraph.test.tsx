import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskGraph } from '@renderer/components/canvas/TaskGraph'
import { useChatStore, type ToolCardUI } from '@renderer/store/useChatStore'
import { useAppStore } from '@renderer/store/useAppStore'
import type { DepGraph, DepGraphRequest, ToolProposal } from '@shared/types'

/**
 * The graph itself is built in main (`graph/depGraph.ts`, tested there); what this
 * component decides is what it ASKS for and what it claims about the answer. So the
 * assertions are on the request — a rejected write is a file Sylor looked at but did
 * not change, and must not be sent as `written` — and on the two honesty details: the
 * empty state says something different for each scope, and a capped graph admits how
 * many nodes are not drawn.
 */
const buildMock = window.sylor.graph.build as unknown as ReturnType<typeof vi.fn>

const EMPTY: DepGraph = { scope: 'run', nodes: [], edges: [], omitted: 0, indexed: 0 }

/** A two-node graph with one import between them. */
const PAIR: DepGraph = {
  scope: 'run',
  nodes: [
    { path: 'src/app.ts', summary: 'The entry point.', touched: true, written: true, external: 3 },
    { path: 'src/util/helpers.ts', touched: false, written: false, external: 0 }
  ],
  edges: [{ from: 'src/app.ts', to: 'src/util/helpers.ts' }],
  omitted: 4,
  indexed: 42
}

function write(path: string, over: Partial<ToolCardUI> = {}): ToolCardUI {
  const id = 'w-' + path
  const proposal: ToolProposal = {
    id,
    kind: 'write_file',
    path,
    oldContent: '',
    newContent: 'x\n',
    exists: false
  }
  return { id, runId: 'run-1', afterMessageId: 'm-1', proposal, auto: false, status: 'complete', ...over }
}

function read(path: string): ToolCardUI {
  const id = 'r-' + path
  return {
    id,
    runId: 'run-1',
    afterMessageId: 'm-1',
    proposal: { id, kind: 'read', op: 'read_file', path },
    auto: true,
    status: 'complete'
  }
}

/** The request the component last sent to main. */
function lastRequest(): DepGraphRequest {
  return buildMock.mock.calls[buildMock.mock.calls.length - 1][0] as DepGraphRequest
}

function seed(tools: ToolCardUI[], opts: { running?: boolean } = {}): void {
  useChatStore.setState({ tools, running: opts.running ?? false })
}

beforeEach(() => {
  buildMock.mockClear()
  buildMock.mockResolvedValue(EMPTY)
  seed([])
  useAppStore.setState({ workspaceRoot: '/test' })
})

describe('TaskGraph', () => {
  it('waits for the folder to be known before asking for a graph', () => {
    useAppStore.setState({ workspaceRoot: null })
    render(<TaskGraph />)
    // At the boot instant there is no project to resolve imports against, so a read
    // now would answer for whatever root main defaulted to.
    expect(buildMock).not.toHaveBeenCalled()
  })

  it('asks for this run’s scope first, with the files it touched', async () => {
    seed([read('src/read.ts'), write('src/written.ts')])
    render(<TaskGraph />)

    await waitFor(() => expect(buildMock).toHaveBeenCalled())
    expect(lastRequest()).toEqual({
      scope: 'run',
      touched: ['src/read.ts', 'src/written.ts'],
      written: ['src/written.ts']
    })
  })

  it('counts a rejected write as looked-at but not as changed', async () => {
    seed([write('src/turned-down.ts', { decision: 'reject' })])
    render(<TaskGraph />)

    await waitFor(() => expect(buildMock).toHaveBeenCalled())
    // The write never happened, so nothing changed — but Sylor did open the file,
    // and the graph should still draw what it connects to.
    expect(lastRequest()).toEqual({
      scope: 'run',
      touched: ['src/turned-down.ts'],
      written: []
    })
  })

  it('sends each file once however many ops touched it', async () => {
    seed([read('src/a.ts'), write('src/a.ts'), write('src/a.ts', { id: 'w-2' })])
    render(<TaskGraph />)

    await waitFor(() => expect(buildMock).toHaveBeenCalled())
    expect(lastRequest().touched).toEqual(['src/a.ts'])
    expect(lastRequest().written).toEqual(['src/a.ts'])
  })

  it('re-reads with the wider scope when the switch is flipped', async () => {
    seed([write('src/a.ts')])
    render(<TaskGraph />)
    await waitFor(() => expect(buildMock).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByText('project'))
    await waitFor(() => expect(buildMock).toHaveBeenCalledTimes(2))
    expect(lastRequest().scope).toBe('project')
    // The seeds still go out: project scope draws everything, but the run's own
    // files are what the layout centres on.
    expect(lastRequest().touched).toEqual(['src/a.ts'])
  })

  it('says something different for each empty scope, and offers the switch anyway', async () => {
    render(<TaskGraph />)
    await waitFor(() => expect(screen.getByText('No files touched yet.')).toBeTruthy())

    fireEvent.click(screen.getByText('project'))
    await waitFor(() => expect(screen.getByText('Nothing indexed yet.')).toBeTruthy())
    // "Nothing indexed" is a fact about the index, not a promise about the project:
    // the copy says the map fills in as Sylor reads, and never guesses.
    expect(screen.getByText(/it never guesses at files it has not opened/)).toBeTruthy()
  })

  it('draws a node per file, an arrow per import, and admits what it left out', async () => {
    buildMock.mockResolvedValue(PAIR)
    seed([write('src/app.ts')])
    const { container } = render(<TaskGraph />)

    await waitFor(() =>
      expect(screen.getByRole('img', { name: 'Dependency graph: 2 files, 1 imports' })).toBeTruthy()
    )
    expect(screen.getByText('2 files, 1 import · 4 not drawn')).toBeTruthy()
    expect(screen.getByText('app.ts')).toBeTruthy()
    expect(screen.getByText('helpers.ts')).toBeTruthy()
    expect(container.querySelectorAll('path[marker-end]')).toHaveLength(1)
    // Nodes are labelled by base name, so the SVG <title> is where the full path
    // lives — with the summary and the count of imports that left the project.
    const tooltips = [...container.querySelectorAll('title')].map((t) => t.textContent)
    expect(tooltips).toContain('src/app.ts\nThe entry point.\n3 imports outside the project')
    // A node with nothing to add says only its path: no empty lines, no "0 imports".
    expect(tooltips).toContain('src/util/helpers.ts')
  })

  it('shows the external count on the node, never as an invented node', async () => {
    buildMock.mockResolvedValue(PAIR)
    render(<TaskGraph />)

    await waitFor(() => expect(screen.getByText('+3')).toBeTruthy())
    // `react` and friends are numbers, not files: the graph only draws what it can name.
    expect(screen.queryByText('react')).toBeNull()
  })

  it('truncates a long file name rather than letting it spill out of its box', async () => {
    buildMock.mockResolvedValue({
      ...PAIR,
      nodes: [
        {
          path: 'src/components/AbsurdlyLongComponentName.tsx',
          touched: true,
          written: false,
          external: 0
        }
      ],
      edges: [],
      omitted: 0
    })
    render(<TaskGraph />)

    await waitFor(() => expect(screen.getByText('AbsurdlyLongCompone…')).toBeTruthy())
  })
})
