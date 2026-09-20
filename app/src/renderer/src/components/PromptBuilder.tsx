/**
 * PromptBuilder — The visual Prompt DNA canvas.
 *
 * A drag-and-drop interface for constructing prompts from modular blocks.
 * Users add, reorder, edit, and toggle blocks to build structured prompts
 * without writing raw text.
 */

import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { useState } from 'react'
import type { PromptBlock as PromptBlockType, PromptBlockType as BlockType } from '@shared/types/prompt-builder'
import { BLOCK_TEMPLATES, PROMPT_TEMPLATES } from '@shared/types/prompt-builder'
import { compilePrompt, activeBlockCount } from '@shared/prompt-compiler'
import { PromptBlock } from './PromptBlock'

interface PromptBuilderProps {
  blocks: PromptBlockType[]
  onChange: (blocks: PromptBlockType[]) => void
  onCompile: (prompt: string) => void
}

export function PromptBuilder({ blocks, onChange, onCompile }: PromptBuilderProps) {
  const [showTemplates, setShowTemplates] = useState(false)
  const [showAddMenu, setShowAddMenu] = useState(false)

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates
    })
  )

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return

    const oldIndex = blocks.findIndex((b) => b.id === active.id)
    const newIndex = blocks.findIndex((b) => b.id === over.id)

    const reordered = arrayMove(blocks, oldIndex, newIndex).map((block, idx) => ({
      ...block,
      order: idx
    }))

    onChange(reordered)
  }

  function addBlock(type: BlockType) {
    const newBlock: PromptBlockType = {
      id: `block-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      type,
      content: '',
      order: blocks.length,
      enabled: true,
      createdAt: Date.now()
    }
    onChange([...blocks, newBlock])
    setShowAddMenu(false)
  }

  function editBlock(id: string, content: string) {
    onChange(blocks.map((b) => (b.id === id ? { ...b, content } : b)))
  }

  function toggleBlock(id: string, enabled: boolean) {
    onChange(blocks.map((b) => (b.id === id ? { ...b, enabled } : b)))
  }

  function deleteBlock(id: string) {
    onChange(blocks.filter((b) => b.id !== id))
  }

  function loadTemplate(templateId: string) {
    const template = PROMPT_TEMPLATES.find((t) => t.id === templateId)
    if (!template) return

    const newBlocks: PromptBlockType[] = template.blocks.map((b, idx) => ({
      ...b,
      id: `block-${Date.now()}-${idx}`,
      createdAt: Date.now()
    }))

    onChange(newBlocks)
    setShowTemplates(false)
  }

  function handleCompile() {
    const compiled = compilePrompt(blocks)
    if (compiled) onCompile(compiled)
  }

  const activeCount = activeBlockCount(blocks)
  const canCompile = activeCount > 0

  return (
    <div className="prompt-builder">
      {/* Header: title + template button */}
      <div className="prompt-builder__header">
        <div className="prompt-builder__title">
          <span className="prompt-builder__icon">🧬</span>
          <span>Prompt DNA</span>
        </div>

        <button
          type="button"
          className="prompt-builder__template-btn"
          onClick={() => setShowTemplates(!showTemplates)}
        >
          📋 Templates
        </button>
      </div>

      {/* Template picker (collapsible) */}
      {showTemplates && (
        <div className="prompt-builder__templates">
          <div className="prompt-builder__templates-header">
            <span>Choose a template</span>
            <button type="button" onClick={() => setShowTemplates(false)}>
              ×
            </button>
          </div>
          <div className="prompt-builder__templates-grid">
            {PROMPT_TEMPLATES.map((template) => (
              <button
                key={template.id}
                type="button"
                className="prompt-template-card"
                onClick={() => loadTemplate(template.id)}
              >
                <div className="prompt-template-card__name">{template.name}</div>
                <div className="prompt-template-card__desc">{template.description}</div>
                <div className="prompt-template-card__blocks">
                  {template.blocks.length} block{template.blocks.length === 1 ? '' : 's'}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Canvas: draggable blocks */}
      <div className="prompt-builder__canvas">
        {blocks.length === 0 ? (
          <div className="prompt-builder__empty">
            <p>No blocks yet. Add one to start building your prompt.</p>
          </div>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={blocks.map((b) => b.id)} strategy={verticalListSortingStrategy}>
              {blocks.map((block) => (
                <PromptBlock
                  key={block.id}
                  block={block}
                  onEdit={editBlock}
                  onToggle={toggleBlock}
                  onDelete={deleteBlock}
                />
              ))}
            </SortableContext>
          </DndContext>
        )}
      </div>

      {/* Add block menu */}
      <div className="prompt-builder__add">
        {showAddMenu ? (
          <div className="prompt-builder__add-menu">
            <div className="prompt-builder__add-menu-header">
              <span>Add a block</span>
              <button type="button" onClick={() => setShowAddMenu(false)}>
                ×
              </button>
            </div>
            <div className="prompt-builder__add-menu-grid">
              {(Object.keys(BLOCK_TEMPLATES) as BlockType[]).map((type) => {
                const template = BLOCK_TEMPLATES[type]
                return (
                  <button
                    key={type}
                    type="button"
                    className="prompt-block-type-card"
                    onClick={() => addBlock(type)}
                  >
                    <span className="prompt-block-type-card__icon">{template.icon}</span>
                    <span className="prompt-block-type-card__label">{template.label}</span>
                    <span className="prompt-block-type-card__desc">{template.description}</span>
                  </button>
                )
              })}
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="prompt-builder__add-btn"
            onClick={() => setShowAddMenu(true)}
          >
            + Add block
          </button>
        )}
      </div>

      {/* Footer: status + compile button */}
      <div className="prompt-builder__footer">
        <span className="prompt-builder__status">
          {activeCount === 0
            ? 'No active blocks'
            : `${activeCount} block${activeCount === 1 ? '' : 's'} active`}
        </span>

        <button
          type="button"
          className="prompt-builder__compile-btn"
          onClick={handleCompile}
          disabled={!canCompile}
        >
          ✨ Use this prompt
        </button>
      </div>
    </div>
  )
}
