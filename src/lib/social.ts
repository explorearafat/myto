// Firestore service for the Discover social feed (the website side).
//
// Data model (enforced by firestore.rules — read that file for the full threat model):
//
//   posts/{postId}                     — a text-only post (≤500 chars) with an optional
//                                        attached https link + its preview metadata
//   posts/{postId}/likes/{uid}         — one like per user (doc id = liker's uid)
//   posts/{postId}/comments/{commentId}— threaded comments (≤300 chars)
//   posts/{postId}/shares/{uid}        — one repost-per-user ("add to profile")
//   users/{uid}/saved/{postId}         — the user's profile saves ({savedAt, post})
//   follows/{uid}/following/{target}   — who uid follows
//   follows/{uid}/followers/{uid}      — who follows uid
//
// Counters (likeCount/commentCount/shareCount) live on the post doc and move via
// FieldValue.increment(±1) inside the same batch/transaction as the edge doc write,
// so a doc and its count can't drift apart. The rules cap every counter write at +1
// and forbid negatives, so even a hostile client can't skew a post's numbers.

import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  FirestoreError,
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
  runTransaction,
  type QueryConstraint,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from './firebase';

// ── Shapes ─────────────────────────────────────────────────────────────────────

export interface FeedPost {
  id: string;
  uid: string;
  name: string;
  photo: string;
  text: string;
  link: string;
  linkTitle: string;
  linkImage: string;
  linkSite: string;
  topics: string[];
  likeCount: number;
  commentCount: number;
  shareCount: number;
  /** Epoch ms (0 for a just-written doc before the server timestamp lands). */
  createdAtMs: number;
}

export interface FeedComment {
  id: string;
  uid: string;
  name: string;
  photo: string;
  text: string;
  createdAtMs: number;
}

export interface PostAuthor {
  uid: string;
  name: string;
  photo: string;
}

export const MAX_POST_CHARS = 500;
export const MAX_COMMENT_CHARS = 300;

/** The topic chips the composer offers; posts also inherit #hashtags from their text. */
export const TOPICS = ['ai', 'myto', 'crypto', 'tech', 'news', 'dev'] as const;

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Lowercase #hashtags in the text (deduped, max 4) — merged into the post's topics. */
export function extractHashtags(text: string): string[] {
  const tags = new Set<string>();
  for (const m of text.matchAll(/#([a-z0-9]{1,20})/gi)) {
    tags.add(m[1].toLowerCase());
    if (tags.size >= 4) break;
  }
  return [...tags];
}

/** First https URL in the text, or null. */
export function firstUrl(text: string): string | null {
  const m = /https:\/\/[^\s<>"]+/i.exec(text);
  return m ? m[0].slice(0, 500) : null;
}

/** Trim + validate a post body against the rules' field caps. */
export function normalizeTopics(chosen: string[], hashtags: string[]): string[] {
  const merged: string[] = [];
  for (const t of [...chosen, ...hashtags]) {
    const slug = t.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
    if (slug && !merged.includes(slug)) merged.push(slug);
    if (merged.length >= 4) break;
  }
  return merged;
}

function tsToMs(value: unknown): number {
  const t = value as { toMillis?: () => number } | null;
  return typeof t?.toMillis === 'function' ? t.toMillis() : 0;
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
  };
}

// ── Posts ──────────────────────────────────────────────────────────────────────

/** Fetch the preview metadata for an attached link from the site's edge function. */
export async function fetchLinkMeta(
  url: string
): Promise<{ title: string; image: string; site: string }> {
  try {
    const res = await fetch('/api/link-preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = (await res.json()) as { title?: string; image?: string; site?: string };
    return {
      title: (data.title ?? '').slice(0, 200),
      image: (data.image ?? '').slice(0, 500),
      site: (data.site ?? '').slice(0, 100),
    };
  } catch {
    // No preview is not a failure — the post goes out with the bare link.
    return { title: '', image: '', site: '' };
  }
}

/** Create a post. Throws on validation failure (the UI validates first too). */
export async function createPost(
  author: PostAuthor,
  text: string,
  chosenTopics: string[],
  link: string,
  linkMeta: { title: string; image: string; site: string }
): Promise<string> {
  const body = text.trim().slice(0, MAX_POST_CHARS);
  if (!body) throw new Error('Post cannot be empty.');
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
  });
  return ref.id;
}

