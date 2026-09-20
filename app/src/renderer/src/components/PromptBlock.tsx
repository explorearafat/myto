/**
 * PromptBlock — A single draggable, editable block in the Prompt DNA canvas.
 *
 * Each block represents one aspect of the prompt (context, task, constraints, etc.).
 * The block can be reordered via drag-and-drop, toggled on/off, edited, and deleted.
 */

import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { PromptBlock as PromptBlockType } from '@shared/types/prompt-builder'
import { BLOCK_TEMPLATES } from '@shared/types/prompt-builder'

interface PromptBlockProps {
  block: PromptBlockType
  onEdit: (id: string, content: string) => void
  onToggle: (id: string, enabled: boolean) => void
  onDelete: (id: string) => void
}

export function PromptBlock({ block, onEdit, onToggle, onDelete }: PromptBlockProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: block.id
  })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1
  }

  const template = BLOCK_TEMPLATES[block.type]
  const isEmpty = block.content.trim().length === 0

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`prompt-block ${!block.enabled ? 'prompt-block--disabled' : ''}`}
      data-type={block.type}
    >
      {/* Header: icon, label, drag handle, delete */}
      <div className="prompt-block__header">
        <div className="prompt-block__drag" {...attributes} {...listeners}>
          <svg width="12" height="16" viewBox="0 0 12 16" fill="currentColor">
            <circle cx="3" cy="3" r="1.5" />
            <circle cx="9" cy="3" r="1.5" />
            <circle cx="3" cy="8" r="1.5" />
            <circle cx="9" cy="8" r="1.5" />
            <circle cx="3" cy="13" r="1.5" />
            <circle cx="9" cy="13" r="1.5" />
          </svg>
        </div>

        <span className="prompt-block__icon" aria-hidden="true">
          {template.icon}
        </span>
        <span className="prompt-block__label">{template.label}</span>

        <button
          type="button"
          className="prompt-block__delete"
          onClick={() => onDelete(block.id)}
          aria-label={`Delete ${template.label} block`}
        >
          ×
        </button>
      </div>

      {/* Content textarea */}
      <textarea
        className="prompt-block__textarea"
        value={block.content}
        onChange={(e) => onEdit(block.id, e.target.value)}
        placeholder={template.placeholder}
        rows={3}
        disabled={!block.enabled}
      />

      {/* Footer: toggle & character count */}
      <div className="prompt-block__footer">
        <label className="prompt-block__toggle">
          <input
            type="checkbox"
            checked={block.enabled}
            onChange={(e) => onToggle(block.id, e.target.checked)}
          />
          <span>Include in prompt</span>
        </label>

        {!isEmpty && block.enabled && (
          <span className="prompt-block__count" aria-live="polite">
            {block.content.length} chars
          </span>
        )}
      </div>
    </div>
  )
}
