import { useMemo, useState } from 'react'
import type { PluginConfig } from '@shared/types'
import { useAppStore } from '@renderer/store/useAppStore'

/*
 * The Plugins settings pane.
 *
 * A plugin is a shareable bundle that installs a set of skills and/or connectors in
 * one step. Installing pastes a JSON manifest, which the store expands into ordinary
 * skills + connectors tagged with the plugin's id (so they appear in the Skills /
 * Connectors panes and can be removed together). This pane lists installed plugins
 * and hosts the paste-to-install box.
 */

/** A small, valid example manifest shown as a starting point. */
const EXAMPLE_MANIFEST = `{
  "name": "Web Research Kit",
  "description": "Fetch pages and take structured notes",
  "skills": [
    {
      "name": "Source notes",
      "description": "Summarize a page into structured notes",
      "instructions": "For each source: capture the URL, 3 key claims, and one caveat. Cite quotes verbatim."
    }
  ],
  "mcpServers": [
    {
      "name": "Fetch",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-fetch"]
    }
  ]
}`

/** Count how many skills + connectors a plugin currently owns (by source tag). */
function usePluginItemCounts(id: string): { skills: number; servers: number } {
  const skills = useAppStore((s) => s.settings.skills)
  const servers = useAppStore((s) => s.settings.mcpServers)
  return useMemo(
    () => ({
      skills: skills.filter((s) => s.source === id).length,
      servers: servers.filter((s) => s.source === id).length
    }),
    [skills, servers, id]
  )
}

/** One installed-plugin row. */
function PluginRow({ plugin }: { plugin: PluginConfig }) {
  const setPluginEnabled = useAppStore((s) => s.setPluginEnabled)
  const uninstallPlugin = useAppStore((s) => s.uninstallPlugin)
  const counts = usePluginItemCounts(plugin.id)
  const [busy, setBusy] = useState(false)

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }

  const summary = [
    counts.skills > 0 ? `${counts.skills} skill${counts.skills === 1 ? '' : 's'}` : null,
    counts.servers > 0 ? `${counts.servers} connector${counts.servers === 1 ? '' : 's'}` : null
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="rounded-xl border border-border bg-bg p-3.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-medium text-text">{plugin.name}</span>
            {!plugin.enabled && (
              <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-muted">
                Off
              </span>
            )}
          </div>
          {plugin.description && (
            <div className="mt-0.5 truncate text-[12px] text-muted">{plugin.description}</div>
          )}
          <div className="mt-0.5 text-[11px] text-muted">{summary || 'No items'}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => void run(() => setPluginEnabled(plugin.id, !plugin.enabled))}
            disabled={busy}
            className="rounded-md px-2 py-1 text-[11px] font-medium text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-40"
          >
            {plugin.enabled ? 'Disable' : 'Enable'}
          </button>
          <button
            type="button"
            onClick={() => void run(() => uninstallPlugin(plugin.id))}
            disabled={busy}
            className="rounded-md px-2 py-1 text-[11px] font-medium text-rose-500 transition-colors hover:bg-rose-500/10 disabled:opacity-40"
          >
            Uninstall
          </button>
        </div>
      </div>
    </div>
  )
}

/** The paste-to-install box. */
function InstallBox({ onDone }: { onDone: () => void }) {
  const installPlugin = useAppStore((s) => s.installPlugin)
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const onInstall = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await installPlugin(text)
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const field =
    'w-full rounded-lg border border-border bg-bg px-3 py-2 font-mono text-[12px] leading-relaxed text-text placeholder:text-muted focus:border-primary focus:outline-none'

  return (
    <div className="space-y-3 rounded-xl border border-border bg-bg p-4">
      <div>
        <label className="mb-1 block text-[12px] font-medium text-text">Plugin manifest (JSON)</label>
        <textarea
          className={field}
          rows={10}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={EXAMPLE_MANIFEST}
        />
      </div>
      {error && (
        <div className="rounded-lg bg-rose-500/10 px-3 py-2 text-[12px] text-rose-500">{error}</div>
      )}
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setText(EXAMPLE_MANIFEST)}
          className="text-[12px] font-medium text-muted transition-colors hover:text-text"
        >
          Use example
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onDone}
            className="rounded-lg px-3 py-1.5 text-[12px] font-medium text-muted transition-colors hover:text-text"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void onInstall()}
            disabled={!text.trim() || busy}
            className="rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-bg transition-colors hover:opacity-90 disabled:opacity-40"
          >
            {busy ? 'Installing…' : 'Install'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** The Plugins pane: installed plugins + the install box. */
export function PluginsPane() {
  const plugins = useAppStore((s) => s.settings.plugins)
  const [installing, setInstalling] = useState(false)

  return (
    <div className="space-y-5">
      <p className="text-[12px] leading-relaxed text-muted">
        Plugins bundle skills and connectors so you can add a whole capability in one step. Paste a
        manifest to install one — its skills and connectors then show up in the Skills and Connectors
        panes, and uninstalling removes them all together.
      </p>

      {plugins.length > 0 && (
        <div className="space-y-2.5">
          {plugins.map((plugin) => (
            <PluginRow key={plugin.id} plugin={plugin} />
          ))}
        </div>
      )}

      {installing ? (
        <InstallBox onDone={() => setInstalling(false)} />
      ) : (
        <button
          type="button"
          onClick={() => setInstalling(true)}
          className="w-full rounded-xl border border-dashed border-border py-3 text-[13px] font-medium text-muted transition-colors hover:border-primary hover:text-text"
        >
          + Install plugin
        </button>
      )}
    </div>
  )
}
