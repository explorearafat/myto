import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels'
import { ConversationRail } from '@renderer/components/ConversationRail'
import { ChatPanel } from '@renderer/components/ChatPanel'
import { PreviewPane } from '@renderer/components/PreviewPane'
import { TerminalPane } from '@renderer/components/TerminalPane'
import { FilesPane } from '@renderer/components/FilesPane'
import { EditorPane } from '@renderer/components/EditorPane'
import { useAppStore } from '@renderer/store/useAppStore'
import { usePreviewStore } from '@renderer/store/usePreviewStore'
import { useTerminalStore } from '@renderer/store/useTerminalStore'
import { useFilesStore } from '@renderer/store/useFilesStore'
import { useEditorStore } from '@renderer/store/useEditorStore'

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
  // The right-hand side pane. Myto's preview (its little browser), the Terminal (its
  // command transcript), the Files pane (its live working tree) and the Editor pane
  // (its "watch me edit" photo/video surface) share one slot and are mutually exclusive
  // — the chat stream closes the others when it opens one. A PINNED preview (a live dev
  // server / a plan under review) or a PINNED editor (an edit mid-play/bake) wins the
  // slot so its continuing output can't yank it away; otherwise last-opened wins, with
  // the chat stream and the top-bar toggles keeping only one open at a time.
  const previewOpen = usePreviewStore((s) => s.open)
  const previewPinned = usePreviewStore((s) => s.pinned)
  const terminalOpen = useTerminalStore((s) => s.open)
  const filesOpen = useFilesStore((s) => s.open)
  const editorOpen = useEditorStore((s) => s.open)
  const editorPinned = useEditorStore((s) => s.pinned)
  const sidePane =
    editorPinned && editorOpen
      ? 'editor'
      : previewPinned && previewOpen
        ? 'preview'
        : terminalOpen
          ? 'terminal'
          : filesOpen
            ? 'files'
            : previewOpen
              ? 'preview'
              : editorOpen
                ? 'editor'
                : null

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
            {sidePane === 'terminal' ? (
              <TerminalPane />
            ) : sidePane === 'files' ? (
              <FilesPane />
            ) : sidePane === 'editor' ? (
              <EditorPane />
            ) : (
              <PreviewPane />
            )}
          </Panel>
        </>
      )}
    </Group>
  )
}
