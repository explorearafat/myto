import { useEffect } from 'react'
import { TitleBar } from '@renderer/components/TitleBar'
import { SplashScreen } from '@renderer/components/SplashScreen'
import { SettingsPanel } from '@renderer/components/SettingsPanel'
import { CommandPalette } from '@renderer/components/CommandPalette'
import { AppLayout } from '@renderer/components/layout/AppLayout'
import { ErrorBoundary } from '@renderer/components/ErrorBoundary'
import { useAppStore } from '@renderer/store/useAppStore'
import { useChatStore } from '@renderer/store/useChatStore'
import { useSessionStore } from '@renderer/store/useSessionStore'
import { useProjectStore } from '@renderer/store/useProjectStore'
import { enqueueScheduledTask } from '@renderer/lib/scheduler-runner'

export default function App() {
  const settingsOpen = useAppStore((s) => s.settingsOpen)
  const loadSettings = useAppStore((s) => s.loadSettings)
  const initWorkspace = useAppStore((s) => s.initWorkspace)
  const setWorkspace = useAppStore((s) => s.setWorkspace)
  const togglePalette = useAppStore((s) => s.togglePalette)
  const showLane = useAppStore((s) => s.showLane)
  const boot = useSessionStore((s) => s.boot)
  const refreshProjects = useProjectStore((s) => s.refresh)

  // Load persisted provider settings first (so the provider is ready), restore
  // the current working folder, then open a fresh landing page (boot never
  // restores the last chat) with the full global history in the rail, and load
  // the projects list.
  useEffect(() => {
    void loadSettings()
    void initWorkspace()
    void boot()
    void refreshProjects()

    // React to the user picking a new folder (main-process broadcast): just mirror
    // the new root into state. History is GLOBAL now — one flat, cross-folder list
    // — so switching folders (or code↔cowork) must never hide chats or disturb the
    // open conversation. We deliberately do NOT re-boot here: the current chat (and
    // any background run, keyed by session not folder) keeps going, and the rail is
    // unchanged since it isn't scoped to the root. New chats created after the
    // switch are simply stamped with the new root.
    const dispose = window.sylor?.workspace?.onChanged?.((info) => {
      setWorkspace(info)
    })

    // A scheduled task came due (main-process scheduler): run it in a fresh chat.
    // The runner idle-gates and serializes fires, and routes through the normal
    // send path so a scheduled run still pauses at sensitive tools for approval.
    const disposeScheduler = window.sylor?.scheduler?.onTaskFired?.((task) => {
      enqueueScheduledTask(task)
    })

    // The tray and the floating card can only ASK (see `main/ambient-ipc.ts`): this
    // window is where both intents land, because it is the one that holds the live
    // runId and owns the canvas. Keeping cancellation here means there is exactly one
    // owner of it, instead of a second path into the engine that could disagree about
    // what is running.
    const disposeFocus = window.sylor?.ambient?.onFocusLane?.((lane) => {
      showLane(lane)
    })
    const disposeStop = window.sylor?.ambient?.onStopRequest?.(() => {
      useChatStore.getState().cancel()
    })

    return () => {
      dispose?.()
      disposeScheduler?.()
      disposeFocus?.()
      disposeStop?.()
    }
  }, [loadSettings, initWorkspace, setWorkspace, boot, refreshProjects, showLane])

  // The app's one global shortcut: Ctrl/Cmd+K opens the command palette. Registered
  // here, on the window, rather than on a component, so it works whatever has focus —
  // the composer, the file tree, a Monaco diff. `capture` gets it before Monaco's own
  // keybindings, which otherwise swallow Ctrl+K inside an editor.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== 'k') return
      if (!event.ctrlKey && !event.metaKey) return
      if (event.altKey) return
      event.preventDefault()
      togglePalette()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [togglePalette])

  return (
    <div className="relative flex h-full flex-col">
      <TitleBar />
      {/* min-h-0 is required so the panel group can shrink inside the flex column.
          `relative` anchors the full-screen Settings overlay so it fills this area
          (below the title bar) rather than covering the window controls.
          The inner boundary keeps a chat/preview crash contained: the title bar and
          window controls stay alive, so the user can still move or close the window
          instead of facing a blank, unclosable frame. */}
      <div className="relative min-h-0 flex-1">
        <ErrorBoundary label="The workspace">
          <AppLayout />
        </ErrorBoundary>
        {settingsOpen && <SettingsPanel />}
      </div>
      {/* Above the Settings overlay (z-40/50) and below the splash (z-100): Ctrl+K
          has to reach the palette even while Settings is covering the workspace. */}
      <CommandPalette />
      <SplashScreen />
    </div>
  )
}
