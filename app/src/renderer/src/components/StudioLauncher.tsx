import { type ReactNode, useEffect, useState } from 'react'
import type { StudioMediaItem } from '@shared/types'
import { useEditorStore } from '../store/useEditorStore'

/**
 * The Studio launcher — a modal that lists the working folder's photos and videos and opens the
 * chosen one into the MANUAL editor. This is the user's entry point to editing by hand (the
 * agent opens edits itself via edit_photo/edit_video). Driven by `window.myto.editor.listMedia`
 * + `openPhoto`/`openVideo`; closing is non-destructive.
 */
export function StudioLauncher(): ReactNode {
  const open = useEditorStore((s) => s.launcherOpen)
  const close = useEditorStore((s) => s.closeLauncher)
  const startManual = useEditorStore((s) => s.startManual)
  const [items, setItems] = useState<StudioMediaItem[] | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let alive = true
    setItems(null)
    setError(null)
    window.myto.editor
      .listMedia()
      .then((list) => {
        if (alive) setItems(list)
      })
      .catch(() => {
        if (alive) setItems([])
      })
    return () => {
      alive = false
    }
  }, [open])

  if (!open) return null

  const choose = async (item: StudioMediaItem): Promise<void> => {
    setOpening(item.path)
    setError(null)
    try {
      const res =
        item.kind === 'photo'
          ? await window.myto.editor.openPhoto(item.path)
          : await window.myto.editor.openVideo(item.path)
      if (!res) {
        setError(`Could not open ${item.path}.`)
        return
      }
      startManual(item.kind, item.path, res)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setOpening(null)
    }
  }

  const photos = items?.filter((i) => i.kind === 'photo') ?? []
  const videos = items?.filter((i) => i.kind === 'video') ?? []

  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-center bg-black/50 p-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Open in Studio"
      onClick={close}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold text-text">Open in Studio</div>
            <div className="text-[11px] text-muted">Edit a photo or video by hand — or type a goal and let Myto finish it.</div>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-text"
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-3">
          {items === null && <div className="py-8 text-center text-[12px] text-muted">Scanning your working folder…</div>}
          {items !== null && items.length === 0 && (
            <div className="py-8 text-center text-[12px] text-muted">
              No photos or videos found in the working folder.
              <br />
              Pick a folder in Cowork settings, then drop images or clips into it.
            </div>
          )}
          {error && <div className="mb-2 rounded-md bg-red-500/10 px-3 py-2 text-[11px] text-red-500">{error}</div>}
          {photos.length > 0 && <MediaGroup title="Photos" items={photos} opening={opening} onChoose={choose} />}
          {videos.length > 0 && <MediaGroup title="Videos" items={videos} opening={opening} onChoose={choose} />}
        </div>
      </div>
    </div>
  )
}

function MediaGroup({
  title,
  items,
  opening,
  onChoose
}: {
  title: string
  items: StudioMediaItem[]
  opening: string | null
  onChoose: (item: StudioMediaItem) => void
}): ReactNode {
  return (
    <div className="mb-3">
      <div className="mb-1 px-1 text-[9px] uppercase tracking-wide text-muted">{title}</div>
      <div className="flex flex-col gap-0.5">
        {items.map((item) => (
          <button
            key={item.path}
            type="button"
            disabled={opening !== null}
            onClick={() => onChoose(item)}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-text transition-colors hover:bg-surface-2 disabled:opacity-50"
          >
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded bg-surface-2 text-[11px] text-muted">
              {item.kind === 'photo' ? '🖼' : '🎬'}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{item.path}</span>
            {opening === item.path && <span className="shrink-0 text-[10px] text-muted">Opening…</span>}
          </button>
        ))}
      </div>
    </div>
  )
}
