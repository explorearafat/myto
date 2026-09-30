import { useCallback, useEffect, useState } from 'react'
import type { ChatMode, ScheduledTask } from '@shared/types'

/*
 * The Scheduled tasks settings pane (#12).
 *
 * A scheduled task is a durable prompt the app runs on its own cron: at each due
 * time the main process pushes a "fire", the renderer opens a fresh session in the
 * task's mode and submits the prompt. This pane is the CRUD surface — list the
 * tasks with their next/last run, and host the add/edit form (name, cron, prompt,
 * mode, enabled). Persistence + the actual firing live in the main process
 * (scheduled-tasks-ipc + scheduler); this pane only talks to window.myto.
 *
 * Kept close to Claude Desktop's scheduled-tasks UX: a card per task, an enable
 * toggle, a "Run now" that fires once without touching the schedule, and a plain
 * cron field with a few one-click presets so a user needn't memorise the syntax.
 */

/** Common schedules, one click away — the label doubles as the cron's plain-English gloss. */
const CRON_PRESETS: ReadonlyArray<{ cron: string; label: string }> = [
  { cron: '0 9 * * *', label: 'Every day · 9:00 AM' },
  { cron: '0 9 * * 1-5', label: 'Weekdays · 9:00 AM' },
  { cron: '0 * * * *', label: 'Every hour' },
  { cron: '30 8 * * 1', label: 'Mondays · 8:30 AM' },
  { cron: '0 0 1 * *', label: 'Monthly · 1st, 12:00 AM' }
]

const MODE_OPTIONS: ReadonlyArray<{ id: ChatMode; label: string; hint: string }> = [
  { id: 'chat', label: 'Chat', hint: 'A normal conversation' },
  { id: 'cowork', label: 'Build', hint: 'Agentic — reads and writes files in a folder' }
]

/**
 * A cheap client-side sanity check (5 space-separated fields, each only cron
 * characters). The authoritative parse lives in the main process (parseCron); a
 * bad expression there rejects the save, which the form surfaces as an error.
 */
function looksLikeCron(expr: string): boolean {
  const fields = expr.trim().split(/\s+/)
  return fields.length === 5 && fields.every((f) => /^[\d*/,-]+$/.test(f))
}

/** A known preset's label, or a neutral gloss for a hand-written expression. */
function describeCron(expr: string): string {
  return CRON_PRESETS.find((p) => p.cron === expr.trim())?.label ?? 'Custom schedule'
}

/** Format an epoch-ms stamp (or null) as a short local date-time. */
function fmtTime(ms: number | null): string {
  if (ms == null) return '—'
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

/** The add/edit form for one scheduled task. */
function TaskForm({
  initial,
  onCancel,
  onSaved
}: {
  initial: ScheduledTask | null
  onCancel: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [cron, setCron] = useState(initial?.cron ?? '0 9 * * *')
  const [prompt, setPrompt] = useState(initial?.prompt ?? '')
  const [mode, setMode] = useState<ChatMode>(initial?.mode ?? 'chat')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const cronOk = looksLikeCron(cron)
  const canSubmit = prompt.trim().length > 0 && cronOk

  const onSave = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      const input = { name: name.trim(), prompt: prompt.trim(), cron: cron.trim(), mode }
      if (initial) await window.myto.scheduledTasks.update(initial.id, input)
      else await window.myto.scheduledTasks.create({ ...input, enabled: true })
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the task.')
    } finally {
      setSaving(false)
    }
  }

  const field =
    'w-full rounded-lg border border-border bg-bg px-3 py-2 text-[13px] text-text placeholder:text-muted focus:border-primary focus:outline-none'
  const label = 'mb-1 block text-[12px] font-medium text-text'

  return (
    <div className="space-y-4 rounded-xl border border-border bg-bg p-4">
      <div>
        <label className={label}>Prompt</label>
        <textarea
          className={field}
          rows={3}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="What should Myto do each time this runs? e.g. Summarise today's git commits."
        />
        <p className="mt-1 text-[11px] text-muted">
          Runs in its own fresh session — it can't see this conversation.
        </p>
      </div>

      <div>
        <label className={label}>Name (optional)</label>
        <input
          className={field}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Defaults to the first line of the prompt"
        />
      </div>

      <div>
        <span className={label}>Schedule</span>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {CRON_PRESETS.map((p) => {
            const active = p.cron === cron.trim()
            return (
              <button
                key={p.cron}
                type="button"
                onClick={() => setCron(p.cron)}
                className={
                  'rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ' +
                  (active
                    ? 'border-primary bg-primary/10 text-text'
                    : 'border-border text-muted hover:border-muted hover:text-text')
                }
              >
                {p.label}
              </button>
            )
          })}
        </div>
        <input
          className={field + ' font-mono'}
          value={cron}
          onChange={(e) => setCron(e.target.value)}
          placeholder="min hour day-of-month month day-of-week"
          aria-invalid={!cronOk}
        />
        <p className={'mt-1 text-[11px] ' + (cronOk ? 'text-muted' : 'text-rose-500')}>
          {cronOk
            ? `${describeCron(cron)} · standard 5-field cron, your local time`
            : 'Enter five space-separated cron fields, e.g. 0 9 * * 1-5'}
        </p>
      </div>

      <div>
        <span className={label}>Mode</span>
        <div className="grid grid-cols-2 gap-2">
          {MODE_OPTIONS.map((opt) => {
            const active = opt.id === mode
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => setMode(opt.id)}
                className={
                  'rounded-lg border px-2.5 py-2 text-left transition-colors ' +
                  (active ? 'border-primary bg-primary/10' : 'border-border bg-surface hover:border-muted')
                }
              >
                <div className="text-[12px] font-medium text-text">{opt.label}</div>
                <div className="mt-0.5 text-[11px] leading-tight text-muted">{opt.hint}</div>
              </button>
            )
          })}
        </div>
      </div>

      {error && (
        <div className="rounded-lg bg-rose-500/10 px-3 py-2 text-[12px] text-rose-500">{error}</div>
      )}

      <div className="flex items-center justify-end gap-2 pt-1">
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
          {saving ? 'Saving…' : initial ? 'Save changes' : 'Add task'}
        </button>
      </div>
    </div>
  )
}

