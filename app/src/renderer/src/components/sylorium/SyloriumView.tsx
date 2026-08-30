/**
 * SyloriumView — the Sylorium environment shell.
 *
 * Sylorium is a custom browser environment built for Sylor, not a website embedded
 * inside the app. It is a permanent side-by-side split:
 *
 *   • Left  — a curated browser whose home is an app launcher (a grid of essential
 *             web apps over a search box, with no address bar); a live <webview>
 *             once a page is open.
 *   • Right — a dedicated, always-visible chat with Sylor about the open page, which
 *             can (with permission) drive that same live tab over multiple steps.
 *
 * This component owns only the frame: the first-run onboarding gate, the resizable
 * split of the two panes, and the environment-wide overlays (permission drawer,
 * approval modal). All shared state and behavior lives in {@link useSyloriumEnv};
 * both panes read the same hook, so the tab shown on the left is exactly the page
 * the chat on the right can see and act on — and both stay mounted, so the browser
 * session and the chat transcript always survive.
 */
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels'
import { useAppStore } from '@renderer/store/useAppStore'
import { SyloriumOnboarding } from './SyloriumOnboarding'
import { SyloriumPermissions } from './SyloriumPermissions'
import { SyloriumBrowser } from './SyloriumBrowser'
import { SyloriumChat } from './SyloriumChat'
import { useSyloriumEnv } from './useSyloriumEnv'
import { IconShield } from './icons'

/**
 * A thin, hoverable resize separator between the browser and the chat (mirrors the
 * app shell's Handle). Hover/drag styling is driven by the `data-separator-state`
 * attribute the library sets.
 */
function Handle() {
  return (
    <Separator className="w-px cursor-col-resize bg-border/60 transition-colors data-[separator-state=hover]:bg-primary data-[separator-state=drag]:bg-primary" />
  )
}

export function SyloriumView() {
  const initialized = useAppStore((s) => s.syloriumInitialized)
  // Its own persisted split, distinct from the app shell's `sylor.root`.
  const layout = useDefaultLayout({ id: 'sylor.sylorium' })
  const env = useSyloriumEnv()

  // First run: honest onboarding, shown once (persisted flag), then never again.
  if (!initialized) return <SyloriumOnboarding />

  return (
    <div className="relative h-full min-h-0 w-full bg-bg sylor-view-in">
      {/* Browser (left) and chat (right) sit side-by-side, both always mounted, on
          a persisted, draggable split — the tab on the left is the page the chat
          on the right can see and drive. */}
      <Group
        orientation="horizontal"
        id="sylor.sylorium"
        className="h-full min-h-0 w-full"
        defaultLayout={layout.defaultLayout}
        onLayoutChanged={layout.onLayoutChanged}
      >
        <Panel id="sylorium-browser" defaultSize="60" minSize="34">
          <SyloriumBrowser env={env} />
        </Panel>
        <Handle />
        <Panel id="sylorium-chat" defaultSize="40" minSize="28">
          <SyloriumChat env={env} />
        </Panel>
      </Group>

      {/* ── AI permissions drawer (slides in from the right) ─────────────── */}
      {env.showPermissions && (
        <div className="absolute inset-0 z-30 flex justify-end">
          <div
            className="absolute inset-0 bg-black/30 sylor-fade-in"
            onClick={() => env.setShowPermissions(false)}
          />
          <div className="relative z-10 h-full">
            <SyloriumPermissions onClose={() => env.setShowPermissions(false)} />
          </div>
        </div>
      )}

      {/* ── Approval modal (for every `ask`-gated AI action) ─────────────── */}
      {env.approval && (
        <div className="absolute inset-0 z-40 grid place-items-center bg-black/40 p-6 sylor-fade-in">
          <div className="w-full max-w-sm rounded-2xl bg-surface p-5 shadow-2xl">
            <div className="mb-3 flex items-center gap-2">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary/12 text-primary">
                <IconShield />
              </span>
              <h2 className="text-[14px] font-medium text-text">Sylor wants to act</h2>
            </div>
            <p className="text-[12.5px] leading-relaxed text-text">
              Sylor is asking to <span className="font-medium text-primary">{env.approval.detail}</span>.
            </p>
            <p className="mt-1 text-[11px] uppercase tracking-wide text-muted">
              Action class: {env.approval.action}
            </p>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={env.deny}
                className="sylor-press rounded-lg bg-surface-2 px-3.5 py-1.5 text-[12px] font-medium text-text transition-colors hover:bg-border"
              >
                Deny
              </button>
              <button
                type="button"
                onClick={env.approve}
                className="sylor-press rounded-lg bg-primary px-3.5 py-1.5 text-[12px] font-medium text-bg transition-colors hover:opacity-90"
              >
                Approve
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
