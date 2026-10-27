// Firestore service for the Discover community feed — the desktop's mirror of the
// website's src/lib/social.ts (identical collections and counter semantics; see
// firestore.rules in the repo root for the security model). The signed-in user IS
// the Discover account: posts are written with `uid: auth.uid`, so the same
// Google/GitHub credential shows the same feed, saves, and follows on every client.
//
//   posts/{postId}                       — a text-only post (≤500 chars) + optional link
//   posts/{postId}/likes/{uid}           — one like per user (doc id = liker's uid)
//   posts/{postId}/comments/{commentId}  — ≤300-char comments
//   posts/{postId}/shares/{uid}          — one repost-per-user ("add to profile")
//   users/{uid}/saved/{postId}           — the profile's saved list ({savedAt, post})
//   follows/{uid}/following|followers/…  — the follow graph (both edges per follow)

import {
  addDoc,
  type QueryConstraint,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  increment,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore'
import { runTransaction } from 'firebase/firestore'
import { db } from './firebase'

export interface FeedPost {
  id: string
  uid: string
  name: string
  photo: string
  text: string
  link: string
  linkTitle: string
  linkImage: string
  linkSite: string
  topics: string[]
  likeCount: number
  commentCount: number
  shareCount: number
  createdAtMs: number
}

export interface FeedComment {
  id: string
  uid: string
  name: string
  photo: string
  text: string
  createdAtMs: number
}

export interface PostAuthor {
  uid: string
  name: string
  photo: string
}

export const MAX_POST_CHARS = 500
export const MAX_COMMENT_CHARS = 300

export const TOPICS = ['ai', 'myto', 'crypto', 'tech', 'news', 'dev'] as const

/** Lowercase #hashtags in the text (deduped, max 4) — merged into the topics. */
export function extractHashtags(text: string): string[] {
  const tags = new Set<string>()
  for (const m of text.matchAll(/#([a-z0-9]{1,20})/gi)) {
    tags.add(m[1].toLowerCase())
    if (tags.size >= 4) break
  }
  return [...tags]
}

/** First https URL in the text, or null. */
export function firstUrl(text: string): string | null {
  const m = /https:\/\/[^\s<"]+/i.exec(text)
  return m ? m[0].slice(0, 500) : null
}

/** Merge chosen chips + hashtags into ≤4 clean slugs (the rules validate this shape). */
export function normalizeTopics(chosen: string[], hashtags: string[]): string[] {
  const merged: string[] = []
  for (const t of [...chosen, ...hashtags]) {
    const slug = t.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20)
    if (slug && !merged.includes(slug)) merged.push(slug)
    if (merged.length >= 4) break
  }
  return merged
}

function tsToMs(value: unknown): number {
  const t = value as { toMillis?: () => number } | null
  return typeof t?.toMillis === 'function' ? t.toMillis() : 0
}

function toPost(id: string, data: Record<string, unknown>): FeedPost {
  return {
    id,
    uid: String(data.uid ?? ''),
    name: String(data.name ?? 'Anonymous'),
    photo: String(data.photo ?? ''),
    text: String(data.text ?? ''),
    link: String(data.link ?? ''),
    linkTitle: String(data.linkTitle ?? ''),
    linkImage: String(data.linkImage ?? ''),
    linkSite: String(data.linkSite ?? ''),
    topics: Array.isArray(data.topics) ? (data.topics as string[]) : [],
    likeCount: Number(data.likeCount ?? 0),
    commentCount: Number(data.commentCount ?? 0),
    shareCount: Number(data.shareCount ?? 0),
    createdAtMs: tsToMs(data.createdAt),
  }
}

/** Fetch preview metadata for an attached link from the site's edge function. */
export async function fetchLinkMeta(url: string): Promise<{ title: string; image: string; site: string }> {
  try {
    const res = await fetch('https://mytocode.vercel.app/api/link-preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    })
    const data = (await res.json()) as { title?: string; image?: string; site?: string }
    return {
      title: (data.title ?? '').slice(0, 200),
      image: (data.image ?? '').slice(0, 500),
      site: (data.site ?? '').slice(0, 100),
    }
  } catch {
    // No preview is not a failure — the post goes out with the bare link.
    return { title: '', image: '', site: '' }
  }
}

/** Create a post under the signed-in user's uid (the rules pin it to the caller). */
export async function createPost(
  author: PostAuthor,
  text: string,
  chosenTopics: string[],
  link: string,
  linkMeta: { title: string; image: string; site: string }
): Promise<string> {
  const body = text.trim().slice(0, MAX_POST_CHARS)
  if (!body) throw new Error('Post cannot be empty.')
  const ref = await addDoc(collection(db, 'posts'), {
    uid: author.uid,
    name: author.name.slice(0, 80),
    photo: author.photo.slice(0, 500),
    text: body,
    link: link.slice(0, 500),
    linkTitle: linkMeta.title.slice(0, 200),
    linkImage: linkMeta.image.slice(0, 500),
    linkSite: linkMeta.site.slice(0, 100),
    topics: normalizeTopics(chosenTopics, extractHashtags(body)),
    likeCount: 0,
    commentCount: 0,
    shareCount: 0,
    createdAt: serverTimestamp(),
  })
  return ref.id
}

/** Delete a post (author only, enforced by the rules) + best-effort cascade. */
export async function deletePost(postId: string): Promise<void> {
  for (const sub of ['likes', 'comments', 'shares'] as const) {
    try {
      const docs = await getDocs(collection(db, 'posts', postId, sub))
      await Promise.all(docs.docs.slice(0, 200).map((d) => deleteDoc(d.ref)))
    } catch {
      // A partial sweep is fine — the parent delete orphans whatever is left.
    }
  }
  await deleteDoc(doc(db, 'posts', postId))
}

/** Live-feed subscription. `topic` filters by tag; `authorUid` pins one author. */
export function streamFeed(
  opts: { topic?: string; authorUid?: string; pageSize?: number },
  onData: (posts: FeedPost[]) => void,
  onError?: (e: unknown) => void
): Unsubscribe {
  const clauses: QueryConstraint[] = [orderBy('createdAt', 'desc'), limit(opts.pageSize ?? 50)]
  if (opts.topic) clauses.unshift(where('topics', 'array-contains', opts.topic))
  if (opts.authorUid) clauses.unshift(where('uid', '==', opts.authorUid))
  const q = query(collection(db, 'posts'), ...clauses)
  return onSnapshot(
    q,
    (snap) => onData(snap.docs.map((d) => toPost(d.id, d.data()))),
    (e) => onError?.(e)
  )
}

/** Live comments subscription for one post (oldest first). */
export function streamComments(postId: string, onData: (comments: FeedComment[]) => void): Unsubscribe {
  const q = query(collection(db, 'posts', postId, 'comments'), orderBy('createdAt', 'asc'), limit(100))
  return onSnapshot(q, (snap) =>
    onData(
      snap.docs.map((d) => {
        const data = d.data()
        return {
          id: d.id,
          uid: String(data.uid ?? ''),
          name: String(data.name ?? 'Anonymous'),
          photo: String(data.photo ?? ''),
          text: String(data.text ?? ''),
          createdAtMs: tsToMs(data.createdAt),
        }
      })
    )
  )
}

/** Toggle the caller's like atomically with its ±1 counter bump. */
export async function toggleLike(postId: string, uid: string): Promise<boolean> {
  const likeRef = doc(db, 'posts', postId, 'likes', uid)
  const postRef = doc(db, 'posts', postId)
  return runTransaction(db, async (tx) => {
    const existing = await tx.get(likeRef)
    if (existing.exists()) {
      tx.delete(likeRef)
      tx.update(postRef, { likeCount: increment(-1) })
      return false
    }
    tx.set(likeRef, { createdAt: serverTimestamp() })
    tx.update(postRef, { likeCount: increment(1) })
    return true
  })
}

/** Is `uid` among the post's likers (for the heart's initial state)? */
export async function isLikedBy(postId: string, uid: string): Promise<boolean> {
  const snap = await getDoc(doc(db, 'posts', postId, 'likes', uid))
  return snap.exists()
}

/** Add a comment: the comment doc + the post's commentCount, atomically. */
export async function addComment(postId: string, author: PostAuthor, text: string): Promise<void> {
  const body = text.trim().slice(0, MAX_COMMENT_CHARS)
  if (!body) return
  const batch = writeBatch(db)
  const commentRef = doc(collection(db, 'posts', postId, 'comments'))
  batch.set(commentRef, {
    uid: author.uid,
    name: author.name.slice(0, 80),
    photo: author.photo.slice(0, 500),
    text: body,
    createdAt: serverTimestamp(),
  })
  batch.update(doc(db, 'posts', postId), { commentCount: increment(1) })
  await batch.commit()
}

/** "Share" = repost to the caller's profile. Idempotent (one doc per user). */
export async function sharePost(postId: string, author: PostAuthor): Promise<boolean> {
  const shareRef = doc(db, 'posts', postId, 'shares', author.uid)
  const postRef = doc(db, 'posts', postId)
  return runTransaction(db, async (tx) => {
    const existing = await tx.get(shareRef)
    if (existing.exists()) return false
    tx.set(shareRef, { uid: author.uid, name: author.name.slice(0, 80), createdAt: serverTimestamp() })
    tx.update(postRef, { shareCount: increment(1) })
    return true
  })
}

/** Save a post to the caller's profile (users/{uid}/saved/{postId}). */
export async function saveToProfile(postId: string, uid: string): Promise<void> {
  await setDoc(doc(db, 'users', uid, 'saved', postId), {
    savedAt: serverTimestamp(),
    post: postId,
  })
}

/** Remove a saved post from the profile. */
export async function unsaveFromProfile(postId: string, uid: string): Promise<void> {
  await deleteDoc(doc(db, 'users', uid, 'saved', postId))
}

/** Is the post in the caller's saved list? */
export async function isSavedBy(postId: string, uid: string): Promise<boolean> {
  const snap = await getDoc(doc(db, 'users', uid, 'saved', postId))
  return snap.exists()
}

/** The caller's saved post ids, most recent first. */
export async function listSavedIds(uid: string): Promise<string[]> {
  const snap = await getDocs(
    query(collection(db, 'users', uid, 'saved'), orderBy('savedAt', 'desc'), limit(100))
  )
  return snap.docs.map((d) => String(d.data().post ?? d.id)).filter(Boolean)
}

/** Hydrate saved post ids into full posts (missing/deleted posts are skipped). */
export async function hydratePosts(ids: string[]): Promise<FeedPost[]> {
  const out: FeedPost[] = []
  for (const id of ids) {
    const snap = await getDoc(doc(db, 'posts', id))
    if (snap.exists()) out.push(toPost(snap.id, snap.data()))
  }
  return out
}

/** Follow an author: both graph edges in one batch. */
export async function followAuthor(me: string, target: string): Promise<void> {
  if (me === target) return
  const batch = writeBatch(db)
  batch.set(doc(db, 'follows', me, 'following', target), { at: serverTimestamp() })
  batch.set(doc(db, 'follows', target, 'followers', me), { at: serverTimestamp() })
  await batch.commit()
}

/** Unfollow: remove both edges. */
export async function unfollowAuthor(me: string, target: string): Promise<void> {
  const batch = writeBatch(db)
  batch.delete(doc(db, 'follows', me, 'following', target))
  batch.delete(doc(db, 'follows', target, 'followers', me))
  await batch.commit()
}

/** The ids of everyone `uid` follows (for the Following view). */
export async function getFollowingIds(uid: string): Promise<string[]> {
  const snap = await getDocs(collection(db, 'follows', uid, 'following'))
  return snap.docs.map((d) => d.id)
}

/** Feed posts by a fixed set of authors (the Following view), merged newest-first. */
export async function fetchPostsByAuthors(authorUids: string[]): Promise<FeedPost[]> {
  const ids = authorUids.slice(0, 10)
  if (ids.length === 0) return []
  const snap = await getDocs(
    query(collection(db, 'posts'), where('uid', 'in', ids), orderBy('createdAt', 'desc'), limit(50))
  )
  return snap.docs.map((d) => toPost(d.id, d.data()))
}

/**
 * "For you" ordering: engagement + recency + who-you-follow, with a jitter that
 * is stable per (post, refresh) — the feed flows differently on each refresh but
 * never re-shuffles while you scroll. Mirrors the mobile app's ranking.
 */
export function prioritizePosts(
  posts: FeedPost[],
  opts: { following?: Set<string>; seed?: number; nowMs?: number } = {}
): FeedPost[] {
  const { following = new Set<string>(), seed = 0 } = opts
  const now = opts.nowMs ?? Date.now()
  const score = (p: FeedPost): number => {
    const ageH = Math.min(Math.max((now - p.createdAtMs) / 3600000, 0), 72)
    const engagement = p.likeCount * 2 + p.commentCount * 3 + p.shareCount * 2.5
    const recency = 40 * (1 - ageH / 72)
    const followBoost = following.has(p.uid) ? 25 : 0
    const jitter = jitterFor(`${seed}:${p.id}`) * 12
    return engagement + recency + followBoost + jitter
  }
  return [...posts].sort((a, b) => score(b) - score(a))
}

/** Stable 0..1 hash (String.hash varies per run, so roll our own). */
function jitterFor(s: string): number {
  let h = 7
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0x7fffffff
  return (h % 1000) / 1000
}

/** Recent comments on my posts — the Discover bell's notification list. */
export async function fetchMyNotifications(
  uid: string,
  maxPosts = 10
): Promise<Array<{ id: string; who: string; text: string; atMs: number; postPreview: string }>> {
  const mine = await getDocs(
    query(collection(db, 'posts'), where('uid', '==', uid), orderBy('createdAt', 'desc'), limit(maxPosts))
  )
  const out: Array<{ id: string; who: string; text: string; atMs: number; postPreview: string }> = []
  for (const post of mine.docs) {
    const preview = String(post.data().text ?? '').slice(0, 60)
    const comments = await getDocs(query(collection(db, 'posts', post.id, 'comments'), limit(20)))
    for (const c of comments.docs) {
      const d = c.data()
      out.push({
        id: c.id,
        who: String(d.name ?? 'Someone'),
        text: String(d.text ?? ''),
        atMs: (d.createdAt as { toMillis?: () => number } | null)?.toMillis?.() ?? 0,
        postPreview: preview,
      })
    }
  }
  return out.sort((a, b) => b.atMs - a.atMs)
}
