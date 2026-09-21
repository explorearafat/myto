import { useMemo, useState } from 'react'
import type {
  McpServerConfig,
  McpServerStatus,
  McpTestResult,
  McpTransport
} from '@shared/types'
import { useAppStore } from '@renderer/store/useAppStore'

/*
 * The Connectors settings pane.
 *
 * A connector is an MCP server whose tools Sylor can call. This pane lists the
 * configured servers with their live connection status, and hosts the add/edit form
 * (transport, command/args or URL/headers). The server list is ordinary settings —
 * saving here persists through the normal settings store and triggers a reconnect
 * (see useAppStore.saveConnector). Status dots are pushed from the main process.
 *
 * Kept deliberately close to Claude Desktop's connector UX: a card per server, a
 * status pill, a Test button that probes before you commit, and a raw command/URL
 * form so a user can paste a known `mcpServers` entry.
 */

/** A short id for a new connector — enough to key it uniquely in settings. */
function newId(): string {
  return `mcp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

/** Parse a whitespace/newline-separated args box into a string array. */
function parseArgs(raw: string): string[] {
  return raw
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Parse a `KEY=value` per-line box into a record (blank/`#`-comment lines skipped). */
function parseEnv(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return out
}

/** Render a record back into the `KEY=value` per-line form. */
function stringifyEnv(env: Record<string, string> | undefined): string {
  if (!env) return ''
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
}

const TRANSPORT_OPTIONS: ReadonlyArray<{ id: McpTransport; label: string; hint: string }> = [
  { id: 'stdio', label: 'Local (stdio)', hint: 'Sylor runs a command on this machine' },
  { id: 'http', label: 'HTTP', hint: 'Connect to a remote server URL' },
  { id: 'sse', label: 'SSE', hint: 'Older HTTP + Server-Sent Events' }
]

/** The status pill next to each connector. */
function StatusPill({ status }: { status: McpServerStatus | undefined }) {
  const state = status?.state ?? 'disabled'
  const map: Record<string, { label: string; cls: string }> = {
    connected: { label: `Connected · ${status?.toolCount ?? 0} tools`, cls: 'bg-emerald-500/15 text-emerald-500' },
    connecting: { label: 'Connecting…', cls: 'bg-amber-500/15 text-amber-500' },
    error: { label: 'Error', cls: 'bg-rose-500/15 text-rose-500' },
    disabled: { label: 'Off', cls: 'bg-surface-2 text-muted' }
  }
  const { label, cls } = map[state] ?? map.disabled
  return <span className={'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ' + cls}>{label}</span>
}

/** The add/edit form for one connector. */
function ConnectorForm({
  initial,
  onCancel,
  onSaved
}: {
  initial: McpServerConfig | null
  onCancel: () => void
  onSaved: () => void
}) {
  const saveConnector = useAppStore((s) => s.saveConnector)
  const testConnector = useAppStore((s) => s.testConnector)

  const [name, setName] = useState(initial?.name ?? '')
  const [transport, setTransport] = useState<McpTransport>(initial?.transport ?? 'stdio')
  const [command, setCommand] = useState(initial?.command ?? '')
  const [args, setArgs] = useState((initial?.args ?? []).join(' '))
  const [env, setEnv] = useState(stringifyEnv(initial?.env))
  const [url, setUrl] = useState(initial?.url ?? '')
  const [headers, setHeaders] = useState(stringifyEnv(initial?.headers))
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<McpTestResult | null>(null)
  const [saving, setSaving] = useState(false)

  const isStdio = transport === 'stdio'
  const canSubmit =
    name.trim().length > 0 && (isStdio ? command.trim().length > 0 : url.trim().length > 0)

  /** Assemble the current form into a config object (id preserved when editing). */
  const build = (): McpServerConfig => {
    const base: McpServerConfig = {
      id: initial?.id ?? newId(),
      name: name.trim(),
      enabled: initial?.enabled ?? true,
      transport
    }
    if (isStdio) {
      base.command = command.trim()
      base.args = parseArgs(args)
      const e = parseEnv(env)
      if (Object.keys(e).length) base.env = e
    } else {
      base.url = url.trim()
      const h = parseEnv(headers)
      if (Object.keys(h).length) base.headers = h
    }
    return base
  }

  const onTest = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    try {
      setTestResult(await testConnector(build()))
    } finally {
      setTesting(false)
    }
  }

  const onSave = async (): Promise<void> => {
    setSaving(true)
    try {
      await saveConnector(build())
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  const field = 'w-full rounded-lg border border-border bg-bg px-3 py-2 text-[13px] text-text placeholder:text-muted focus:border-primary focus:outline-none'
  const label = 'mb-1 block text-[12px] font-medium text-text'

  return (
    <div className="space-y-4 rounded-xl border border-border bg-bg p-4">
      <div>
        <label className={label}>Name</label>
        <input
          className={field}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. GitHub, Filesystem, My API"
        />
      </div>

      <div>
        <span className={label}>Connection type</span>
        <div className="grid grid-cols-3 gap-2">
          {TRANSPORT_OPTIONS.map((opt) => {
            const active = opt.id === transport
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => setTransport(opt.id)}
                className={
                  'rounded-lg border px-2.5 py-2 text-left transition-colors ' +
                  (active
                    ? 'border-primary bg-primary/10'
                    : 'border-border bg-surface hover:border-muted')
                }
              >
                <div className="text-[12px] font-medium text-text">{opt.label}</div>
                <div className="mt-0.5 text-[11px] leading-tight text-muted">{opt.hint}</div>
              </button>
            )
          })}
        </div>
      </div>

      {isStdio ? (
        <>
          <div>
            <label className={label}>Command</label>
            <input
              className={field + ' font-mono'}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="npx"
            />
          </div>
          <div>
            <label className={label}>Arguments</label>
            <input
              className={field + ' font-mono'}
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder="-y @modelcontextprotocol/server-filesystem /path"
            />
            <p className="mt-1 text-[11px] text-muted">Space-separated, like a shell command.</p>
          </div>
          <div>
            <label className={label}>Environment variables</label>
            <textarea
              className={field + ' font-mono'}
              rows={2}
              value={env}
              onChange={(e) => setEnv(e.target.value)}
              placeholder={'API_KEY=…\nONE_PER_LINE=…'}
            />
          </div>
        </>
      ) : (
        <>
          <div>
            <label className={label}>Server URL</label>
            <input
              className={field + ' font-mono'}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/mcp"
            />
          </div>
          <div>
            <label className={label}>Headers</label>
            <textarea
              className={field + ' font-mono'}
              rows={2}
              value={headers}
              onChange={(e) => setHeaders(e.target.value)}
              placeholder={'Authorization=Bearer …\nOne per line'}
            />
          </div>
        </>
      )}

      {testResult && (
        <div
          className={
            'rounded-lg px-3 py-2 text-[12px] ' +
            (testResult.ok
              ? 'bg-emerald-500/10 text-emerald-500'
              : 'bg-rose-500/10 text-rose-500')
          }
        >
          {testResult.ok
            ? `Connected — ${testResult.toolCount} tool${testResult.toolCount === 1 ? '' : 's'}${
                testResult.toolNames?.length ? `: ${testResult.toolNames.slice(0, 6).join(', ')}` : ''
              }`
            : `Failed: ${testResult.error}`}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 pt-1">
        <button
          type="button"
          onClick={() => void onTest()}
          disabled={!canSubmit || testing}
          className="rounded-lg border border-border px-3 py-1.5 text-[12px] font-medium text-text transition-colors hover:bg-surface-2 disabled:opacity-40"
        >
          {testing ? 'Testing…' : 'Test connection'}
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-3 py-1.5 text-[12px] font-medium text-muted transition-colors hover:text-text"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void onSave()}
            disabled={!canSubmit || saving}
            className="rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-bg transition-colors hover:opacity-90 disabled:opacity-40"
          >
            {saving ? 'Saving…' : initial ? 'Save changes' : 'Add connector'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** One row in the configured-connectors list. */
function ConnectorRow({
  config,
  status,
  onEdit
}: {
  config: McpServerConfig
  status: McpServerStatus | undefined
  onEdit: () => void
}) {
  const saveConnector = useAppStore((s) => s.saveConnector)
  const removeConnector = useAppStore((s) => s.removeConnector)
  const [busy, setBusy] = useState(false)

  const toggle = async (): Promise<void> => {
    setBusy(true)
    try {
      await saveConnector({ ...config, enabled: !config.enabled })
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    setBusy(true)
    try {
      await removeConnector(config.id)
    } finally {
      setBusy(false)
    }
  }

  const target =
    config.transport === 'stdio'
      ? `${config.command ?? ''} ${(config.args ?? []).join(' ')}`.trim()
      : config.url ?? ''

  return (
    <div className="rounded-xl border border-border bg-bg p-3.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-medium text-text">{config.name}</span>
            <StatusPill status={status} />
          </div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-muted">{target}</div>
          {status?.state === 'error' && status.error && (
            <div className="mt-1 text-[11px] text-rose-500">{status.error}</div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => void toggle()}
            disabled={busy}
            className="rounded-md px-2 py-1 text-[11px] font-medium text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-40"
          >
            {config.enabled ? 'Disable' : 'Enable'}
          </button>
          <button
            type="button"
            onClick={onEdit}
            className="rounded-md px-2 py-1 text-[11px] font-medium text-muted transition-colors hover:bg-surface-2 hover:text-text"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => void remove()}
            disabled={busy}
            className="rounded-md px-2 py-1 text-[11px] font-medium text-rose-500 transition-colors hover:bg-rose-500/10 disabled:opacity-40"
          >
            Remove
          </button>
        </div>
      </div>
    </div>
  )
}

/** The Connectors pane: list of configured servers + add/edit form. */
export function ConnectorsPane() {
  const servers = useAppStore((s) => s.settings.mcpServers)
  const statuses = useAppStore((s) => s.mcpStatuses)
  const toolsEnabled = useAppStore((s) => s.settings.tools.enabled)
  const [editing, setEditing] = useState<McpServerConfig | null>(null)
  const [adding, setAdding] = useState(false)

  const statusById = useMemo(() => {
    const map = new Map<string, McpServerStatus>()
    for (const s of statuses) map.set(s.id, s)
    return map
  }, [statuses])

  const showForm = adding || editing !== null

  return (
    <div className="space-y-5">
      {!toolsEnabled && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3.5 py-3 text-[12px] leading-relaxed text-amber-500">
          Tool use is turned off, so connector tools won't be offered to Sylor. Turn it on in
          Settings → Tools to use your connectors.
        </div>
      )}

      <p className="text-[12px] leading-relaxed text-muted">
        Connectors are MCP servers that give Sylor extra tools — a filesystem, a GitHub client, a
        database, your own API. Add one below; once connected, its tools are available to Sylor just
        like the built-in ones.
      </p>

      {servers.length > 0 && (
        <div className="space-y-2.5">
          {servers.map((config) => (
            <ConnectorRow
              key={config.id}
              config={config}
              status={statusById.get(config.id)}
              onEdit={() => {
                setAdding(false)
                setEditing(config)
              }}
            />
          ))}
        </div>
      )}

      {showForm ? (
        <ConnectorForm
          initial={editing}
          onCancel={() => {
            setAdding(false)
            setEditing(null)
          }}
          onSaved={() => {
            setAdding(false)
            setEditing(null)
          }}
        />
      ) : (
        <button
          type="button"
          onClick={() => {
            setEditing(null)
            setAdding(true)
          }}
          className="w-full rounded-xl border border-dashed border-border py-3 text-[13px] font-medium text-muted transition-colors hover:border-primary hover:text-text"
        >
          + Add connector
        </button>
      )}
    </div>
  )
}
