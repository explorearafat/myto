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
  const createSession = useSessionStore((s) => s.create)
  const refreshProjects = useProjectStore((s) => s.refresh)

  // Load persisted provider settings first (so the provider is ready), restore
  // the current working folder (requirement A), then restore the most-recent
  // session — or create a fresh one — from the DB, and load the projects rail.
  useEffect(() => {
    void loadSettings()
    void initWorkspace()
    void boot()
    void refreshProjects()

    // React to the user picking a new folder (main-process broadcast): mirror the
    // new root into state and start a fresh chat scoped to it — like opening a
    // folder in an IDE. MCP + skills are already repointed/reloaded in the main
    // process (applyRoot) and re-read when Settings is next opened. On startup the
    // main process sets the root silently (no broadcast), so this never fires an
    // extra chat at boot.
    const dispose = window.sylor?.workspace?.onChanged?.((info) => {
      setWorkspace(info)
      void createSession()
    })
    return () => dispose?.()
  }, [loadSettings, initWorkspace, setWorkspace, boot, createSession, refreshProjects])

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
