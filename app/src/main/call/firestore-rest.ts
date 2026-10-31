/**
 * A tiny authenticated Firestore REST client for the desktop call system.
 *
 * The desktop's signaling/presence traffic is small and bursty (a call moves a
 * dozen tiny documents); rather than embedding the Firebase JS SDK in the
 * Electron main process — where its Node-side auth story is unreliable — the
 * call system reuses the RENDERER's Firebase session: the renderer forwards its
 * (auto-refreshing) ID token via `call:auth-sync`, and every request here goes
 * to the Firestore REST API with `Authorization: Bearer <idToken>`. Access is
 * evaluated against the same owner-only Firestore rules as everywhere else, so
 * a stolen or expired token can only ever touch the signed-in user's own tree.
 *
 * Electron-free and injectable (baseUrl override) so the unit tests can run it
 * against a stub server.
 */

/** The Firestore project the whole repo is wired to (see api/notify.ts). */
const PROJECT_ID = 'sylor-29cab'

interface FirestoreValue {
  nullValue?: null
  booleanValue?: boolean
  integerValue?: string | number
  doubleValue?: number
  stringValue?: string
  timestampValue?: string
  mapValue?: { fields?: Record<string, FirestoreValue> }
  arrayValue?: { values?: FirestoreValue[] }
}

export type RestValue =
  | null
  | boolean
  | number
  | string
  | RestValue[]
  | { [key: string]: RestValue }

/** Encode a plain JS value into a Firestore REST typed value. */
export function toFirestoreValue(v: RestValue): FirestoreValue {
  if (v === null || v === undefined) return { nullValue: null }
  if (typeof v === 'boolean') return { booleanValue: v }
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }
  }
  if (typeof v === 'string') return { stringValue: v }
  if (Array.isArray(v)) {
    return { arrayValue: { values: v.map(toFirestoreValue) } }
  }
  const fields: Record<string, FirestoreValue> = {}
  for (const [k, inner] of Object.entries(v)) fields[k] = toFirestoreValue(inner)
  return { mapValue: { fields } }
}

/** Decode a Firestore REST typed value back into a plain JS value. */
export function fromFirestoreValue(v: FirestoreValue | undefined): RestValue {
  if (!v || v.nullValue !== undefined) return null
  if (v.booleanValue !== undefined) return v.booleanValue
  if (v.integerValue !== undefined) return Number(v.integerValue)
  if (v.doubleValue !== undefined) return v.doubleValue
  if (v.stringValue !== undefined) return v.stringValue
  if (v.timestampValue !== undefined) return v.timestampValue
  if (v.mapValue) return fromFirestoreFields(v.mapValue.fields ?? {})
  if (v.arrayValue) return (v.arrayValue.values ?? []).map(fromFirestoreValue)
  return null
}

/** Decode a REST document's `fields` map into a plain object. */
export function fromFirestoreFields(
  fields: Record<string, FirestoreValue> | undefined
): Record<string, RestValue> {
  const out: Record<string, RestValue> = {}
  if (!fields) return out
  for (const [k, v] of Object.entries(fields)) out[k] = fromFirestoreValue(v)
  return out
}

/** Extract the Firebase UID from a JWT payload (no verification — Firestore verifies). */
export function uidFromToken(idToken: string): string | null {
  try {
    const payload = idToken.split('.')[1]
    if (!payload) return null
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      user_id?: string
      sub?: string
    }
    return json.user_id ?? json.sub ?? null
  } catch {
    return null
  }
}

/** A listed REST document: its decoded fields plus its trailing document id. */
export interface RestDoc {
  id: string
  fields: Record<string, RestValue>
}

export interface FirestoreRestOptions {
  /** Override for tests. */
  baseUrl?: string
  /** Called when a request comes back 401 — the token needs a refresh. */
  onAuthExpired?: () => void
  /** Milliseconds before one REST call gives up (default 8000). */
  timeoutMs?: number
}

/**
 * The client. One instance per app run; `setToken` is called by the auth flow
 * whenever the renderer hands over a fresh token.
 */
export class FirestoreRest {
  private token: string | null = null
  private uid: string | null = null
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly onAuthExpired: () => void

  constructor(opts: FirestoreRestOptions = {}) {
    this.baseUrl = opts.baseUrl ?? `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`
    this.timeoutMs = opts.timeoutMs ?? 8000
    this.onAuthExpired = opts.onAuthExpired ?? (() => {})
  }

  /** Install a (fresh) renderer ID token; derives the owner uid from its payload. */
  setToken(idToken: string): string | null {
    this.token = idToken
    this.uid = uidFromToken(idToken)
    return this.uid
  }

  getToken(): string | null {
    return this.token
  }

  getUid(): string | null {
    return this.uid
  }

  hasAuth(): boolean {
    return this.token !== null && this.uid !== null
  }

  private authHeaders(): Record<string, string> {
    if (!this.token) throw new Error('call-auth: no Firebase token — renderer has not synced')
    return { authorization: `Bearer ${this.token}` }
  }

  private async fetchJson(
    url: string,
    init: RequestInit & { mask?: string[] }
  ): Promise<{ status: number; json: unknown }> {
    const { mask, ...rest } = init
    if (mask && mask.length > 0) {
      const qs = mask.map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join('&')
      url = `${url}${url.includes('?') ? '&' : '?'}${qs}`
    }
    const res = await fetch(url, { ...rest, signal: AbortSignal.timeout(this.timeoutMs) })
    let json: unknown = null
    try {
      json = await res.json()
    } catch {
      /* 204s and empty bodies are fine */
    }
    return { status: res.status, json }
  }

