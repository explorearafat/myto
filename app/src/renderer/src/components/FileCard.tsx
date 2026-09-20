import { useState, type ReactNode } from 'react'
import { basename, type FileSegment } from '../lib/fileBlocks'
import { fileTypeFor, FileIcon } from '../lib/fileTypes'
import { CodeBody } from './Markdown'

/**
 * Renders one generated file as a downloadable card — the deliverable UX the
 * desktop app shows in place of a bare fenced code block. The header carries the
 * language's real brand logo, the file path, and a type badge (e.g. `HTML`); the
 * body (collapsed by default) is the syntax-highlighted source; and each card has
 * its own Download button that writes just that file via a native Save As.
 *
 * While the file is still streaming in (`complete: false`), the card shows a
 * shimmering "Writing…" and disables Download until the closing fence arrives —
 * the parser flips `complete` to true and the card settles into its saved state.
 * Purely presentational: the raw Markdown the model sent is what gets persisted.
 */

type SaveState = 'idle' | 'saving' | 'saved' | 'canceled' | 'error'

/** A compact icon button matching the transcript's other action buttons. */
function CardButton({
  label,
  onClick,
  disabled,
  children
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: ReactNode
}): ReactNode {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid h-6 w-6 place-items-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  )
}

/** A check mark — shared by the Copy and Download "done" states. */
function CheckIcon(): ReactNode {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3 8.5l3 3 7-7"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function FileCard({ file }: { file: FileSegment }): ReactNode {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('idle')

  const type = fileTypeFor(file.path)
  // The model's info-line language wins (it chose it); fall back to the mapping.
  const hljsLang = file.lang || type.hljs

  const copy = (): void => {
    void navigator.clipboard.writeText(file.code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }

  const download = (): void => {
    if (!file.complete) return
    setSaveState('saving')
    void window.sylor.files
      .save(basename(file.path), file.code)
      .then((res) => {
        if (res.ok) setSaveState('saved')
        else if ('canceled' in res) setSaveState('canceled')
        else setSaveState('error')
      })
      .catch(() => setSaveState('error'))
      .finally(() => setTimeout(() => setSaveState('idle'), 1600))
  }

  const downloadLabel =
    saveState === 'saved'
      ? 'Saved'
      : saveState === 'canceled'
        ? 'Canceled'
        : saveState === 'error'
          ? 'Save failed'
          : file.complete
            ? 'Download'
            : 'Writing…'

  return (
    <div className="my-3 overflow-hidden rounded-lg border border-border/70 bg-surface/40">
      <div className="flex items-center gap-1 px-2.5 py-1.5">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded text-left"
        >
          <FileIcon path={file.path} size={16} />
          <span className="truncate font-mono text-[12px] text-text">{file.path}</span>
          {file.complete ? (
            <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[9px] font-medium uppercase tracking-wide text-muted">
              {type.badge}
            </span>
          ) : (
            <span className="sylor-thinking shrink-0 text-[10px] font-medium">Writing…</span>
          )}
        </button>

        <CardButton label={copied ? 'Copied' : 'Copy'} onClick={copy}>
          {copied ? (
            <CheckIcon />
          ) : (
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="5" y="5" width="8.5" height="8.5" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
              <path
                d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5"
                stroke="currentColor"
                strokeWidth="1.3"
              />
            </svg>
          )}
        </CardButton>

        <CardButton label={downloadLabel} onClick={download} disabled={!file.complete || saveState === 'saving'}>
          {saveState === 'saved' ? (
            <CheckIcon />
          ) : (
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M8 2v7.5M8 9.5L5 6.5M8 9.5l3-3M2.5 11v1.5A1.5 1.5 0 0 0 4 14h8a1.5 1.5 0 0 0 1.5-1.5V11"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </CardButton>

        <CardButton label={expanded ? 'Collapse' : 'Expand'} onClick={() => setExpanded((v) => !v)}>
          <svg
            width="13"
            height="13"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
            className={'transition-transform ' + (expanded ? 'rotate-180' : '')}
          >
            <path
              d="M4 6l4 4 4-4"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </CardButton>
      </div>

      {expanded && (
        <div className="border-t border-border/70">
          <CodeBody code={file.code} lang={hljsLang} />
        </div>
      )}
    </div>
  )
}
