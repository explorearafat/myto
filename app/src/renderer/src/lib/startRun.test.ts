import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { startRun } from '@renderer/lib/startRun'
import { NO_SLASH_SOURCES } from '@renderer/lib/slashSources'
import { useAppStore } from '@renderer/store/useAppStore'
import { useChatStore, type OutgoingAttachment } from '@renderer/store/useChatStore'
import { useSessionStore } from '@renderer/store/useSessionStore'
import type { CommandInfo } from '@shared/types'

/**
 * This module exists because the composer and the palette must send a turn the same
 * way, so what is tested here is the *sequence* — the three refusals in the order
 * they are checked, the lazy `create()` that gives a draft somewhere to save, and the
 * split between what the bubble shows (the raw `/line`) and what the engine reads
 * (the expansion). A palette run that skipped `create()` would look like it worked
 * and then vanish on reload, which is exactly the drift the module was written to
 * prevent, so `create` is asserted rather than assumed.
 *
 * Nothing is mocked at module level: `send`, `create` and `autoName` are replaced in
 * the real stores with spies, so the assertions are on what startRun actually called
 * with what arguments.
 */
const listCommands = window.sylor.commands.list as Mock
const listSkills = window.sylor.skills.list as Mock

const SHIP: CommandInfo = {
  name: 'ship',
  description: 'Cut a release',
  argumentHint: '<version>',
  body: 'Ship $ARGUMENTS',
  source: 'project',
  path: '/test/.sylor/commands/ship.md'
}

let send: Mock
let create: Mock
let autoName: Mock

beforeEach(() => {
  send = vi.fn()
  create = vi.fn(async () => {
    // create() is what gives the draft a row, so the spy models that too: a later
    // read of `sessionId` must see the session it made.
    useChatStore.setState({ sessionId: 's-new' })
  })
  autoName = vi.fn(async () => {})
  listCommands.mockClear()
  listCommands.mockResolvedValue([])
  listSkills.mockClear()
  listSkills.mockResolvedValue([])
  useChatStore.setState({ running: false, sessionId: 's-1', send })
  useSessionStore.setState({ create, autoName })
  // Cowork needs no folder; the code-mode tests opt in.
  useAppStore.setState({ workMode: 'cowork', workspaceChosen: false })
})

describe('startRun', () => {
  it('sends the trimmed line and reports that it went out', async () => {
    const res = await startRun('  add a login page  ')

    expect(res).toMatchObject({ sent: true, blocked: null })
    // No expansion happened, so the engine override is undefined — the engine reads
    // the same text the bubble shows.
    expect(send).toHaveBeenCalledWith('add a login page', [], undefined)
  })

  it('refuses while a run is going, before it looks at anything else', async () => {
    useChatStore.setState({ running: true })
    // Empty *and* running: `running` is checked first, so that is the reason given —
    // "stop the current run" is more useful than "type something".
    expect(await startRun('')).toMatchObject({ sent: false, blocked: 'running' })
    expect(send).not.toHaveBeenCalled()
  })

  it('treats a whitespace-only line as empty', async () => {
    expect(await startRun('   \n  ')).toMatchObject({ sent: false, blocked: 'empty' })
    expect(send).not.toHaveBeenCalled()
  })

  it('sends attachments with no words at all', async () => {
    const attachments: OutgoingAttachment[] = [
      {
        attachment: {
          id: 'at-1',
          sessionId: 's-1',
          messageId: null,
          name: 'shot.png',
          mime: 'image/png',
          path: '/test/.sylor/attachments/at-1.png',
          size: 12,
          createdAt: 1_700_000_000_000
        }
      }
    ]
    const res = await startRun('', { attachments })

    // A dropped screenshot is a message. `empty` means nothing to send, not no text.
    expect(res.sent).toBe(true)
    expect(send).toHaveBeenCalledWith('', attachments, undefined)
  })

  it('blocks a code-mode turn until a folder is chosen', async () => {
    useAppStore.setState({ workMode: 'code', workspaceChosen: true })
    expect(await startRun('read src/index.ts')).toMatchObject({ sent: true, blocked: null })

    send.mockClear()
    useAppStore.setState({ workspaceChosen: false })
    // Code mode with no folder has nothing to read or write, so the send is refused
    // with the reason the surface needs to offer a folder picker.
    expect(await startRun('read src/index.ts')).toMatchObject({
      sent: false,
      blocked: 'needs-folder'
    })
    expect(send).not.toHaveBeenCalled()
  })

  it('says empty before it says needs-folder', async () => {
    useAppStore.setState({ workMode: 'code', workspaceChosen: false })
    // Both are true; the emptier problem is the one the user can fix by typing.
    expect(await startRun('')).toMatchObject({ blocked: 'empty' })
  })

  it('never blocks a cowork turn on a folder', async () => {
    // Chat has no workspace at all, so the folder check must not reach it.
    expect(await startRun('hello')).toMatchObject({ sent: true, blocked: null })
  })

  it('creates the session row first when the chat is still a draft', async () => {
    useChatStore.setState({ sessionId: null })
    await startRun('first message')

    // Lazily, on this first send: a draft has no row, and a turn with nowhere to
    // persist looks fine until the reload that loses it.
    expect(create).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('first message', [], undefined)
  })

  it('does not create a second row for a chat that has one', async () => {
    await startRun('second message')
    expect(create).not.toHaveBeenCalled()
  })

  it('keeps the raw line for the bubble and hands the expansion to the engine', async () => {
    listCommands.mockResolvedValue([SHIP])
    const res = await startRun('/ship 1.2')

    // The third argument is the override: the bubble still reads `/ship 1.2`, which
    // is what the user typed, while the model gets the template filled in.
    expect(send).toHaveBeenCalledWith('/ship 1.2', [], 'Ship 1.2')
    // The catalogs it had to fetch come back, so a caller holding them in state can
    // keep the copy instead of re-reading disk on the next line.
    expect(res.sources.commands).toEqual([SHIP])
  })

  it('does not read the catalogs for a line that is not a command', async () => {
    await startRun('ship 1.2')
    // No leading slash, so there is nothing to expand and no reason to touch disk.
    expect(listCommands).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith('ship 1.2', [], undefined)
  })

  it('sends an unknown command as typed rather than swallowing it', async () => {
    const res = await startRun('/nosuchthing do a thing')

    // The catalogs were checked and the name was not in them; the line still goes,
    // because dropping something the user wrote is worse than letting the model read
    // it. No override, since nothing expanded.
    expect(listCommands).toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith('/nosuchthing do a thing', [], undefined)
    expect(res.sent).toBe(true)
  })

  it('titles the chat from the expansion, not from the slash line', async () => {
    listCommands.mockResolvedValue([SHIP])
    await startRun('/ship 1.2')
    // `/ship 1.2` is a poor title; the words it stands for are the prompt.
    expect(autoName).toHaveBeenCalledWith('Ship 1.2')
  })

  it('uses the catalogs the caller already holds instead of re-reading', async () => {
    const res = await startRun('/ship 1.2', {
      sources: { commands: [SHIP], skills: [] }
    })

    expect(listCommands).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith('/ship 1.2', [], 'Ship 1.2')
    expect(res.sources.commands).toEqual([SHIP])
  })

  it('hands back the empty sources unchanged when it was blocked', async () => {
    useChatStore.setState({ running: true })
    const res = await startRun('/ship 1.2')
    // Nothing was expanded, so nothing was learnt: the caller keeps what it had.
    expect(res.sources).toBe(NO_SLASH_SOURCES)
  })
})
