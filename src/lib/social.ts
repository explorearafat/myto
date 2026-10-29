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
import { auth } from './firebase';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  updateProfile,
} from 'firebase/auth';
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

/** Live-feed subscription. `topic` filters by tag; `authorUid` pins one author.
 *
 * A where-filter + orderBy on different fields needs a Firestore composite
 * index; without one the query is rejected and the profile/feed silently
 * never loads. Filtered queries therefore run equality-only (auto-indexed)
 * and sort client-side; the unfiltered feed keeps the server-side orderBy. */
export function streamFeed(
  opts: { topic?: string; authorUid?: string; pageSize?: number },
  onData: (posts: FeedPost[]) => void,
  onError?: (e: FirestoreError) => void
): Unsubscribe {
  const filtered = Boolean(opts.topic || opts.authorUid);
  const clauses: QueryConstraint[] = filtered
    ? [limit(200)]
    : [orderBy('createdAt', 'desc'), limit(opts.pageSize ?? 50)];
  if (opts.topic) clauses.push(where('topics', 'array-contains', opts.topic));
  if (opts.authorUid) clauses.push(where('uid', '==', opts.authorUid));
  const q = query(collection(db, 'posts'), ...clauses);
  return onSnapshot(
    q,
    (snap) => {
      const posts = snap.docs.map((d) => toPost(d.id, d.data()));
      if (!filtered) {
        onData(posts);
        return;
      }
      posts.sort((a, b) => b.createdAtMs - a.createdAtMs);
      onData(posts.slice(0, opts.pageSize ?? 50));
    },
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
  const ids = authorUids.slice(0, 10); // Firestore `in` cap.
  if (ids.length === 0) return [];
  // whereIn + orderBy needs a composite index — equality-only + client sort.
  const snap = await getDocs(query(collection(db, 'posts'), where('uid', 'in', ids), limit(200)));
  return snap.docs
    .map((d) => toPost(d.id, d.data()))
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
    .slice(0, 50);
}


// ── Accounts: signup, profiles, handles ────────────────────────────────────────

export interface DiscoverProfile {
  uid: string;
  name: string;
  username: string;
  bio: string;
  photo: string;
  /** Epoch ms of profile creation (0 until the server timestamp lands). */
  createdAtMs: number;
}

export const HANDLE_RE = /^[a-z0-9_]{3,20}$/;

/** Create an account with email + password, then seed its profile doc. */
export async function signUpWithEmail(
  email: string,
  password: string,
  name: string
): Promise<{ uid: string; email: string }> {
  const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
  const uid = cred.user.uid;
  await setDoc(doc(db, 'users', uid), {
    uid,
    name: name.trim().slice(0, 80) || email.split('@')[0],
    nickname: (name.trim() || email.split('@')[0]).split(/\s+/)[0],
    email: email.trim(),
    photoURL: '',
    role: '',
    company: '',
    about: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await updateProfile(cred.user, { displayName: name.trim().slice(0, 80) || undefined });
  return { uid, email: email.trim() };
}

/** Sign in with email + password. */
export async function signInWithEmail(email: string, password: string): Promise<void> {
  await signInWithEmailAndPassword(auth, email.trim(), password);
}

/** Read a user's public Discover profile. */
export async function getProfile(uid: string): Promise<DiscoverProfile | null> {
  const snap = await getDoc(doc(db, 'profiles', uid));
  if (!snap.exists()) return null;
  const d = snap.data();
  return {
    uid: snap.id,
    name: String(d.name ?? 'Anonymous'),
    username: String(d.username ?? ''),
    bio: String(d.bio ?? ''),
    photo: String(d.photo ?? ''),
    createdAtMs: tsToMs(d.createdAt),
  };
}

/** Is a handle free? (The rules enforce uniqueness too — this is UX.) */
export async function isHandleFree(username: string): Promise<boolean> {
  const snap = await getDoc(doc(db, 'usernames', username.toLowerCase()));
  return !snap.exists();
}

/**
 * Create (or update) the caller's Discover profile and claim their handle.
 * The handle registry doc is create-once in the rules — so on EDIT it must
 * NOT be re-written (the rules reject the update and the whole batch fails,
 * which read as "profile can't be saved"). Claim it only when new; when it
 * already exists and is ours, skip straight to the profile write. createdAt
 * is likewise only sent on first create so the profile's age never resets.
 * Returns false when the handle is taken.
 */
export async function saveProfile(
  uid: string,
  input: { name: string; username: string; bio: string; photo: string }
): Promise<boolean> {
  const username = input.username.trim().toLowerCase();
  if (!HANDLE_RE.test(username)) throw new Error('Handle must be 3-20 chars: a-z, 0-9, underscore.');
  const handleRef = doc(db, 'usernames', username);
  const existing = await getDoc(handleRef);
  if (existing.exists() && existing.data().uid !== uid) return false;
  const profileRef = doc(db, 'profiles', uid);
  const existingProfile = await getDoc(profileRef);
  const batch = writeBatch(db);
  if (!existing.exists()) {
    batch.set(handleRef, { uid });
  }
  const data: Record<string, unknown> = {
    uid,
    name: input.name.trim().slice(0, 80) || username,
    username,
    bio: input.bio.trim().slice(0, 280),
    photo: input.photo.slice(0, 500),
  };
  if (!existingProfile.exists()) {
    data.createdAt = serverTimestamp();
  }
  batch.set(profileRef, data, { merge: true });
  await batch.commit();
  return true;
}

/** Viral feed: the most-liked posts (likes are the engagement proxy).
 * Two orderBys (or a topic filter + orderBy) need composite indexes — order
 * by likeCount only server-side (or not at all with a topic filter) and
 * tie-break client-side. */
export function streamViralFeed(
  opts: { topic?: string; pageSize?: number },
  onData: (posts: FeedPost[]) => void,
  onError?: (e: unknown) => void
): Unsubscribe {
  const filtered = Boolean(opts.topic);
  const clauses: QueryConstraint[] = filtered
    ? [limit(200)]
    : [orderBy('likeCount', 'desc'), limit(opts.pageSize ?? 50)];
  if (opts.topic) clauses.push(where('topics', 'array-contains', opts.topic));
  const q = query(collection(db, 'posts'), ...clauses);
  const rank = (a: FeedPost, b: FeedPost) =>
    b.likeCount - a.likeCount || b.createdAtMs - a.createdAtMs;
  return onSnapshot(
    q,
    (snap) => {
      const posts = snap.docs.map((d) => toPost(d.id, d.data())).sort(rank);
      onData(posts.slice(0, opts.pageSize ?? 50));
    },
    (e) => onError?.(e)
  );
}

/** Public profile page data: the profile + that user's posts. Equality-only
 * query (no composite index) with a client-side sort. */
export async function loadProfileWithPosts(
  uid: string
): Promise<{ profile: DiscoverProfile | null; posts: FeedPost[] }> {
  const [profile, snap] = await Promise.all([
    getProfile(uid),
    getDocs(query(collection(db, 'posts'), where('uid', '==', uid), limit(50))),
  ]);
  const posts = snap.docs
    .map((d) => toPost(d.id, d.data()))
    .sort((a, b) => b.createdAtMs - a.createdAtMs);
  return { profile, posts };
}

/** Resolve a handle to a uid (for /discover?u=<handle> profile links). */
export async function uidForHandle(username: string): Promise<string | null> {
  const snap = await getDoc(doc(db, 'usernames', username.toLowerCase()));
  return snap.exists() ? String(snap.data().uid ?? '') || null : null;
}


// ── Artifacts: generated media + files, synced across clients ──────────────────
//
// Everything a model produced (image-gen, video-gen, documents, agent files)
// lands in Firestore under artifacts/{id} with the owner's uid, so the desktop,
// Android app, and this site all show the same vault. Firestore caps documents
// at ~1MB, so small media rides inline as base64 and anything larger (or a
// provider-returned URL) rides as a link.

export interface CloudArtifact {
  id: string;
  kind: 'image' | 'video' | 'svg' | 'document' | 'file';
  title: string;
  mime: string;
  /** Inline base64 (no data: prefix) for small media; '' when url is set. */
  dataBase64: string;
  /** Provider-returned or endpoint link, when the media rides as a URL. */
  url: string;
  /** Domain-safe display source, e.g. 'image generation'. */
  source: string;
  createdAtMs: number;
}

export function saveArtifact(
  uid: string,
  input: {
    kind: CloudArtifact['kind'];
    title: string;
    mime: string;
    dataBase64?: string;
    url?: string;
    source?: string;
  }
): Promise<void> {
  const data = input.dataBase64 ?? '';
  const url = input.url ?? '';
  if (data.length > 900_000) return Promise.resolve(); // too large for Firestore — skip silently
  if (data === '' && url === '') return Promise.resolve(); // nothing to store
  return addDoc(collection(db, 'artifacts'), {
    uid,
    kind: input.kind,
    title: input.title.slice(0, 200),
    mime: input.mime.slice(0, 120),
    dataBase64: data,
    url,
    source: (input.source ?? '').slice(0, 100),
    createdAt: serverTimestamp(),
  }).then(() => undefined);
}

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
  );
  return onSnapshot(
    q,
    (snap) =>
      onData(
        snap.docs.map((d) => {
          const data = d.data();
          return {
            id: d.id,
            kind: (data.kind ?? 'file') as CloudArtifact['kind'],
            title: String(data.title ?? 'Artifact'),
            mime: String(data.mime ?? 'application/octet-stream'),
            dataBase64: String(data.dataBase64 ?? ''),
            url: String(data.url ?? ''),
            source: String(data.source ?? ''),
            createdAtMs: tsToMs(data.createdAt),
          };
        })
      ),
    (e) => onError?.(e)
  );
}

export function deleteArtifact(id: string): Promise<void> {
  return deleteDoc(doc(db, 'artifacts', id));
}