/** Delete a post (author only, enforced by the rules) + best-effort cascade. */
export async function deletePost(postId: string, uid: string): Promise<void> {
  // Subcollections can't cascade from a client, so sweep them first (bounded).
  for (const sub of ['likes', 'comments', 'shares'] as const) {
    try {
      const docs = await getDocs(collection(db, 'posts', postId, sub));
      await Promise.all(docs.docs.slice(0, 200).map((d) => deleteDoc(d.ref)));
    } catch {
      // A partial sweep is fine — the parent delete orphans whatever is left.
    }
  }
  await deleteDoc(doc(db, 'posts', postId));
  // Best-effort: drop it from every saver's profile list is NOT possible client-side
  // (saved lists are private) — saved cards hydrate from posts and render "deleted".
}

/** Live-feed subscription. `topic` filters by tag; `authorUid` pins one author. */
export function streamFeed(
  opts: { topic?: string; authorUid?: string; pageSize?: number },
  onData: (posts: FeedPost[]) => void,
  onError?: (e: FirestoreError) => void
): Unsubscribe {
  const clauses: QueryConstraint[] = [orderBy('createdAt', 'desc'), limit(opts.pageSize ?? 50)];
  if (opts.topic) clauses.unshift(where('topics', 'array-contains', opts.topic));
  if (opts.authorUid) clauses.unshift(where('uid', '==', opts.authorUid));
  const q = query(collection(db, 'posts'), ...clauses);
  return onSnapshot(
    q,
    (snap) => onData(snap.docs.map((d) => toPost(d.id, d.data()))),
    (e) => onError?.(e)
  );
}

/** Live comments subscription for one post (oldest first). */
export function streamComments(postId: string, onData: (comments: FeedComment[]) => void): Unsubscribe {
  const q = query(collection(db, 'posts', postId, 'comments'), orderBy('createdAt', 'asc'), limit(100));
  return onSnapshot(q, (snap) =>
    onData(
      snap.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          uid: String(data.uid ?? ''),
          name: String(data.name ?? 'Anonymous'),
          photo: String(data.photo ?? ''),
          text: String(data.text ?? ''),
          createdAtMs: tsToMs(data.createdAt),
        };
      })
    )
  );
}

// ── Likes / comments / shares ──────────────────────────────────────────────────

/**
 * Toggle the caller's like on a post inside a transaction: read the like doc, then
 * create-or-delete it and bump the counter by exactly ±1 in the same atomic write.
 * The rules cap counter writes at +1 per write, so the transaction keeps honest
 * counts even when two devices tap at once.
 */
export async function toggleLike(postId: string, uid: string): Promise<boolean> {
  const likeRef = doc(db, 'posts', postId, 'likes', uid);
  const postRef = doc(db, 'posts', postId);
  return runTransaction(db, async (tx) => {
    const existing = await tx.get(likeRef);
    if (existing.exists()) {
      tx.delete(likeRef);
      tx.update(postRef, { likeCount: increment(-1) });
      return false;
    }
    tx.set(likeRef, { createdAt: serverTimestamp() });
    tx.update(postRef, { likeCount: increment(1) });
    return true;
  });
}

/** Is `uid` among the post's likers (for the heart's initial state)? */
export async function isLikedBy(postId: string, uid: string): Promise<boolean> {
  const snap = await getDoc(doc(db, 'posts', postId, 'likes', uid));
  return snap.exists();
}

/** Add a comment: the comment doc + the post's commentCount, atomically. */
export async function addComment(
  postId: string,
  author: PostAuthor,
  text: string
): Promise<void> {
  const body = text.trim().slice(0, MAX_COMMENT_CHARS);
  if (!body) return;
  const batch = writeBatch(db);
  const commentRef = doc(collection(db, 'posts', postId, 'comments'));
  batch.set(commentRef, {
    uid: author.uid,
    name: author.name.slice(0, 80),
    photo: author.photo.slice(0, 500),
    text: body,
    createdAt: serverTimestamp(),
  });
  batch.update(doc(db, 'posts', postId), { commentCount: increment(1) });
  await batch.commit();
}

