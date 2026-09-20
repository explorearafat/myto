import { useEffect } from 'react'
import { TitleBar } from '@renderer/components/TitleBar'
import { SplashScreen } from '@renderer/components/SplashScreen'
import { SettingsPanel } from '@renderer/components/SettingsPanel'
import { AppLayout } from '@renderer/components/layout/AppLayout'
import { ErrorBoundary } from '@renderer/components/ErrorBoundary'
import { useAppStore } from '@renderer/store/useAppStore'
import { useSessionStore } from '@renderer/store/useSessionStore'
import { useProjectStore } from '@renderer/store/useProjectStore'
import { useByokConfig } from '@renderer/lib/useByokConfig'

export default function App() {
  const settingsOpen = useAppStore((s) => s.settingsOpen)
  const loadSettings = useAppStore((s) => s.loadSettings)
  const applyByokConfig = useAppStore((s) => s.applyByokConfig)
  const boot = useSessionStore((s) => s.boot)
  const refreshProjects = useProjectStore((s) => s.refresh)

  // Firestore is the single source of truth for the chat model config: subscribe
  // to the signed-in account's BYOK doc and mirror it onto the persisted local
  // settings whenever it changes (this also seeds the offline cache).
  const { config } = useByokConfig()
  useEffect(() => {
    void applyByokConfig(config)
  }, [config, applyByokConfig])

  // Load persisted provider settings first (so the provider is ready), then open
  // a fresh landing page (boot never restores the last chat) with the full global
  // history in the rail, and load the projects list.
  useEffect(() => {
    void loadSettings()
    void boot()
    void refreshProjects()
  }, [loadSettings, boot, refreshProjects])

  return (
    <div className="relative flex h-full flex-col">
      <TitleBar />
      {/* min-h-0 is required so the panel group can shrink inside the flex column.
          `relative` anchors the full-screen Settings overlay so it fills this area
          (below the title bar) rather than covering the window controls.
          The inner boundary keeps a chat crash contained: the title bar and window
          controls stay alive, so the user can still move or close the window
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
