// The Discover community feed (/discover) — a text-first social layer for Myto:
// users post short takes on AI / Myto / crypto / anything, optionally attaching a
// website link (whose preview card is fetched server-side by /api/link-preview);
// readers react, comment, share, follow authors, and save posts to their profile.
//
// Data lives in Firestore under posts/* + follows/* + users/{uid}/saved (see
// src/lib/social.ts and firestore.rules for the schema and the security model).
// Reading is public; every write requires sign-in, and the rules pin every write
// to its caller so nobody can post or react as someone else.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Header } from './Header';
import { Footer } from './Footer';
import { MytoMark } from './MytoMark';
import { useAuth } from '../lib/auth';
import {
  addComment,
  createPost,
  deletePost,
  fetchLinkMeta,
  fetchPostsByAuthors,
  followAuthor,
  firstUrl,
  getFollowingIds,
  hydratePosts,
  isLikedBy,
  isSavedBy,
  listSavedIds,
  MAX_POST_CHARS,
  saveToProfile,
  sharePost,
  streamFeed,
  TOPICS,
  toggleLike,
  unfollowAuthor,
  unsaveFromProfile,
  type FeedComment,
  type FeedPost,
} from '../lib/social';

// ── Small shared pieces ────────────────────────────────────────────────────────

function relativeTime(ms: number): string {
  if (!ms) return 'just now';
  const s = Math.max(1, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Render text with #hashtags and https links as anchors. */
function LinkifiedText({ text }: { text: string }) {
  const parts = useMemo(() => {
    const out: Array<{ kind: 'text' | 'link' | 'tag'; value: string }> = [];
    const re = /(https:\/\/[^\s<]+)|(#([a-z0-9]{1,20}))/gi;
    let last = 0;
    for (const m of text.matchAll(re)) {
      const at = m.index ?? 0;
      if (at > last) out.push({ kind: 'text', value: text.slice(last, at) });
      if (m[1]) out.push({ kind: 'link', value: m[1] });
      else out.push({ kind: 'tag', value: m[2] });
      last = at + m[0].length;
    }
    if (last < text.length) out.push({ kind: 'text', value: text.slice(last) });
    return out;
  }, [text]);
  return (
    <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-[#33312c]">
      {parts.map((p, i) =>
        p.kind === 'link' ? (
          <a key={i} href={p.value} target="_blank" rel="noopener noreferrer" className="text-[#1a6b52] underline decoration-[#bcd6cc] underline-offset-2 hover:decoration-[#1a6b52]">
            {p.value}
          </a>
        ) : p.kind === 'tag' ? (
          <span key={i} className="font-medium text-[#1a6b52]">
            {p.value}
          </span>
        ) : (
          <span key={i}>{p.value}</span>
        )
      )}
    </p>
  );
}

function Avatar({ photo, name }: { photo: string; name: string }) {
  const initial = (name || '?').trim().charAt(0).toUpperCase();
  return photo ? (
    <img src={photo} alt="" className="h-10 w-10 shrink-0 rounded-full object-cover ring-1 ring-[#e3e1d8]" />
  ) : (
    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[#e8f3ee] text-[15px] font-semibold text-[#1a6b52] ring-1 ring-[#d3e6dd]">
      {initial}
    </span>
  );
}

// ── Post card ──────────────────────────────────────────────────────────────────

interface PostCardProps {
  post: FeedPost;
  meUid: string | null;
  meName: string;
  liked: boolean;
  saved: boolean;
  following: boolean;
  onToggleLike: (post: FeedPost) => void;
  onShare: (post: FeedPost) => void;
  onToggleSave: (post: FeedPost) => void;
  onToggleFollow: (post: FeedPost) => void;
  onComment: (post: FeedPost, text: string) => Promise<void>;
  onDelete?: (post: FeedPost) => void;
}

function PostCard({ post, meUid, meName, liked, saved, following, onToggleLike, onShare, onToggleSave, onToggleFollow, onComment, onDelete }: PostCardProps) {
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [comments, setComments] = useState<FeedComment[] | null>(null);
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const mine = meUid != null && post.uid === meUid;

  return (
    <article className="rounded-2xl border border-[#e9e6dd] bg-white p-4 shadow-[0_1px_2px_rgba(20,20,19,0.04)] sm:p-5">
      <div className="flex items-start gap-3">
        <Avatar photo={post.photo} name={post.name} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="truncate text-[14.5px] font-semibold text-[#141413]">{post.name}</span>
            {meUid != null && !mine && (
              <button
                type="button"
                onClick={() => onToggleFollow(post)}
                className={
                  'rounded-full border px-2.5 py-0.5 text-[11.5px] font-medium transition-colors ' +
                  (following
                    ? 'border-[#d3e6dd] bg-[#e8f3ee] text-[#1a6b52]'
                    : 'border-[#e3e1d8] text-[#6b675e] hover:border-[#c9c4b8] hover:text-[#141413]')
                }
              >
                {following ? 'Following' : 'Follow'}
              </button>
            )}
            {mine && onDelete && (
              <button
                type="button"
                onClick={() => {
                  if (window.confirm('Delete this post?')) onDelete(post);
                }}
                className="rounded-full px-2 py-0.5 text-[11.5px] text-[#9c988e] transition-colors hover:text-red-600"
              >
                Delete
              </button>
            )}
          </div>
          <span className="text-[12.5px] text-[#9c988e]">{relativeTime(post.createdAtMs)}</span>
        </div>
      </div>

      <div className="mt-3">
        <LinkifiedText text={post.text} />
      </div>

      {post.link && (
        <a
          href={post.link}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 block overflow-hidden rounded-xl border border-[#e9e6dd] bg-[#faf9f5] no-underline transition-colors hover:border-[#d8d3c8]"
        >
          {post.linkImage && <img src={post.linkImage} alt="" className="max-h-56 w-full object-cover" loading="lazy" />}
          <div className="px-3.5 py-2.5">
            {post.linkTitle && <p className="truncate text-[13.5px] font-semibold text-[#141413]">{post.linkTitle}</p>}
            <p className="truncate text-[12px] text-[#9c988e]">{post.linkSite || post.link}</p>
          </div>
        </a>
      )}

      {post.topics.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {post.topics.map((t) => (
            <span key={t} className="rounded-full bg-[#f0efe9] px-2.5 py-0.5 text-[11.5px] font-medium text-[#6b675e]">
              #{t}
            </span>
          ))}
        </div>
      )}

      <div className="mt-3.5 flex items-center gap-1 border-t border-[#f0eee7] pt-2.5 text-[13px] text-[#6b675e]">
        <button
          type="button"
          disabled={meUid == null}
          onClick={() => onToggleLike(post)}
          className={
            'flex items-center gap-1.5 rounded-full px-2.5 py-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ' +
            (liked ? 'bg-red-50 text-red-600' : 'hover:bg-[#f0efe9] hover:text-[#141413]')
          }
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill={liked ? 'currentColor' : 'none'} aria-hidden="true">
            <path
              d="M8 13.4C5 11.2 2.2 9 2.2 6.3 2.2 4.5 3.6 3.2 5.3 3.2c1 0 2 .5 2.7 1.4.7-.9 1.7-1.4 2.7-1.4 1.7 0 3.1 1.3 3.1 3.1 0 2.7-2.8 4.9-5.8 7.1z"
              stroke="currentColor"
              strokeWidth="1.2"
            />
          </svg>
          {post.likeCount > 0 ? post.likeCount : 'Like'}
        </button>
        <button
          type="button"
          onClick={() => setCommentsOpen((v) => !v)}
          className="flex items-center gap-1.5 rounded-full px-2.5 py-1.5 transition-colors hover:bg-[#f0efe9] hover:text-[#141413]"
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M14 7.6c0 2.9-2.7 5.2-6 5.2-.7 0-1.4-.1-2-.3L2.6 13.4l.9-2.5C2.6 10 2 8.9 2 7.6 2 4.7 4.7 2.4 8 2.4s6 2.3 6 5.2z"
              stroke="currentColor"
              strokeWidth="1.2"
            />
          </svg>
          {post.commentCount > 0 ? post.commentCount : 'Comment'}
        </button>
        <button
          type="button"
          disabled={meUid == null}
          onClick={() => onShare(post)}
          className="flex items-center gap-1.5 rounded-full px-2.5 py-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50 hover:bg-[#f0efe9] hover:text-[#141413]"
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M9.5 3 14 6.5 9.5 10V7.6C5.8 7.6 3.6 9 2.2 11.6c0-4 2.5-6.9 7.3-7.2z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          </svg>
          {post.shareCount > 0 ? post.shareCount : 'Share'}
        </button>
        {meUid != null && (
          <button
            type="button"
            onClick={() => onToggleSave(post)}
            className={
              'ml-auto flex items-center gap-1.5 rounded-full px-2.5 py-1.5 transition-colors ' +
              (saved ? 'bg-[#e8f3ee] text-[#1a6b52]' : 'hover:bg-[#f0efe9] hover:text-[#141413]')
            }
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill={saved ? 'currentColor' : 'none'} aria-hidden="true">
              <path d="M4 2.5h8a.8.8 0 0 1 .8.8v10.2L8 10.4l-4.8 3.1V3.3a.8.8 0 0 1 .8-.8z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
            </svg>
            {saved ? 'Saved' : 'Save'}
          </button>
        )}
      </div>

      {commentsOpen && (
        <div className="mt-3 rounded-xl bg-[#faf9f5] p-3">
          <div className="max-h-72 space-y-3 overflow-y-auto">
            {comments == null ? (
              <p className="text-[13px] text-[#9c988e]">Loading comments…</p>
            ) : comments.length === 0 ? (
              <p className="text-[13px] text-[#9c988e]">No comments yet — start the thread.</p>
            ) : (
              comments.map((c) => (
                <div key={c.id} className="flex items-start gap-2.5">
                  <Avatar photo={c.photo} name={c.name} />
                  <div className="min-w-0">
                    <p className="text-[12.5px]">
                      <span className="font-semibold text-[#141413]">{c.name}</span>{' '}
                      <span className="text-[#9c988e]">{relativeTime(c.createdAtMs)}</span>
                    </p>
                    <p className="whitespace-pre-wrap break-words text-[13.5px] text-[#33312c]">{c.text}</p>
                  </div>
                </div>
              ))
            )}
          </div>
          {meUid != null && (
            <form
              className="mt-3 flex gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!draft.trim() || posting) return;
                setPosting(true);
                try {
                  await onComment(post, draft);
                  setDraft('');
                } finally {
                  setPosting(false);
                }
              }}
            >
              <input
                type="text"
                value={draft}
                maxLength={300}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Write a comment…"
                className="min-w-0 flex-1 rounded-full border border-[#e3e1d8] bg-white px-3.5 py-2 text-[13.5px] text-[#141413] placeholder:text-[#9c988e] focus:border-[#1a6b52] focus:outline-none"
              />
              <button
                type="submit"
                disabled={!draft.trim() || posting}
                className="rounded-full bg-[#1a6b52] px-4 py-2 text-[13px] font-medium text-white transition-opacity disabled:opacity-40"
              >
                Reply
              </button>
            </form>
          )}
        </div>
      )}
    </article>
  );
}

// ── Composer ───────────────────────────────────────────────────────────────────

interface ComposerProps {
  uid: string;
  name: string;
  photo: string;
  onPosted: () => void;
}

function Composer({ uid, name, photo, onPosted }: ComposerProps) {
  const [text, setText] = useState('');
  const [topics, setTopics] = useState<string[]>([]);
  const [meta, setMeta] = useState<{ url: string; title: string; image: string; site: string } | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lastFetchedUrl = useRef('');

  const url = firstUrl(text);

  // Debounced preview fetch: one request per distinct URL, only while typing.
  useEffect(() => {
    if (!url) {
      setMeta(null);
      lastFetchedUrl.current = '';
      return;
    }
    if (url === lastFetchedUrl.current) return;
    const t = setTimeout(async () => {
      lastFetchedUrl.current = url;
      setLinkBusy(true);
      const m = await fetchLinkMeta(url);
      setMeta({ url, ...m });
      setLinkBusy(false);
    }, 700);
    return () => clearTimeout(t);
  }, [url]);

  const remaining = MAX_POST_CHARS - text.length;
  const canPost = text.trim().length > 0 && remaining >= 0 && !busy;

  return (
    <div className="rounded-2xl border border-[#e9e6dd] bg-white p-4 shadow-[0_1px_2px_rgba(20,20,19,0.04)] sm:p-5">
      <div className="flex items-start gap-3">
        <Avatar photo={photo} name={name} />
        <textarea
          value={text}
          maxLength={MAX_POST_CHARS + 50}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          placeholder="Share something about AI, Myto, crypto… (attach a link and its preview shows up)"
          className="min-h-[72px] w-full resize-none rounded-xl border border-[#e9e6dd] bg-[#faf9f5] px-3.5 py-2.5 text-[15px] leading-relaxed text-[#141413] placeholder:text-[#9c988e] focus:border-[#1a6b52] focus:outline-none"
        />
      </div>

      {linkBusy && <p className="mt-2 text-[12px] text-[#9c988e]">Fetching link preview…</p>}
      {meta && (meta.title || meta.image) && (
        <div className="mt-2 flex items-center gap-3 rounded-xl border border-[#e9e6dd] bg-[#faf9f5] p-2">
          {meta.image && <img src={meta.image} alt="" className="h-14 w-20 shrink-0 rounded-lg object-cover" />}
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-semibold text-[#141413]">{meta.title || meta.url}</p>
            <p className="truncate text-[11.5px] text-[#9c988e]">{meta.site || meta.url}</p>
          </div>
          <button
            type="button"
            onClick={() => {
              setMeta(null);
              setText((t) => t.replace(meta.url, '').replace(/\s{2,}/g, ' ').trimEnd());
              lastFetchedUrl.current = '';
            }}
            className="rounded-full px-2 py-1 text-[12px] text-[#9c988e] hover:text-[#141413]"
          >
            Remove
          </button>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {TOPICS.map((t) => {
          const active = topics.includes(t);
          return (
            <button
              key={t}
              type="button"
              onClick={() => setTopics((cur) => (active ? cur.filter((x) => x !== t) : [...cur, t].slice(0, 4)))}
              className={
                'rounded-full border px-3 py-1 text-[12px] font-medium transition-colors ' +
                (active
                  ? 'border-[#1a6b52] bg-[#e8f3ee] text-[#1a6b52]'
                  : 'border-[#e3e1d8] text-[#6b675e] hover:border-[#c9c4b8]')
              }
            >
              #{t}
            </button>
          );
        })}
        <span className={'ml-auto font-mono text-[12px] ' + (remaining < 0 ? 'text-red-600' : 'text-[#9c988e]')}>
          {Math.max(0, remaining)}
        </span>
        <button
          type="button"
          disabled={!canPost}
          onClick={async () => {
            if (!canPost) return;
            setBusy(true);
            setError('');
            try {
              const attached = meta?.url ?? url ?? '';
              await createPost(
                { uid, name, photo },
                text,
                topics,
                attached,
                meta ? { title: meta.title, image: meta.image, site: meta.site } : { title: '', image: '', site: '' }
              );
              setText('');
              setTopics([]);
              setMeta(null);
              lastFetchedUrl.current = '';
              onPosted();
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Could not post. Try again.');
            } finally {
              setBusy(false);
            }
          }}
          className="rounded-full bg-[#141413] px-5 py-2 text-[13.5px] font-medium text-[#faf9f5] transition-opacity disabled:opacity-40"
        >
          {busy ? 'Posting…' : 'Post'}
        </button>
      </div>
      {error && <p className="mt-2 text-[12.5px] text-red-600">{error}</p>}
    </div>
  );
}

// ── Profile modal (my posts + saved) ───────────────────────────────────────────

function ProfileModal({
  uid,
  name,
  photo,
  savedIds,
  onComment,
  onClose,
  onUnsave,
  onDelete,
}: {
  uid: string;
  name: string;
  photo: string;
  savedIds: string[];
  onComment: (post: FeedPost, text: string) => Promise<void>;
  onClose: () => void;
  onUnsave: (postId: string) => void;
  onDelete: (postId: string) => void;
}) {
  const [tab, setTab] = useState<'posts' | 'saved'>('posts');
  const [mine, setMine] = useState<FeedPost[] | null>(null);
  const [saved, setSaved] = useState<FeedPost[] | null>(null);

  useEffect(() => {
    const un = streamFeed({ authorUid: uid, pageSize: 50 }, setMine);
    return () => un();
  }, [uid]);
  useEffect(() => {
    if (tab !== 'saved' || saved != null) return;
    void (async () => setSaved(await hydratePosts(savedIds)))();
  }, [tab, saved, savedIds]);

  const list = tab === 'posts' ? mine : saved;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6" onClick={onClose}>
      <div
        className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-t-2xl bg-[#faf9f5] p-5 shadow-xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3">
          <Avatar photo={photo} name={name} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[16px] font-semibold text-[#141413]">{name}</p>
            <p className="text-[12.5px] text-[#9c988e]">{savedIds.length} saved · your public profile on Discover</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-full px-3 py-1.5 text-[13px] text-[#6b675e] hover:bg-[#f0efe9]">
            Close
          </button>
        </div>

        <div className="mt-4 flex gap-2">
          {(['posts', 'saved'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={
                'rounded-full px-4 py-1.5 text-[13px] font-medium transition-colors ' +
                (tab === t ? 'bg-[#141413] text-[#faf9f5]' : 'bg-[#f0efe9] text-[#6b675e] hover:text-[#141413]')
              }
            >
              {t === 'posts' ? 'My posts' : 'Saved'}
            </button>
          ))}
        </div>

        <div className="mt-4 space-y-4">
          {list == null ? (
            <p className="text-[13.5px] text-[#9c988e]">Loading…</p>
          ) : list.length === 0 ? (
            <p className="text-[13.5px] text-[#9c988e]">
              {tab === 'posts' ? 'You have not posted yet.' : 'Nothing saved yet — tap Save on a post.'}
            </p>
          ) : (
              list.map((p) => (
                <div key={p.id} className="relative">
                  <PostCard
                    post={p}
                    meUid={uid}
                    meName={name}
                    liked={false}
                    saved={tab === 'saved'}
                    following={false}
                    onComment={onComment}
                    onToggleLike={() => {}}
                    onShare={() => {}}
                    onToggleSave={() => onUnsave(p.id)}
                    onToggleFollow={() => {}}
                    onDelete={tab === 'posts' ? () => onDelete(p.id) : undefined}
                  />
                </div>
              ))
          )}
        </div>
      </div>
    </div>
  );
}

// ── Sign-in prompt ─────────────────────────────────────────────────────────────

function SignInCard() {
  const { signInWithGoogle, signInWithGithub, error } = useAuth();
  return (
    <div className="rounded-2xl border border-[#e9e6dd] bg-white p-6 text-center shadow-[0_1px_2px_rgba(20,20,19,0.04)]">
      <MytoMark size={34} className="mx-auto" />
      <h2 className="mt-3 text-[19px] font-semibold text-[#141413]">Join the conversation</h2>
      <p className="mx-auto mt-1.5 max-w-[46ch] text-[14px] leading-relaxed text-[#6b675e]">
        Sign in to post, react, comment and follow — you can keep browsing the feed without an account.
      </p>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        <button
          type="button"
          onClick={() => void signInWithGoogle()}
          className="rounded-full border border-[#e3e1d8] bg-white px-5 py-2.5 text-[14px] font-medium text-[#141413] transition-colors hover:border-[#c9c4b8]"
        >
          Continue with Google
        </button>
        <button
          type="button"
          onClick={() => void signInWithGithub()}
          className="rounded-full border border-[#e3e1d8] bg-white px-5 py-2.5 text-[14px] font-medium text-[#141413] transition-colors hover:border-[#c9c4b8]"
        >
          Continue with GitHub
        </button>
      </div>
      {error && <p className="mt-3 text-[12.5px] text-red-600">{error}</p>}
    </div>
  );
}

// ── The page ───────────────────────────────────────────────────────────────────

export function DiscoverFeed() {
  const { user, profile, loading } = useAuth();
  const meUid = user?.uid ?? null;
  const meName = profile?.name || user?.displayName || 'Anonymous';
  const mePhoto = profile?.photoURL || user?.photoURL || '';

  const [tab, setTab] = useState<'feeds' | 'following'>('feeds');
  const [topic, setTopic] = useState('');
  const [posts, setPosts] = useState<FeedPost[] | null>(null);
  const [likedIds, setLikedIds] = useState<Set<string>>(new Set());
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [followingIds, setFollowingIds] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState('');
  const [profileOpen, setProfileOpen] = useState(false);
  const toastTimer = useRef<number | undefined>(undefined);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 2400);
  }, []);

  // Per-tab/topic live feed. The Following tab fetches once (its author set changes
  // rarely); Feeds is a live snapshot subscription.
  useEffect(() => {
    if (tab === 'following') {
      if (meUid == null) {
        setPosts([]);
        return;
      }
      let alive = true;
      void (async () => {
        const ids = await getFollowingIds(meUid);
        const list = await fetchPostsByAuthors(ids);
        if (alive) setPosts(list);
      })();
      return () => {
        alive = false;
      };
    }
    const un = streamFeed({ topic: topic || undefined }, setPosts);
    return () => un();
  }, [tab, topic, meUid]);

  // My saved + following sets (needs sign-in).
  useEffect(() => {
    if (meUid == null) {
      setSavedIds(new Set());
      setFollowingIds(new Set());
      return;
    }
    let alive = true;
    void (async () => {
      const [saved, following] = await Promise.all([listSavedIds(meUid), getFollowingIds(meUid)]);
      if (!alive) return;
      setSavedIds(new Set(saved));
      setFollowingIds(new Set(following));
    })();
    return () => {
      alive = false;
    };
  }, [meUid, tab]);

  const author = useMemo(() => ({ uid: meUid ?? '', name: meName, photo: mePhoto }), [meUid, meName, mePhoto]);

  const act = useCallback(
    async (fn: () => Promise<unknown>, ok?: string) => {
      try {
        await fn();
        if (ok) showToast(ok);
      } catch (e) {
        const code = (e as { code?: string })?.code ?? '';
        showToast(code.includes('permission') ? 'You need to sign in for that.' : 'Something went wrong — try again.');
      }
    },
    [showToast]
  );

  const handleComment = useCallback(
    async (post: FeedPost, text: string) => {
      if (meUid == null) return;
      await act(async () => {
        await addComment(post.id, { uid: meUid, name: meName, photo: mePhoto }, text);
      });
    },
    [meUid, meName, mePhoto, act]
  );

  return (
    <div id="top" className="flex min-h-screen flex-col bg-[#faf9f5]">
      <a className="skip-link" href="#feed">
        Skip to the feed
      </a>
      <Header subpage />
      <main id="feed" className="relative z-10 mx-auto w-full max-w-2xl flex-1 px-4 pb-16 pt-8">
        <div className="mb-6 text-center">
          <p className="eyebrow">Discover</p>
          <h1 className="mt-3 font-display text-[34px] leading-tight tracking-[-0.01em] text-[#141413] sm:text-[44px]">
            The Myto community
          </h1>
          <p className="mx-auto mt-3 max-w-[52ch] text-[15.5px] leading-relaxed text-[#544f46]">
            Short takes on AI, Myto, crypto and everything in between. Text posts only — attach a
            link and its site preview rides along.
          </p>
        </div>

        {loading ? (
          <p className="py-10 text-center text-[14px] text-[#9c988e]">Loading…</p>
        ) : meUid == null ? (
          <div className="mb-6">
            <SignInCard />
          </div>
        ) : (
          <div className="mb-6">
            <Composer uid={meUid} name={meName} photo={mePhoto} onPosted={() => showToast('Posted to Discover.')} />
          </div>
        )}

        <div className="mb-3 flex items-center gap-2">
          <div className="flex rounded-full border border-[#e3e1d8] bg-white p-0.5">
            {(['feeds', 'following'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={
                  'rounded-full px-4 py-1.5 text-[13px] font-medium transition-colors ' +
                  (tab === t ? 'bg-[#141413] text-[#faf9f5]' : 'text-[#6b675e] hover:text-[#141413]')
                }
              >
                {t === 'feeds' ? 'Feeds' : 'Following'}
              </button>
            ))}
          </div>
          {meUid != null && (
            <button
              type="button"
              onClick={() => setProfileOpen(true)}
              className="ml-auto rounded-full border border-[#e3e1d8] bg-white px-4 py-1.5 text-[13px] font-medium text-[#141413] transition-colors hover:border-[#c9c4b8]"
            >
              My profile
            </button>
          )}
        </div>

        <div className="mb-5 flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setTopic('')}
            className={
              'rounded-full px-3 py-1 text-[12px] font-medium transition-colors ' +
              (topic === '' ? 'bg-[#141413] text-[#faf9f5]' : 'bg-[#f0efe9] text-[#6b675e] hover:text-[#141413]')
            }
          >
            All
          </button>
          {TOPICS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTopic(topic === t ? '' : t)}
              className={
                'rounded-full px-3 py-1 text-[12px] font-medium transition-colors ' +
                (topic === t ? 'bg-[#141413] text-[#faf9f5]' : 'bg-[#f0efe9] text-[#6b675e] hover:text-[#141413]')
              }
            >
              #{t}
            </button>
          ))}
        </div>

        <div className="space-y-4">
          {posts == null ? (
            <p className="py-10 text-center text-[14px] text-[#9c988e]">Loading the feed…</p>
          ) : posts.length === 0 ? (
            <p className="py-10 text-center text-[14px] text-[#9c988e]">
              {tab === 'following'
                ? 'Follow authors and their posts land here.'
                : 'Nothing here yet — be the first to post.'}
            </p>
          ) : (
            posts.map((p) => (
              <PostCard
                key={p.id}
                post={p}
                meUid={meUid}
                meName={meName}
                liked={likedIds.has(p.id)}
                saved={savedIds.has(p.id)}
                following={followingIds.has(p.uid)}
                onComment={handleComment}
                onToggleLike={(post) =>
                  meUid != null &&
                  act(async () => {
                    const nowLiked = await toggleLike(post.id, meUid);
                    setLikedIds((cur) => {
                      const next = new Set(cur);
                      if (nowLiked) next.add(post.id);
                      else next.delete(post.id);
                      return next;
                    });
                  })
                }
                onShare={(post) =>
                  meUid != null &&
                  act(async () => {
                    await sharePost(post.id, { uid: meUid, name: meName, photo: mePhoto });
                    const url = `${window.location.origin}/discover?post=${post.id}`;
                    await navigator.clipboard.writeText(url).catch(() => {});
                    showToast('Reposted to your profile — link copied.');
                  })
                }
                onToggleSave={(post) =>
                  meUid != null &&
                  act(async () => {
                    if (savedIds.has(post.id)) {
                      await unsaveFromProfile(post.id, meUid);
                      setSavedIds((cur) => {
                        const next = new Set(cur);
                        next.delete(post.id);
                        return next;
                      });
                      showToast('Removed from your profile.');
                    } else {
                      await saveToProfile(post.id, meUid);
                      setSavedIds((cur) => new Set(cur).add(post.id));
                      showToast('Saved to your profile.');
                    }
                  })
                }
                onToggleFollow={(post) =>
                  meUid != null &&
                  act(async () => {
                    if (followingIds.has(post.uid)) {
                      await unfollowAuthor(meUid, post.uid);
                      setFollowingIds((cur) => {
                        const next = new Set(cur);
                        next.delete(post.uid);
                        return next;
                      });
                    } else {
                      await followAuthor(meUid, post.uid);
                      setFollowingIds((cur) => new Set(cur).add(post.uid));
                      showToast(`Following ${post.name}.`);
                    }
                  })
                }
                onDelete={(post) =>
                  act(async () => {
                    await deletePost(post.id, meUid ?? '');
                    setPosts((cur) => (cur ? cur.filter((x) => x.id !== post.id) : cur));
                    showToast('Post deleted.');
                  })
                }
              />
            ))
          )}
        </div>
      </main>

      {/* Like flags hydrate lazily so hearts show the right state per device. */}
      <LikedFlags posts={posts} meUid={meUid} onLoaded={(id, liked) =>
        setLikedIds((cur) => {
          if (cur.has(id) === liked) return cur;
          const next = new Set(cur);
          if (liked) next.add(id);
          else next.delete(id);
          return next;
        })
      } />

      {profileOpen && meUid != null && (
        <ProfileModal
          uid={meUid}
          name={meName}
          photo={mePhoto}
          savedIds={[...savedIds]}
          onComment={handleComment}
          onClose={() => setProfileOpen(false)}
          onUnsave={(id) => {
            void unsaveFromProfile(id, meUid);
            setSavedIds((cur) => {
              const next = new Set(cur);
              next.delete(id);
              return next;
            });
          }}
          onDelete={(id) => {
            void deletePost(id, meUid);
            setPosts((cur) => (cur ? cur.filter((p) => p.id !== id) : cur));
          }}
        />
      )}

      {toast && (
        <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-full bg-[#141413] px-4 py-2 text-[13px] text-[#faf9f5] shadow-lg">
          {toast}
        </div>
      )}

      <Footer />
    </div>
  );
}

/** Lazily check the like state of each visible post (one doc read per post). */
function LikedFlags({
  posts,
  meUid,
  onLoaded,
}: {
  posts: FeedPost[] | null;
  meUid: string | null;
  onLoaded: (id: string, liked: boolean) => void;
}) {
  useEffect(() => {
    if (!posts || meUid == null) return;
    let alive = true;
    void (async () => {
      for (const p of posts.slice(0, 30)) {
        if (!alive) return;
        const liked = await isLikedBy(p.id, meUid);
        onLoaded(p.id, liked);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posts?.map((p) => p.id).join(','), meUid]);
  return null;
}
