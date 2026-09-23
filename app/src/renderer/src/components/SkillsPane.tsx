import { useState } from 'react'
import type { SkillConfig } from '@shared/types'
import { useAppStore } from '@renderer/store/useAppStore'

/*
 * The Skills settings pane.
 *
 * A skill is a reusable instruction pack (name + description + full instructions).
 * The model sees each enabled skill's description in its tool list and calls the
 * skill to load the instructions when a task matches — Claude-style progressive
 * disclosure. Skills are ordinary settings, so saving here persists through the
 * normal store; the main process re-registers the skill tools on save.
 */

function newId(): string {
  return `skill_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

/** The add/edit form for one skill. */
function SkillForm({
  initial,
  onDone
}: {
  initial: SkillConfig | null
  onDone: () => void
}) {
  const saveSkill = useAppStore((s) => s.saveSkill)
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [instructions, setInstructions] = useState(initial?.instructions ?? '')
  const [saving, setSaving] = useState(false)

  const canSubmit = name.trim().length > 0 && instructions.trim().length > 0

  const onSave = async (): Promise<void> => {
    setSaving(true)
    try {
      await saveSkill({
        id: initial?.id ?? newId(),
        name: name.trim(),
        description: description.trim(),
        instructions: instructions.trim(),
        enabled: initial?.enabled ?? true
      })
      onDone()
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
        <label className={label}>Name</label>
        <input
          className={field}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Code review, Release notes, SQL migrations"
        />
      </div>
      <div>
        <label className={label}>When to use it</label>
        <input
          className={field}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="One line — the model reads this to decide when the skill applies."
        />
      </div>
      <div>
        <label className={label}>Instructions</label>
        <textarea
          className={field + ' font-mono leading-relaxed'}
          rows={8}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder={'The full playbook the model follows when it uses this skill.\nSteps, conventions, examples, gotchas — whatever helps it do the task well.'}
        />
        <p className="mt-1 text-[11px] text-muted">
          Loaded into context only when the model invokes the skill, so it can be as
          detailed as you like.
        </p>
      </div>
      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onDone}
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
          {saving ? 'Saving…' : initial ? 'Save changes' : 'Add skill'}
        </button>
      </div>
    </div>
  )
}

/** One row in the skills list. */
function SkillRow({ skill, onEdit }: { skill: SkillConfig; onEdit: () => void }) {
  const saveSkill = useAppStore((s) => s.saveSkill)
  const removeSkill = useAppStore((s) => s.removeSkill)
  const [busy, setBusy] = useState(false)

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-xl border border-border bg-bg p-3.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-medium text-text">{skill.name}</span>
            {!skill.enabled && (
              <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-muted">
                Off
              </span>
            )}
          </div>
          {skill.description && (
            <div className="mt-0.5 truncate text-[12px] text-muted">{skill.description}</div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => void run(() => saveSkill({ ...skill, enabled: !skill.enabled }))}
            disabled={busy}
            className="rounded-md px-2 py-1 text-[11px] font-medium text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-40"
          >
            {skill.enabled ? 'Disable' : 'Enable'}
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
            onClick={() => void run(() => removeSkill(skill.id))}
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

/** The Skills pane: list of skills + add/edit form. */
export function SkillsPane() {
  const skills = useAppStore((s) => s.settings.skills)
  const toolsEnabled = useAppStore((s) => s.settings.tools.enabled)
  const [editing, setEditing] = useState<SkillConfig | null>(null)
  const [adding, setAdding] = useState(false)
  const showForm = adding || editing !== null

  return (
    <div className="space-y-5">
      {!toolsEnabled && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3.5 py-3 text-[12px] leading-relaxed text-amber-500">
          Tool use is turned off, so skills won't be offered to Myto. Turn it on in Settings →
          Tools to use your skills.
        </div>
      )}

      <p className="text-[12px] leading-relaxed text-muted">
        Skills are reusable instruction packs. Give one a clear description of when it applies and
        a detailed playbook; Myto pulls in the full instructions on its own when a task matches —
        so your conventions and know-how travel with it, without cluttering every chat.
      </p>

      {skills.length > 0 && (
        <div className="space-y-2.5">
          {skills.map((skill) => (
            <SkillRow
              key={skill.id}
              skill={skill}
              onEdit={() => {
                setAdding(false)
                setEditing(skill)
              }}
            />
          ))}
        </div>
      )}

      {showForm ? (
        <SkillForm
          initial={editing}
          onDone={() => {
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
          + Add skill
        </button>
      )}
    </div>
  )
}