/**
 * "Share" = repost to the caller's profile: one share doc per user (id = uid) plus
 * the shareCount bump. Idempotent — sharing twice does not double-count.
 */
export async function sharePost(postId: string, author: PostAuthor): Promise<boolean> {
  const shareRef = doc(db, 'posts', postId, 'shares', author.uid);
  const postRef = doc(db, 'posts', postId);
  return runTransaction(db, async (tx) => {
    const existing = await tx.get(shareRef);
    if (existing.exists()) return false;
    tx.set(shareRef, { uid: author.uid, name: author.name.slice(0, 80), createdAt: serverTimestamp() });
    tx.update(postRef, { shareCount: increment(1) });
    return true;
  });
}

// ── Saved to profile ───────────────────────────────────────────────────────────

/** Save a post to the caller's profile (users/{uid}/saved/{postId}). */
export async function saveToProfile(postId: string, uid: string): Promise<void> {
  await setDoc(doc(db, 'users', uid, 'saved', postId), { savedAt: serverTimestamp(), post: postId });
}

/** Remove a saved post from the profile. */
export async function unsaveFromProfile(postId: string, uid: string): Promise<void> {
  await deleteDoc(doc(db, 'users', uid, 'saved', postId));
}

/** Is the post in the caller's saved list? */
export async function isSavedBy(postId: string, uid: string): Promise<boolean> {
  const snap = await getDoc(doc(db, 'users', uid, 'saved', postId));
  return snap.exists();
}

/** The caller's saved post ids, most recent first. */
export async function listSavedIds(uid: string): Promise<string[]> {
  const snap = await getDocs(
    query(collection(db, 'users', uid, 'saved'), orderBy('savedAt', 'desc'), limit(100))
  );
  return snap.docs.map((d) => String(d.data().post ?? d.id)).filter(Boolean);
}

/** Hydrate saved post ids into full posts (missing/deleted posts are skipped). */
export async function hydratePosts(ids: string[]): Promise<FeedPost[]> {
  const out: FeedPost[] = [];
  for (const id of ids) {
    const snap = await getDoc(doc(db, 'posts', id));
    if (snap.exists()) out.push(toPost(snap.id, snap.data()));
  }
  return out;
}

// ── Follows ────────────────────────────────────────────────────────────────────

/** Follow an author: both graph edges in one batch. */
export async function followAuthor(me: string, target: string): Promise<void> {
  if (me === target) return;
  const batch = writeBatch(db);
  batch.set(doc(db, 'follows', me, 'following', target), { at: serverTimestamp() });
  batch.set(doc(db, 'follows', target, 'followers', me), { at: serverTimestamp() });
  await batch.commit();
}

/** Unfollow: remove both edges. */
export async function unfollowAuthor(me: string, target: string): Promise<void> {
  const batch = writeBatch(db);
  batch.delete(doc(db, 'follows', me, 'following', target));
  batch.delete(doc(db, 'follows', target, 'followers', me));
  await batch.commit();
}

/** The ids of everyone `uid` follows (for the Following tab). */
export async function getFollowingIds(uid: string): Promise<string[]> {
  const snap = await getDocs(collection(db, 'follows', uid, 'following'));
  return snap.docs.map((d) => d.id);
}

/** Feed posts by a fixed set of authors (the Following tab), merged newest-first. */
export async function fetchPostsByAuthors(authorUids: string[]): Promise<FeedPost[]> {
  const ids = authorUids.slice(0, 10); // Firestore `in` cap — the tab is "recent follows".
  if (ids.length === 0) return [];
  const snap = await getDocs(
    query(collection(db, 'posts'), where('uid', 'in', ids), orderBy('createdAt', 'desc'), limit(50))
  );
  return snap.docs.map((d) => toPost(d.id, d.data()));
}
