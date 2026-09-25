import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels'
import { ConversationRail } from '@renderer/components/ConversationRail'
import { ChatPanel } from '@renderer/components/ChatPanel'
import { PreviewPane } from '@renderer/components/PreviewPane'
import { TerminalPane } from '@renderer/components/TerminalPane'
import { useAppStore } from '@renderer/store/useAppStore'
import { usePreviewStore } from '@renderer/store/usePreviewStore'
import { useTerminalStore } from '@renderer/store/useTerminalStore'

/**
 * A thin, hoverable resize separator. Hover/drag styling is driven by the
 * `data-separator` attribute the library sets (data-separator-state).
 */
function Handle() {
  return (
    <Separator className="w-px cursor-col-resize bg-border/60 transition-colors data-[separator-state=hover]:bg-primary data-[separator-state=drag]:bg-primary" />
  )
}

/**
 * Chat workspace layout (Claude-desktop style). Left: the collapsible
 * ConversationRail. Center: the ChatPanel, full width.
 *
 * react-resizable-panels v4 treats bare numeric sizes as pixels, so percentage
 * sizes are passed as strings (e.g. "22" === 22%).
 */
export function AppLayout() {
  const root = useDefaultLayout({ id: 'myto.root' })
  const railOpen = useAppStore((s) => s.railOpen)
  // The right-hand side pane. Myto's preview (its little browser) and the Terminal
  // (its command transcript) share one slot and are mutually exclusive — the chat
  // stream closes one when it opens the other. Terminal wins any tie so a command
  // that lands at the same moment as a preview is never hidden behind it.
  const previewOpen = usePreviewStore((s) => s.open)
  const terminalOpen = useTerminalStore((s) => s.open)
  const sidePane = terminalOpen ? 'terminal' : previewOpen ? 'preview' : null

  return (
    <Group
      orientation="horizontal"
      id="myto.root"
      className="h-full"
      defaultLayout={root.defaultLayout}
      onLayoutChanged={root.onLayoutChanged}
    >
      {railOpen && (
        <>
          <Panel id="rail" defaultSize="20" minSize="14" maxSize="28">
            <ConversationRail />
          </Panel>
          <Handle />
        </>
      )}

      <Panel id="chat" defaultSize="80" minSize="30">
        <ChatPanel />
      </Panel>

      {sidePane && (
        <>
          <Handle />
          <Panel id="side" defaultSize="40" minSize="24" maxSize="60">
            {sidePane === 'terminal' ? <TerminalPane /> : <PreviewPane />}
          </Panel>
        </>
      )}
    </Group>
  )
}
