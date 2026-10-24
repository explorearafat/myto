// The Artifacts vault as a full-screen desktop overlay — every image, video
// clip, SVG, and document the models produced for this account, streamed from
// Firestore. The rail's Artifacts row opens it; the website's /artifacts page
// and the Android app read the identical collection.

import { useEffect, useMemo, useState } from 'react'
import { useAuthUser } from '@renderer/lib/useAuthUser'
import {
  deleteArtifact,
  streamArtifacts,
  type CloudArtifact,
} from '@renderer/lib/artifacts'

function when(ms: number): string {
  if (!ms) return 'just now'
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function ArtifactTile({
  artifact,
  onDelete,
}: {
  artifact: CloudArtifact
  onDelete: (a: CloudArtifact) => void
}) {
  const dataUrl = artifact.dataBase64
    ? `data:${artifact.mime};base64,${artifact.dataBase64}`
    : artifact.url
  const isImage = artifact.kind === 'image' || artifact.mime.startsWith('image/')
  const isVideo = artifact.kind === 'video' || artifact.mime.startsWith('video/')

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      {isImage && dataUrl ? (
        <img src={dataUrl} alt={artifact.title} className="h-44 w-full object-cover" />
      ) : isVideo && dataUrl ? (
        <video src={dataUrl} controls className="h-44 w-full bg-black object-contain" />
      ) : isVideo && artifact.url ? (
        <video src={artifact.url} controls className="h-44 w-full bg-black object-contain" />
      ) : (
        <div className="grid h-24 w-full place-items-center bg-surface-2/60 text-[13px] text-muted">
          {artifact.kind}
        </div>
      )}
      <div className="p-3">
        <p className="truncate text-[13px] font-medium text-text" title={artifact.title}>
          {artifact.title}
        </p>
        <p className="mt-0.5 text-[11px] text-muted">{when(artifact.createdAtMs)}</p>
        <div className="mt-2.5 flex items-center gap-2">
          <a
            href={dataUrl || artifact.url}
            download={`${artifact.title.replace(/[^\w.-]+/g, '_')}.${artifact.mime.split('/')[1] ?? 'bin'}`}
            className="rounded-full border border-border px-3 py-1 text-[11.5px] font-medium text-muted no-underline transition-colors hover:border-primary/40 hover:text-text"
          >
            Download
          </a>
          <a
            href={artifact.url || dataUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-full px-2 py-1 text-[11.5px] text-muted transition-colors hover:text-text"
          >
            Open
          </a>
          <button
            type="button"
            onClick={() => onDelete(artifact)}
            className="ml-auto rounded-full px-2 py-1 text-[11.5px] text-muted transition-colors hover:text-red-500"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}

export function ArtifactsOverlay({ onClose }: { onClose: () => void }) {
  const user = useAuthUser()
  const uid = user?.uid ?? ''
  const [artifacts, setArtifacts] = useState<CloudArtifact[] | null>(null)

  useEffect(() => {
    if (!uid) return
    return streamArtifacts(uid, setArtifacts, () => setArtifacts([]))
  }, [uid])

  const imageCount = useMemo(
    () => (artifacts ?? []).filter((a) => a.kind === 'image').length,
    [artifacts]
  )

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-bg/95 backdrop-blur-sm">
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <div className="flex items-center gap-2.5">
          <span className="grid h-6 w-6 place-items-center rounded-full bg-primary/15 text-primary">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
              <rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
              <rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
              <rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
            </svg>
          </span>
          <h1 className="text-[15px] font-semibold text-text">Artifacts</h1>
          <span className="text-[12px] text-muted">
            {artifacts == null ? '' : `${artifacts.length} items · ${imageCount} images`}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-full px-3 py-1.5 text-[12.5px] text-muted transition-colors hover:bg-surface-2 hover:text-text"
        >
          Close
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {artifacts == null ? (
          <p className="py-10 text-center text-[13px] text-muted">Loading the vault…</p>
        ) : artifacts.length === 0 ? (
          <div className="py-16 text-center">
            <p className="text-[14px] text-text">Nothing here yet.</p>
            <p className="mx-auto mt-2 max-w-[46ch] text-[12.5px] leading-relaxed text-muted">
              Every image or video a model generates in your chats is saved to this vault
              automatically — and syncs to the website and the Android app.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {artifacts.map((a) => (
              <ArtifactTile
                key={a.id}
                artifact={a}
                onDelete={(x) => void deleteArtifact(x.id).catch(() => {})}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
