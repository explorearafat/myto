import { useEffect, useState } from 'react'
import type { Project, ProjectKnowledge } from '@shared/types'
import { useProjectStore } from '@renderer/store/useProjectStore'

/**
 * Project dialog: create mode (name only) or edit mode (name, custom
 * instructions, long-term memory, and knowledge docs). Instructions, memory, and
 * knowledge are injected into the engine's system prompt whenever a chat runs
 * under this project (see buildProjectPreamble in the workflow engine). Memory is
 * normally grown by Myto via the `remember` tool; here it can be edited/cleared.
 */
export function ProjectDialog({
  project,
  onClose
}: {
  /** The project being edited, or `null` when creating a new one. */
  project: Project | null
  onClose: () => void
}) {
  const projects = useProjectStore((s) => s.projects)
  const create = useProjectStore((s) => s.create)
  const rename = useProjectStore((s) => s.rename)
  const setInstructions = useProjectStore((s) => s.setInstructions)
  const setMemory = useProjectStore((s) => s.setMemory)
  const loadKnowledge = useProjectStore((s) => s.loadKnowledge)
  const addKnowledge = useProjectStore((s) => s.addKnowledge)
  const removeKnowledge = useProjectStore((s) => s.removeKnowledge)

  const editing = project !== null
  const [name, setName] = useState(project?.name ?? '')
  const [instructions, setInstructionsDraft] = useState(project?.instructions ?? '')
  const [memory, setMemoryDraft] = useState(project?.memory ?? '')
  const [knowledge, setKnowledge] = useState<ProjectKnowledge[]>([])
  const [docName, setDocName] = useState('')
  const [docContent, setDocContent] = useState('')
  const [saved, setSaved] = useState(false)

  // Load knowledge docs when a project is opened for editing.
  useEffect(() => {
    if (project) {
      void loadKnowledge(project.id).then(() =>
        setKnowledge(useProjectStore.getState().knowledge)
      )
    }
  }, [project, loadKnowledge])

  const handleSave = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed) return
    if (editing && project) {
      if (trimmed !== project.name) await rename(project.id, trimmed)
      if (instructions !== project.instructions) {
        await setInstructions(project.id, instructions)
      }
      if (memory !== project.memory) {
        await setMemory(project.id, memory)
      }
    } else {
      await create(trimmed)
    }
    setSaved(true)
    setTimeout(() => onClose(), 350)
  }

  const handleAddDoc = async (): Promise<void> => {
    const n = docName.trim()
    const c = docContent.trim()
    if (!editing || !project || !n || !c) return
    await addKnowledge(project.id, n, c)
    setDocName('')
    setDocContent('')
    setKnowledge(useProjectStore.getState().knowledge)
  }

  const handleRemoveDoc = async (id: string): Promise<void> => {
    if (!editing || !project) return
    if (confirm('Remove this knowledge doc? The project keeps its other docs.')) {
      await removeKnowledge(project.id, id)
      setKnowledge(useProjectStore.getState().knowledge)
    }
  }

  const projectCount = editing ? project?.sessionCount ?? 0 : null

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/50 p-6 backdrop-blur-sm">
      <div className="flex max-h-full w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <div>
            <h2 className="text-[15px] font-semibold text-text">
              {editing ? project?.name : 'New project'}
            </h2>
            <p className="text-[12px] text-muted">
              {editing
                ? `Custom instructions and knowledge feed every chat in this project. · ${projectCount ?? 0} chat${projectCount === 1 ? '' : 's'}`
                : 'Group chats and give the assistant shared context.'}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close project dialog"
            onClick={onClose}
            className="grid h-8 w-8 place-items-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-text"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted">
              Project name
            </span>
            <input
              type="text"
              value={name}
              placeholder="e.g. Website redesign"
              spellCheck={false}
              onChange={(e) => setName(e.target.value)}
              className="rounded-md border border-border bg-bg px-3 py-2 text-[13px] text-text outline-none transition-colors placeholder:text-muted/60 focus:border-primary/70"
            />
          </label>

          {editing && (
            <>
              <label className="flex flex-col gap-1.5">
                <span className="text-[11px] font-medium uppercase tracking-wider text-muted">
                  Instructions
                </span>
                <textarea
                  value={instructions}
                  rows={4}
                  placeholder="e.g. Use the company's design tokens; keep TypeScript strict; write tests for every change…"
                  spellCheck={false}
                  onChange={(e) => setInstructionsDraft(e.target.value)}
                  className="resize-none rounded-md border border-border bg-bg px-3 py-2 text-[13px] text-text outline-none transition-colors placeholder:text-muted/60 focus:border-primary/70"
                />
              </label>

              {/* Long-term memory: what Myto has learned across this project's
                  chats. Appended to automatically via the `remember` tool and
                  editable/clearable here. */}
              <label className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium uppercase tracking-wider text-muted">
                    Memory
                  </span>
                  {memory.trim() && (
                    <button
                      type="button"
                      onClick={() => setMemoryDraft('')}
                      className="text-[11px] text-muted transition-colors hover:text-red-400"
                    >
                      Clear
                    </button>
                  )}
                </div>
                <textarea
                  value={memory}
                  rows={4}
                  placeholder="Myto writes what it learns about this project here as you chat. You can edit or clear it."
                  spellCheck={false}
                  onChange={(e) => setMemoryDraft(e.target.value)}
                  className="resize-none rounded-md border border-border bg-bg px-3 py-2 text-[13px] text-text outline-none transition-colors placeholder:text-muted/60 focus:border-primary/70"
                />
                <span className="text-[11px] text-muted">
                  Fed into every chat in this project, alongside instructions and knowledge.
                </span>
              </label>

              {/* Knowledge docs */}
              <section className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium uppercase tracking-wider text-muted">
                    Knowledge
                  </span>
                  <span className="text-[11px] text-muted">
                    {knowledge.length} doc{knowledge.length === 1 ? '' : 's'}
                  </span>
                </div>

                {knowledge.length > 0 && (
                  <div className="space-y-1.5">
                    {knowledge.map((doc) => (
                      <div
                        key={doc.id}
                        className="group flex items-center gap-2 rounded-md border border-border bg-bg px-3 py-2"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[12px] font-medium text-text">{doc.name}</div>
                          <div className="truncate text-[11px] text-muted">
                            {doc.content.length > 120 ? doc.content.slice(0, 120) + '…' : doc.content}
                          </div>
                        </div>
                        <button
                          type="button"
                          aria-label="Remove knowledge doc"
                          onClick={() => void handleRemoveDoc(doc.id)}
                          className="grid h-6 w-6 shrink-0 place-items-center rounded text-muted transition-colors hover:bg-red-500/20 hover:text-red-400"
                        >
                          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                            <path d="M3 4h10M6 4V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1M4 4h8v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4Z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="space-y-2 rounded-md border border-dashed border-border p-3">
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] text-muted">Doc name</span>
                    <input
                      type="text"
                      value={docName}
                      placeholder="e.g. Design tokens"
                      spellCheck={false}
                      onChange={(e) => setDocName(e.target.value)}
                      className="rounded-md border border-border bg-bg px-3 py-1.5 text-[12px] text-text outline-none placeholder:text-muted/60 focus:border-primary/70"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] text-muted">Content</span>
                    <textarea
                      value={docContent}
                      rows={2}
                      placeholder="Paste a spec, notes, or reference the assistant should know."
                      spellCheck={false}
                      onChange={(e) => setDocContent(e.target.value)}
                      className="resize-none rounded-md border border-border bg-bg px-3 py-1.5 text-[12px] text-text outline-none placeholder:text-muted/60 focus:border-primary/70"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => void handleAddDoc()}
                    disabled={!docName.trim() || !docContent.trim()}
                    className="w-full rounded-md border border-primary/50 bg-primary/10 px-3 py-1.5 text-[12px] font-medium text-primary transition-colors hover:bg-primary/15 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Add doc
                  </button>
                </div>
              </section>
            </>
          )}
        </div>

        {/* Footer actions */}
        <div className="flex items-center justify-between border-t border-border px-5 py-3.5">
          <span className="text-[11px] text-muted">
            {editing
              ? projects.length > 0
                ? `${projects.length} project${projects.length === 1 ? '' : 's'} total`
                : ''
              : ''}
          </span>
          <div className="flex items-center gap-2">
            {saved && <span className="text-[12px] text-emerald-400">Saved</span>}
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-3.5 py-1.5 text-[13px] font-medium text-muted transition-colors hover:text-text"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={!name.trim()}
              className="rounded-md bg-primary px-4 py-1.5 text-[13px] font-semibold text-bg transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {editing ? 'Save changes' : 'Create project'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
