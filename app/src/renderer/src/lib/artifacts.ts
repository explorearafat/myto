// Desktop-side artifacts vault: every piece of media a model produced for the
// user (image-gen, video-gen) is written to Firestore under their uid, and the
// same vault streams back — the website's /artifacts page and the Android
// app read the identical collection. See firestore.rules for the model
// (owner-only, base64 capped at ~900KB, larger media rides as a URL).

import {
  collection,
  deleteDoc,
  doc,
  getFirestore,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  where,
  addDoc,
  type Unsubscribe,
} from 'firebase/firestore';
import { app } from './firebase';

const db = getFirestore(app);

export interface CloudArtifact {
  id: string
  kind: 'image' | 'video' | 'svg' | 'document' | 'file'
  title: string
  mime: string
  dataBase64: string
  url: string
  source: string
  createdAtMs: number
}

/** Persist one generated media item under the user's uid. Fire-and-forget safe. */
export async function saveMediaArtifact(
  uid: string,
  media: { kind: 'image' | 'video'; mediaType: string; dataBase64?: string; url?: string; prompt?: string }
): Promise<void> {
  const data = media.dataBase64 ?? ''
  const url = media.url ?? ''
  if (data === '' && url === '') return
  if (data.length > 900_000) return // Firestore doc cap — larger media stays in chat only
  await addDoc(collection(db, 'artifacts'), {
    uid,
    kind: media.kind,
    title: (media.prompt ?? `${media.kind} artifact`).slice(0, 200),
    mime: media.mediaType.slice(0, 120),
    dataBase64: data,
    url,
    source: media.kind === 'video' ? 'video generation' : 'image generation',
    createdAt: serverTimestamp(),
  })
}

/** Live subscription to the user's artifact vault, newest first. */
export function streamArtifacts(
  uid: string,
  onData: (artifacts: CloudArtifact[]) => void,
  onError?: (e: unknown) => void
): Unsubscribe {
  const q = query(
    collection(db, 'artifacts'),
    where('uid', '==', uid),
    orderBy('createdAt', 'desc'),
    limit(100)
  )
  return onSnapshot(
    q,
    (snap) =>
      onData(
        snap.docs.map((d) => {
          const data = d.data()
          return {
            id: d.id,
            kind: (data.kind ?? 'file') as CloudArtifact['kind'],
            title: String(data.title ?? 'Artifact'),
            mime: String(data.mime ?? 'application/octet-stream'),
            dataBase64: String(data.dataBase64 ?? ''),
            url: String(data.url ?? ''),
            source: String(data.source ?? ''),
            createdAtMs: (data.createdAt as { toMillis?: () => number } | null)?.toMillis?.() ?? 0,
          }
        })
      ),
    (e) => onError?.(e)
  )
}

export function deleteArtifact(id: string): Promise<void> {
  return deleteDoc(doc(db, 'artifacts', id))
}
