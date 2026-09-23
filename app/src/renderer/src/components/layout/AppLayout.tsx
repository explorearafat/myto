import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels'
import { ConversationRail } from '@renderer/components/ConversationRail'
import { ChatPanel } from '@renderer/components/ChatPanel'
import { PreviewPane } from '@renderer/components/PreviewPane'
import { useAppStore } from '@renderer/store/useAppStore'
import { usePreviewStore } from '@renderer/store/usePreviewStore'

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
  // Myto's preview pane opens on the right when the `preview` tool shows something.
  const previewOpen = usePreviewStore((s) => s.open)

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

      {previewOpen && (
        <>
          <Handle />
          <Panel id="preview" defaultSize="40" minSize="24" maxSize="60">
            <PreviewPane />
          </Panel>
        </>
      )}
    </Group>
  )
}