  /**
   * One request with a single 401 retry: an expired token fires `onAuthExpired`
   * (the renderer sends a fresh one) and the call replays once before failing.
   * The replay waits a beat so the refreshed token has actually landed — an
   * immediate retry would race the renderer and reuse the same dead token.
   */
  private async request(
    method: string,
    path: string,
    body: unknown,
    mask?: string[]
  ): Promise<{ status: number; json: unknown }> {
    const url = `${this.baseUrl}/${path}`
    const attempt = async (): Promise<{ status: number; json: unknown }> =>
      this.fetchJson(url, {
        method,
        headers: { ...this.authHeaders(), 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        mask
      })
    let res = await attempt()
    if (res.status === 401 || res.status === 403) {
      const stale = this.token
      this.onAuthExpired()
      // Wait briefly for the renderer to deliver a fresh token, then retry once.
      await new Promise((r) => setTimeout(r, 1_200))
      if (this.token && this.token !== stale) {
        res = await attempt()
      }
    }
    return res
  }

  /**
   * Run a structured query scoped to `parentPath` (e.g. `users/{uid}` with
   * `from: [{collectionId: 'calls'}]`). Firestore REST's plain document list
   * has no orderBy, which makes it useless for "newest live calls" — runQuery
   * is the reliable way to poll for calls in live states.
   */
  async runQuery(parentPath: string, structuredQuery: Record<string, RestValue>): Promise<RestDoc[]> {
    const res = await this.request('POST', `${parentPath}:runQuery`, { structuredQuery })
    if (res.status !== 200) throw new Error(`call-auth: QUERY ${parentPath} → ${res.status} ${bodyOf(res)}`)
    const rows = res.json as Array<{
      document?: { name?: string; fields?: Record<string, FirestoreValue> }
    }>
    return rows
      .filter((r) => r.document !== undefined)
      .map((r) => {
        const name = r.document?.name ?? ''
        return { id: name.slice(name.lastIndexOf('/') + 1), fields: fromFirestoreFields(r.document?.fields) }
      })
  }

  /** Read one document; returns its decoded fields or null when it doesn't exist. */
  async getDoc(path: string): Promise<RestDoc | null> {
    const res = await this.request('GET', path, undefined)
    if (res.status === 404) return null
    if (res.status !== 200) throw new Error(`call-auth: GET ${path} → ${res.status} ${bodyOf(res)}`)
    const json = res.json as { name?: string; fields?: Record<string, FirestoreValue> }
    const name = json.name ?? ''
    const id = name.slice(name.lastIndexOf('/') + 1)
    return { id, fields: fromFirestoreFields(json.fields) }
  }

  /**
   * Create-or-replace a document at an explicit path (the id is ours — device
   * ids, call ids, signal seqs). Firestore's PATCH on a named path upserts.
   */
  async setDoc(path: string, fields: Record<string, RestValue>): Promise<void> {
    const body = { fields: mapToFirestore(fields) }
    const res = await this.request('PATCH', path, body)
    if (res.status !== 200) throw new Error(`call-auth: SET ${path} → ${res.status} ${bodyOf(res)}`)
  }

  /**
   * Merge-write specific fields (updateMask), leaving the rest of the document
   * untouched — how concurrent writers (phone ↔ desktop) avoid clobbering.
   */
  async patchDoc(
    path: string,
    fields: Record<string, RestValue>,
    mask?: string[]
  ): Promise<void> {
    const body = { fields: mapToFirestore(fields) }
    const maskKeys = mask ?? Object.keys(fields)
    const res = await this.request('PATCH', path, body, maskKeys)
    if (res.status !== 200) throw new Error(`call-auth: PATCH ${path} → ${res.status} ${bodyOf(res)}`)
  }

  /** List a collection (documents under the given parent path), newest optional. */
  async listDocs(parent: string, pageSize = 30): Promise<RestDoc[]> {
    const res = await this.request('GET', `${parent}?pageSize=${pageSize}`, undefined)
    if (res.status === 404) return []
    if (res.status !== 200) throw new Error(`call-auth: LIST ${parent} → ${res.status} ${bodyOf(res)}`)
    const json = res.json as {
      documents?: Array<{ name?: string; fields?: Record<string, FirestoreValue> }>
    }
    return (json.documents ?? []).map((d) => {
      const name = d.name ?? ''
      return { id: name.slice(name.lastIndexOf('/') + 1), fields: fromFirestoreFields(d.fields) }
    })
  }

  /** Delete one document (call docs end here; signals are pruned with their call). */
  async deleteDoc(path: string): Promise<void> {
    await this.request('DELETE', path, undefined)
  }

  /** Delete every document in a collection (best-effort, used to clear call signals). */
  async deleteCollection(parent: string, pageSize = 50): Promise<void> {
    const docs = await this.listDocs(parent, pageSize)
    for (const d of docs) {
      await this.deleteDoc(`${parent}/${d.id}`).catch(() => undefined)
    }
  }
}

function mapToFirestore(fields: Record<string, RestValue>): Record<string, FirestoreValue> {
  const out: Record<string, FirestoreValue> = {}
  for (const [k, v] of Object.entries(fields)) out[k] = toFirestoreValue(v)
  return out
}

/** Firestore 400s carry the real reason in the body — surface it verbatim. */
function bodyOf(res: { json: unknown }): string {
  try {
    return JSON.stringify(res.json).slice(0, 500)
  } catch {
    return ''
  }
}
