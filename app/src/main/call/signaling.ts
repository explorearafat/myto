/**
 * Call signaling over Firestore REST.
 *
 * The call document (`users/{uid}/calls/{callId}`) carries the lifecycle; the
 * `signals` subcollection carries WebRTC payloads (offer / answer / ICE). The
 * desktop can't hold a real Firestore snapshot listener over REST, so it polls:
 * fast (400ms) while a call is negotiating, slow (2.5s) while idle. Once the
 * data channel is open, ALL live traffic moves to WebRTC and the pollers are
 * only for hangup/keepalive — so the polling cost is negligible in steady state.
 *
 * Firestore rules make both paths owner-only; every request rides the
 * renderer's authenticated ID token.
 */
import type { CallAuth } from './auth-flow'
import type { RestValue } from './firestore-rest'
import type { CallDoc, SignalDoc } from './types'

const IDLE_POLL_MS = 2_500
const NEGOTIATION_POLL_MS = 400

/** Decode a REST call doc's fields into the typed shape. */
export function callDocFrom(fields: Record<string, unknown>): CallDoc | null {
  if (typeof fields.uid !== 'string' || typeof fields.dir !== 'string') return null
  return {
    uid: fields.uid,
    dir: fields.dir as CallDoc['dir'],
    state: (fields.state ?? 'ringing') as CallDoc['state'],
    ts: Number(fields.ts ?? 0),
    acceptedAt: fields.acceptedAt === null || fields.acceptedAt === undefined ? undefined : Number(fields.acceptedAt),
    endedAt: fields.endedAt === null || fields.endedAt === undefined ? undefined : Number(fields.endedAt),
    outcome: fields.outcome as CallDoc['outcome'] | undefined,
    deviceName: fields.deviceName as string | undefined,
    taskRef: fields.taskRef as string | undefined,
    summary: fields.summary as string | undefined,
    detail: fields.detail as string | undefined
  }
}

export function signalDocFrom(id: string, fields: Record<string, unknown>): SignalDoc | null {
  if (typeof fields.kind !== 'string') return null
  return {
    from: fields.from === 'mobile' ? 'mobile' : 'desktop',
    seq: Number(fields.seq ?? id),
    kind: fields.kind as SignalDoc['kind'],
    payload: typeof fields.payload === 'string' ? fields.payload : JSON.stringify(fields.payload ?? null),
    ts: Number(fields.ts ?? 0)
  }
}

/** Create the call document (desktop side only ever does this for callbacks). */
export async function createCallDoc(
  auth: CallAuth,
  callId: string,
  doc: Omit<CallDoc, 'uid'>
): Promise<void> {
  const uid = auth.rest.getUid()
  if (!uid) throw new Error('call-auth: not signed in')
  await auth.rest.setDoc(`users/${uid}/calls/${callId}`, { uid, ...doc } as unknown as Record<string, never>)
}

/** Merge-write lifecycle fields onto a call document. */
export async function patchCallDoc(
  auth: CallAuth,
  callId: string,
  patch: Partial<CallDoc>
): Promise<void> {
  const uid = auth.rest.getUid()
  if (!uid) throw new Error('call-auth: not signed in')
  await auth.rest.patchDoc(
    `users/${uid}/calls/${callId}`,
    patch as unknown as Record<string, never>
  )
}

export async function getCallDoc(auth: CallAuth, callId: string): Promise<CallDoc | null> {
  const uid = auth.rest.getUid()
  if (!uid) return null
  const doc = await auth.rest.getDoc(`users/${uid}/calls/${callId}`)
  return doc ? callDocFrom(doc.fields) : null
}

/**
 * Signal document id: per-sender namespace + ZERO-PADDED sequence. Firestore
 * lists documents in lexicographic id order — without the pad, `sig-d-10`
 * sorts BEFORE `sig-d-2` and the 10th+ ICE candidate would arrive ahead of
 * the answer, where WebRTC drops it. Exported pure for the unit tests.
 */
export function signalDocId(sender: 'desktop' | 'mobile', seq: number): string {
  return `sig-${sender === 'desktop' ? 'd' : 'm'}-${String(seq).padStart(4, '0')}`
}