/** One row in the scheduled-tasks list. */
function TaskRow({
  task,
  onEdit,
  onChanged
}: {
  task: ScheduledTask
  onEdit: () => void
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [ranAt, setRanAt] = useState<number | null>(null)

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  const runNow = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.myto.scheduledTasks.runNow(task.id)
      setRanAt(Date.now())
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-xl border border-border bg-bg p-3.5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-medium text-text">{task.name}</span>
            <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-muted">
              {task.mode === 'cowork' ? 'Build' : 'Chat'}
            </span>
            {!task.enabled && (
              <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-muted">
                Paused
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-[12px] text-muted">{task.prompt}</div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-muted">
            <span className="font-mono">{task.cron}</span>
            <span>{describeCron(task.cron)}</span>
            <span>Next: {task.enabled ? fmtTime(task.nextRunAt) : '—'}</span>
            <span>Last: {fmtTime(ranAt ?? task.lastRunAt)}</span>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => void runNow()}
              disabled={busy}
              className="rounded-md px-2 py-1 text-[11px] font-medium text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-40"
            >
              Run now
            </button>
            <button
              type="button"
              onClick={() => void run(() => window.myto.scheduledTasks.update(task.id, { enabled: !task.enabled }))}
              disabled={busy}
              className="rounded-md px-2 py-1 text-[11px] font-medium text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-40"
            >
              {task.enabled ? 'Pause' : 'Resume'}
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
              onClick={() => void run(() => window.myto.scheduledTasks.remove(task.id))}
              disabled={busy}
              className="rounded-md px-2 py-1 text-[11px] font-medium text-rose-500 transition-colors hover:bg-rose-500/10 disabled:opacity-40"
            >
              Remove
            </button>
          </div>
          {ranAt !== null && <span className="text-[11px] text-emerald-500">Started a run</span>}
        </div>
      </div>
    </div>
  )
}
/** The Scheduled tasks pane: list of tasks + add/edit form. */
export function ScheduledTasksPane() {
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [editing, setEditing] = useState<ScheduledTask | null>(null)
  const [adding, setAdding] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    setTasks(await window.myto.scheduledTasks.list())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const showForm = adding || editing !== null

  return (
    <div className="space-y-5">
      <p className="text-[12px] leading-relaxed text-muted">
        Scheduled tasks run a prompt on their own cron, even when you're not watching. Each run
        opens a fresh session in the task's mode — it can't see your other chats. Tasks fire only
        while Myto is running.
      </p>

      {tasks.length > 0 && (
        <div className="space-y-2.5">
          {tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              onEdit={() => {
                setAdding(false)
                setEditing(task)
              }}
              onChanged={() => void refresh()}
            />
          ))}
        </div>
      )}

      {showForm ? (
        <TaskForm
          initial={editing}
          onCancel={() => {
            setAdding(false)
            setEditing(null)
          }}
          onSaved={() => {
            setAdding(false)
            setEditing(null)
            void refresh()
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
          + Add scheduled task
        </button>
      )}
    </div>
  )
}
