import { useEffect } from 'react'
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels'
import { ConversationRail } from '@renderer/components/ConversationRail'
import { ChatPanel } from '@renderer/components/ChatPanel'
import { PreviewPanel } from '@renderer/components/PreviewPanel'
import { BrowserPanel } from '@renderer/components/browser/BrowserPanel'
import { CanvasPanel } from '@renderer/components/canvas/CanvasPanel'
import { useAppStore } from '@renderer/store/useAppStore'
import { initPreviewInspector } from '@renderer/lib/preview/inspector'

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
 * Chat-first workspace layout (Claude-desktop style). Left: the collapsible
 * ConversationRail. Center: the ChatPanel, full width. The right slot holds
 * whichever of the three side surfaces was opened last — the live preview when
 * Sylor builds something previewable, the browser when it goes and uses the web,
 * or the canvas (run log / diff / tree / graph) when the user wants to watch the
 * harness work. They share the slot because all three draw over the same region
 * and only one can own it (the store's open* actions enforce last-opener-wins).
 *
 * The chat pane itself is deliberately untouched by the canvas: bubbles, tool
 * cards and the single evolving status row stay exactly as they were, and the
 * canvas is an additive, opt-in surface beside them.
 *
 * react-resizable-panels v4 treats bare numeric sizes as pixels, so percentage
 * sizes are passed as strings (e.g. "22" === 22%).
 */
export function AppLayout() {
  const root = useDefaultLayout({ id: 'sylor.root' })
  const railOpen = useAppStore((s) => s.railOpen)
  const previewOpen = useAppStore((s) => s.previewOpen)
  const browserOpen = useAppStore((s) => s.browserOpen)
  const canvasOpen = useAppStore((s) => s.canvasOpen)

  // Start listening for engine `preview_inspect` requests once. The subscription
  // must outlive PreviewPanel mount/unmount so a request always gets an answer
  // (the inspector replies "no preview" when no page is loaded).
  useEffect(() => {
    initPreviewInspector()
  }, [])

  return (
    <Group
      orientation="horizontal"
      id="sylor.root"
      className="h-full"
      defaultLayout={root.defaultLayout}
      onLayoutChanged={root.onLayoutChanged}
    >
      {railOpen && (
        <>
          <Panel id="rail" defaultSize="18" minSize="12" maxSize="26">
            <ConversationRail />
          </Panel>
          <Handle />
        </>
      )}

      <Panel id="chat" defaultSize="82" minSize="30">
        <ChatPanel />
      </Panel>

      {previewOpen && (
        <>
          <Handle />
          <Panel id="preview" defaultSize="42" minSize="24" maxSize="62">
            <PreviewPanel />
          </Panel>
        </>
      )}

      {/* The browser panel is only a rectangle: the page inside it is a native view
          the main process draws over these bounds (see BrowserPanel). */}
      {browserOpen && !previewOpen && (
        <>
          <Handle />
          <Panel id="browser" defaultSize="46" minSize="26" maxSize="66">
            <BrowserPanel />
          </Panel>
        </>
      )}

      {canvasOpen && !previewOpen && !browserOpen && (
        <>
          <Handle />
          <Panel id="canvas" defaultSize="42" minSize="24" maxSize="62">
            <CanvasPanel />
          </Panel>
        </>
      )}
    </Group>
  )
}