/**
 * Append one desktop signaling message. Each sender owns its own id namespace
 * and the sequence is zero-padded (see {@link signalDocId}).
 */
export async function pushSignal(
  auth: CallAuth,
  callId: string,
  sig: Omit<SignalDoc, 'seq' | 'ts'>
): Promise<void> {
  const uid = auth.rest.getUid()
  if (!uid) throw new Error('call-auth: not signed in')
  const existing = await auth.rest
    .listDocs(`users/${uid}/calls/${callId}/signals`, 299)
    .catch(() => [])
  const mine = existing.filter((d) => d.id.startsWith('sig-d-')).length
  await auth.rest.setDoc(
    `users/${uid}/calls/${callId}/signals/${signalDocId('desktop', mine)}`,
    {
      from: sig.from,
      seq: mine,
      kind: sig.kind,
      payload: sig.payload,
      ts: Date.now()
    } as unknown as Record<string, never>
  )
}

/**
 * Poll for signals on a call that the caller hasn't seen yet, invoking
 * `onSignal` for each new one. `seenIds` is the caller's per-call bookkeeping
 * (signal ids already handled) — passed in so polls are stateless and idempotent.
 */
export async function pollSignals(
  auth: CallAuth,
  callId: string,
  seenIds: Set<string>,
  onSignal: (sig: SignalDoc) => void
): Promise<void> {
  const uid = auth.rest.getUid()
  if (!uid) return
  const docs = await auth.rest
    .listDocs(`users/${uid}/calls/${callId}/signals`, 199)
    .catch(() => [] as Array<{ id: string; fields: Record<string, unknown> }>)
  const signals = docs
    .filter((d) => !seenIds.has(d.id))
    .map((d) => ({ id: d.id, sig: signalDocFrom(d.id, d.fields) }))
    .filter((e): e is { id: string; sig: SignalDoc } => e.sig !== null)
    .sort((a, b) => a.sig.ts - b.sig.ts || a.sig.seq - b.sig.seq)
  for (const { id, sig } of signals) {
    seenIds.add(id)
    onSignal(sig)
  }
}

/**
 * The structured query for the desktop's live-call poll. Exported pure so the
 * unit tests can assert its shape: `state IN (ringing, incoming, accepted)`
 * — a runQuery because REST's plain document LIST has no orderBy and returns
 * documents in lexicographic id order; once history grows past one page, a
 * brand-new ringing call (highest id) would never appear in the list.
 */
export function buildLiveCallsQuery(): Record<string, RestValue> {
  return {
    from: [{ collectionId: 'calls', allDescendants: false }],
    where: {
      fieldFilter: {
        field: { fieldPath: 'state' },
        op: 'IN',
        value: {
          arrayValue: {
            values: [
              { stringValue: 'ringing' },
              { stringValue: 'incoming' },
              { stringValue: 'accepted' }
            ]
          }
        }
      }
    },
    limit: 10
  }
}

/**
 * Poll the calls collection for live documents via runQuery (scoped under
 * `users/{uid}`, so the owner-only rules still gate every read). Idle polling
 * only — during an active call the session polls its own signals directly.
 */
export async function pollLiveCalls(
  auth: CallAuth,
  onCall: (callId: string, doc: CallDoc) => void
): Promise<void> {
  const uid = auth.rest.getUid()
  if (!uid) return
  const docs = await auth.rest
    .runQuery(`users/${uid}`, buildLiveCallsQuery())
    .catch(() => [] as Array<{ id: string; fields: Record<string, unknown> }>)
  for (const d of docs) {
    const doc = callDocFrom(d.fields)
    if (doc) onCall(d.id, doc)
  }
}

/** Delete a call's signal documents (post-call cleanup — keeps lists small). */
export async function deleteCallSignals(auth: CallAuth, callId: string): Promise<void> {
  const uid = auth.rest.getUid()
  if (!uid) return
  await auth.rest
    .deleteCollection(`users/${uid}/calls/${callId}/signals`)
    .catch(() => undefined)
}

/** Wait one poll interval (interruptible via the abort signal). */
export function sleepPolling(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    if (signal) {
      const onAbort = (): void => {
        clearTimeout(t)
        resolve()
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

export { IDLE_POLL_MS, NEGOTIATION_POLL_MS }
