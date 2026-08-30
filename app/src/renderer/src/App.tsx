import { useEffect } from 'react'
import { TitleBar } from '@renderer/components/TitleBar'
import { SplashScreen } from '@renderer/components/SplashScreen'
import { SettingsPanel } from '@renderer/components/SettingsPanel'
import { AppLayout } from '@renderer/components/layout/AppLayout'
import { ErrorBoundary } from '@renderer/components/ErrorBoundary'
import { useAppStore } from '@renderer/store/useAppStore'
import { useSessionStore } from '@renderer/store/useSessionStore'
import { useProjectStore } from '@renderer/store/useProjectStore'

export default function App() {
  const settingsOpen = useAppStore((s) => s.settingsOpen)
  const loadSettings = useAppStore((s) => s.loadSettings)
  const initWorkspace = useAppStore((s) => s.initWorkspace)
  const setWorkspace = useAppStore((s) => s.setWorkspace)
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
    return () => dispose?.()
  }, [loadSettings, initWorkspace, setWorkspace, boot, refreshProjects])

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
      <SplashScreen />
    </div>
  )
}
