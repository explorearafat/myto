// /discover — the Myto community feed, now structured like a real social app:
//
//   • Four destinations in a top nav: Feed (recent) · Viral (most-liked) ·
//     Following (people you follow) · Profile (yours — setup, posts, saves).
//   • Sign-in is a proper screen: the Myto mark, "Create an account" heading,
//     an intro paragraph, email + password signup/sign-in, and one-tap
//     Google/GitHub — all backed by the same account across every client.
//   • First-time users set up a Discover profile (name, handle, bio) before
//     posting; the handle is registered create-once so it can never be stolen.
//
// Data model and security: see src/lib/social.ts + firestore.rules.

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
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
  firstUrl,
  followAuthor,
  getFollowingIds,
  getProfile,
  hydratePosts,
  isHandleFree,
  isLikedBy,
  listSavedIds,
  MAX_POST_CHARS,
  saveProfile,
  saveToProfile,
  sharePost,
  signInWithEmail,
  signUpWithEmail,
  streamComments,
  streamFeed,
  streamViralFeed,
  TOPICS,
  toggleLike,
  unfollowAuthor,
  unsaveFromProfile,
  type DiscoverProfile,
  type FeedComment,
  type FeedPost,
} from '../lib/social';

// ── Shared bits ────────────────────────────────────────────────────────────────

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

function Avatar({ photo, name, size = 40 }: { photo: string; name: string; size?: number }) {
  const initial = (name || '?').trim().charAt(0).toUpperCase();
  return photo ? (
    <img
      src={photo}
      alt=""
      style={{ width: size, height: size }}
      className="shrink-0 rounded-full object-cover ring-1 ring-[#e3e1d8]"
    />
  ) : (
    <span
      style={{ width: size, height: size, fontSize: size * 0.38 }}
      className="grid shrink-0 place-items-center rounded-full bg-[#e8f3ee] font-semibold text-[#1a6b52] ring-1 ring-[#d3e6dd]"
    >
      {initial}
    </span>
  );
}

function Spinner({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-2.5 py-12 text-[13.5px] text-[#9c988e]">
      <span className="h-2 w-2 animate-pulse rounded-full bg-[#1a6b52]" />
      <span className="h-2 w-2 animate-pulse rounded-full bg-[#1a6b52] [animation-delay:150ms]" />
      <span className="h-2 w-2 animate-pulse rounded-full bg-[#1a6b52] [animation-delay:300ms]" />
      {label}
    </div>
  );
}

// ── Auth screen ────────────────────────────────────────────────────────────────

function AuthScreen() {
  const { signInWithGoogle, signInWithGithub, error: authError } = useAuth();
  const [mode, setMode] = useState<'signup' | 'signin'>('signup');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError('');
    if (mode === 'signup' && name.trim().length < 2) {
      setError('Tell us your name — it shows on your posts.');
      return;
    }
    if (password.length < 6) {
      setError('Password needs at least 6 characters.');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'signup') await signUpWithEmail(email, password, name);
      else await signInWithEmail(email, password);
    } catch (err) {
      const code = (err as { code?: string })?.code ?? '';
      setError(
        code.includes('email-already-in-use')
          ? 'That email already has an account — sign in instead.'
          : code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found')
            ? 'Email or password is incorrect.'
            : code.includes('weak-password')
              ? 'Password needs at least 6 characters.'
              : code.includes('operation-not-allowed')
                ? 'Email sign-in is not enabled yet — use Google or GitHub below.'
                : 'Could not sign you in. Try again.'
      );
    } finally {
      setBusy(false);
    }
  };

  const input =
    'w-full rounded-xl border border-[#e3e1d8] bg-white px-4 py-3 text-[15px] text-[#141413] placeholder:text-[#9c988e] focus:border-[#1a6b52] focus:outline-none';

  return (
    <div className="mx-auto max-w-md">
      <div className="rounded-2xl border border-[#e9e6dd] bg-white p-7 shadow-[0_24px_60px_-40px_rgba(20,20,19,0.35)]">
        <div className="flex flex-col items-center text-center">
          <MytoMark size={40} />
          <h1 className="mt-4 font-display text-[26px] leading-tight tracking-[-0.01em] text-[#141413]">
            Create an account
          </h1>
          <p className="mt-1 text-[14px] font-medium text-[#1a6b52]">Discover Myto</p>
          <p className="mt-3 max-w-[40ch] text-[13.5px] leading-relaxed text-[#6b675e]">
            One account for the whole workspace — post to the community, save what you
            like, and sync your setup across the desktop and Android apps.
          </p>
        </div>

        <form className="mt-6 space-y-3" onSubmit={submit}>
          {mode === 'signup' && (
            <input
              type="text"
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              autoComplete="name"
              className={input}
            />
          )}
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email address"
            autoComplete="email"
            className={input}
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            className={input}
          />
          <button
            type="submit"
            disabled={busy || !email.trim() || !password}
            className="w-full rounded-xl bg-[#141413] px-4 py-3 text-[15px] font-medium text-[#faf9f5] transition-opacity disabled:opacity-40"
          >
            {busy ? 'Please wait…' : mode === 'signup' ? 'Create account' : 'Sign in'}
          </button>
        </form>

        <div className="my-5 flex items-center gap-3 text-[12px] text-[#9c988e]">
          <span className="h-px flex-1 bg-[#e9e6dd]" />
          or
          <span className="h-px flex-1 bg-[#e9e6dd]" />
        </div>

        <div className="space-y-2.5">
          <button
            type="button"
            onClick={() => void signInWithGoogle()}
            className="flex w-full items-center justify-center gap-3 rounded-xl border border-[#e4e1d8] bg-white px-4 py-3 text-[15px] font-medium text-[#141413] transition-colors duration-150 hover:border-[#cbc6ba] hover:bg-[#fbfaf7]"
          >
            <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z" />
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
              <path fill="#FBBC05" d="M5.84 14.1c-.22-.66-.35-1.36-.35-2.1s.13-1.44.35-2.1V7.06H2.18A10.96 10.96 0 0 0 1 12c0 1.77.43 3.45 1.18 4.94l3.66-2.84z" />
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
            </svg>
            Continue with Google
          </button>
          <button
            type="button"
            onClick={() => void signInWithGithub()}
            className="flex w-full items-center justify-center gap-3 rounded-xl border border-[#e4e1d8] bg-white px-4 py-3 text-[15px] font-medium text-[#141413] transition-colors duration-150 hover:border-[#cbc6ba] hover:bg-[#fbfaf7]"
          >
            <svg width="17" height="17" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
            </svg>
            Continue with GitHub
          </button>
        </div>

        {(error || authError) && (
          <p className="mt-4 text-center text-[12.5px] text-red-600">{error || authError}</p>
        )}

        <p className="mt-5 text-center text-[13px] text-[#6b675e]">
          {mode === 'signup' ? 'Already have an account?' : 'New to Myto?'}{' '}
          <button
            type="button"
            onClick={() => {
              setMode(mode === 'signup' ? 'signin' : 'signup');
              setError('');
            }}
            className="font-medium text-[#1a6b52] underline decoration-[#bcd6cc] underline-offset-2 hover:decoration-[#1a6b52]"
          >
            {mode === 'signup' ? 'Sign in' : 'Create one'}
          </button>
        </p>
      </div>

      <p className="mx-auto mt-5 max-w-[44ch] text-center text-[12.5px] leading-relaxed text-[#9c988e]">
        Reading the feed needs no account. Signing in unlocks posting, reactions,
        comments, follows — and syncs your setup across every Myto app.
      </p>
    </div>
  );
}

// ── Profile setup ──────────────────────────────────────────────────────────────

function ProfileSetup({
  uid,
  defaultName,
  defaultPhoto,
  onDone,
}: {
  uid: string;
  defaultName: string;
  defaultPhoto: string;
  onDone: () => void;
}) {
  const [name, setName] = useState(defaultName);
  const [username, setUsername] = useState('');
  const [bio, setBio] = useState('');
  const [checking, setChecking] = useState(false);
  const [free, setFree] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const debounce = useRef<number | undefined>(undefined);

  useEffect(() => {
    const handle = username.trim().toLowerCase();
    if (!handle) {
      setFree(null);
      return;
    }
    setChecking(true);
    window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(async () => {
      if (!/^[a-z0-9_]{3,20}$/.test(handle)) {
        setFree(false);
        setChecking(false);
        return;
      }
      setFree(await isHandleFree(handle));
      setChecking(false);
    }, 450);
    return () => window.clearTimeout(debounce.current);
  }, [username]);

  const valid =
    name.trim().length >= 2 &&
    free === true &&
    /^[a-z0-9_]{3,20}$/.test(username.trim().toLowerCase());

  return (
    <div className="mx-auto max-w-md">
      <div className="rounded-2xl border border-[#e9e6dd] bg-white p-7 shadow-[0_24px_60px_-40px_rgba(20,20,19,0.35)]">
        <div className="flex flex-col items-center text-center">
          <Avatar photo={defaultPhoto} name={name || '?'} size={56} />
          <h2 className="mt-4 font-display text-[24px] tracking-[-0.01em] text-[#141413]">
            Set up your profile
          </h2>
          <p className="mt-2 max-w-[38ch] text-[13.5px] leading-relaxed text-[#6b675e]">
            This is how the community sees you — on your posts, comments, and follows.
          </p>
        </div>

        <div className="mt-6 space-y-3">
          <div>
            <label className="mb-1 block text-[12px] font-medium text-[#6b675e]">Display name</label>
            <input
              type="text"
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
              placeholder="Eyasin Arafat"
              className="w-full rounded-xl border border-[#e3e1d8] bg-white px-4 py-3 text-[15px] text-[#141413] placeholder:text-[#9c988e] focus:border-[#1a6b52] focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-[12px] font-medium text-[#6b675e]">Username</label>
            <div className="relative">
              <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 font-mono text-[14px] text-[#9c988e]">
                @
              </span>
              <input
                type="text"
                value={username}
                maxLength={20}
                onChange={(e) => setUsername(e.target.value.toLowerCase())}
                placeholder="eyasin"
                className="w-full rounded-xl border border-[#e3e1d8] bg-white px-4 py-3 pl-8 text-[15px] text-[#141413] placeholder:text-[#9c988e] focus:border-[#1a6b52] focus:outline-none"
              />
            </div>
            <p
              className={
                'mt-1.5 text-[11.5px] ' +
                (free === true
                  ? 'text-[#1a6b52]'
                  : free === false
                    ? 'text-red-600'
                    : 'text-[#9c988e]')
              }
            >
              {checking
                ? 'Checking availability…'
                : free === true
                  ? `@${username} is available`
                  : username
                    ? '3-20 chars: a-z, 0-9, underscore — must be unique'
                    : 'Lowercase letters, digits, underscore'}
            </p>
          </div>
          <div>
            <label className="mb-1 block text-[12px] font-medium text-[#6b675e]">
              Bio <span className="text-[#9c988e]">(optional)</span>
            </label>
            <textarea
              value={bio}
              maxLength={280}
              rows={3}
              onChange={(e) => setBio(e.target.value)}
              placeholder="Builder. AI, cybersecurity, the web."
              className="w-full resize-none rounded-xl border border-[#e3e1d8] bg-white px-4 py-3 text-[14.5px] leading-relaxed text-[#141413] placeholder:text-[#9c988e] focus:border-[#1a6b52] focus:outline-none"
            />
            <p className="mt-1 text-right font-mono text-[11px] text-[#9c988e]">{bio.length}/280</p>
          </div>
          <button
            type="button"
            disabled={!valid || busy}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                const ok = await saveProfile(uid, { name, username, bio, photo: defaultPhoto });
                if (ok) onDone();
                else setError('That username was just taken — try another.');
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Could not save. Try again.');
              } finally {
                setBusy(false);
              }
            }}
            className="w-full rounded-xl bg-[#141413] px-4 py-3 text-[15px] font-medium text-[#faf9f5] transition-opacity disabled:opacity-40"
          >
            {busy ? 'Saving…' : 'Create profile'}
          </button>
          {error && <p className="text-center text-[12.5px] text-red-600">{error}</p>}
        </div>
      </div>
    </div>
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
  onToggleLike: () => void;
  onShare: () => void;
  onToggleSave: () => void;
  onToggleFollow: () => void;
  onComment: (text: string) => Promise<void>;
  onDelete?: () => void;
}

function PostCard({
  post,
  meUid,
  liked,
  saved,
  following,
  onToggleLike,
  onShare,
  onToggleSave,
  onToggleFollow,
  onComment,
  onDelete,
}: PostCardProps) {
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
                onClick={onToggleFollow}
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
                onClick={onDelete}
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
          onClick={onToggleLike}
          className={
            'flex items-center gap-1.5 rounded-full px-2.5 py-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ' +
            (liked ? 'bg-red-50 text-red-600' : 'hover:bg-[#f0efe9] hover:text-[#141413]')
          }
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill={liked ? 'currentColor' : 'none'} aria-hidden="true">
            <path d="M8 13.4C5 11.2 2.2 9 2.2 6.3 2.2 4.5 3.6 3.2 5.3 3.2c1 0 2 .5 2.7 1.4.7-.9 1.7-1.4 2.7-1.4 1.7 0 3.1 1.3 3.1 3.1 0 2.7-2.8 4.9-5.8 7.1z" stroke="currentColor" strokeWidth="1.2" />
          </svg>
          {post.likeCount > 0 ? post.likeCount : 'Like'}
        </button>
        <button
          type="button"
          onClick={() => setCommentsOpen((v) => !v)}
          className="flex items-center gap-1.5 rounded-full px-2.5 py-1.5 transition-colors hover:bg-[#f0efe9] hover:text-[#141413]"
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M14 7.6c0 2.9-2.7 5.2-6 5.2-.7 0-1.4-.1-2-.3L2.6 13.4l.9-2.5C2.6 10 2 8.9 2 7.6 2 4.7 4.7 2.4 8 2.4s6 2.3 6 5.2z" stroke="currentColor" strokeWidth="1.2" />
          </svg>
          {post.commentCount > 0 ? post.commentCount : 'Comment'}
        </button>
        <button
          type="button"
          disabled={meUid == null}
          onClick={onShare}
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
            onClick={onToggleSave}
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
                  <Avatar photo={c.photo} name={c.name} size={30} />
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
                  await onComment(draft);
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

function Composer({
  meUid,
  meName,
  mePhoto,
  onPosted,
}: {
  meUid: string;
  meName: string;
  mePhoto: string;
  onPosted: () => void;
}) {
  const [text, setText] = useState('');
  const [topics, setTopics] = useState<string[]>([]);
  const [meta, setMeta] = useState<{ url: string; title: string; image: string; site: string } | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lastFetchedUrl = useRef('');

  const url = firstUrl(text);

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
        <Avatar photo={mePhoto} name={meName} />
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
                { uid: meUid, name: meName, photo: mePhoto },
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

// ── Profile view ───────────────────────────────────────────────────────────────

function ProfileView({
  uid,
  profile,
  savedIds,
  onUnsave,
}: {
  uid: string;
  profile: DiscoverProfile | null;
  savedIds: Set<string>;
  onUnsave: (postId: string) => void;
}) {
  const [tab, setTab] = useState<'posts' | 'saved'>('posts');
  const [posts, setPosts] = useState<FeedPost[] | null>(null);
  const [saved, setSaved] = useState<FeedPost[] | null>(null);

  useEffect(() => {
    const un = streamFeed({ authorUid: uid, pageSize: 50 }, setPosts);
    return () => un();
  }, [uid]);
  useEffect(() => {
    if (tab !== 'saved' || saved != null) return;
    void (async () => setSaved(await hydratePosts([...savedIds])))();
  }, [tab, saved, savedIds]);

  const list = tab === 'posts' ? posts : saved;

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-[#e9e6dd] bg-white p-5">
        <div className="flex items-center gap-4">
          <Avatar photo={profile?.photo ?? ''} name={profile?.name ?? 'You'} size={56} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[18px] font-semibold text-[#141413]">
              {profile?.name ?? 'You'}
            </p>
            {profile?.username && (
              <p className="font-mono text-[13px] text-[#1a6b52]">@{profile.username}</p>
            )}
            {profile?.bio && <p className="mt-1 text-[13.5px] leading-relaxed text-[#544f46]">{profile.bio}</p>}
          </div>
        </div>
        <div className="mt-4 flex gap-6 border-t border-[#f0eee7] pt-4 text-[13px]">
          <span className="text-[#6b675e]">
            <span className="font-semibold text-[#141413]">{posts?.length ?? 0}</span> posts
          </span>
          <span className="text-[#6b675e]">
            <span className="font-semibold text-[#141413]">{savedIds.size}</span> saved
          </span>
        </div>
      </div>

      <div className="flex rounded-full border border-[#e3e1d8] bg-white p-0.5">
        {(['posts', 'saved'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={
              'flex-1 rounded-full px-4 py-2 text-[13px] font-medium transition-colors ' +
              (tab === t ? 'bg-[#141413] text-[#faf9f5]' : 'text-[#6b675e] hover:text-[#141413]')
            }
          >
            {t === 'posts' ? 'My posts' : 'Saved'}
          </button>
        ))}
      </div>

      {list == null ? (
        <Spinner label="Loading…" />
      ) : list.length === 0 ? (
        <p className="py-10 text-center text-[13.5px] text-[#9c988e]">
          {tab === 'posts' ? 'You have not posted yet.' : 'Nothing saved yet — tap Save on a post.'}
        </p>
      ) : (
        <div className="space-y-4">
          {list.map((p) => (
            <PostCard
              key={p.id}
              post={p}
              meUid={uid}
              meName={profile?.name ?? 'You'}
              liked={false}
              saved={tab === 'saved'}
              following={false}
              onComment={async () => {}}
              onToggleLike={() => {}}
              onShare={() => {}}
              onToggleSave={() => onUnsave(p.id)}
              onToggleFollow={() => {}}
              onDelete={
                tab === 'posts'
                  ? () => {
                      void deletePost(p.id, uid);
                      setPosts((cur) => (cur ? cur.filter((x) => x.id !== p.id) : cur));
                    }
                  : undefined
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Feed list (shared) ─────────────────────────────────────────────────────────

function FeedList({
  posts,
  dest,
  meUid,
  meName,
  likedIds,
  savedIds,
  followingIds,
  act,
  handleComment,
  setLikedIds,
  setPosts,
  setFollowingIds,
  setSavedIds,
  showToast,
}: {
  posts: FeedPost[] | null;
  dest: Dest;
  meUid: string | null;
  meName: string;
  likedIds: Set<string>;
  savedIds: Set<string>;
  followingIds: Set<string>;
  act: (fn: () => Promise<unknown>, ok?: string) => Promise<void>;
  handleComment: (post: FeedPost, text: string) => Promise<void>;
  setLikedIds: Dispatch<SetStateAction<Set<string>>>;
  setPosts: Dispatch<SetStateAction<FeedPost[] | null>>;
  setFollowingIds: Dispatch<SetStateAction<Set<string>>>;
  setSavedIds: Dispatch<SetStateAction<Set<string>>>;
  showToast: (msg: string) => void;
}) {
  if (posts == null) return <Spinner label="Loading the feed…" />;
  if (posts.length === 0)
    return (
      <p className="py-12 text-center text-[13.5px] text-[#9c988e]">
        {dest === 'following'
          ? 'Follow authors and their posts land here.'
          : dest === 'viral'
            ? 'No popular posts yet — likes decide what rises.'
            : 'Nothing here yet — be the first to post.'}
      </p>
    );
  return (
    <>
      {posts.map((p) => (
        <PostCard
          key={p.id}
          post={p}
          meUid={meUid}
          meName={meName}
          liked={likedIds.has(p.id)}
          saved={savedIds.has(p.id)}
          following={followingIds.has(p.uid)}
          onComment={(text) => handleComment(p, text)}
          onToggleLike={() =>
            meUid != null &&
            act(async () => {
              const nowLiked = await toggleLike(p.id, meUid);
              setLikedIds((cur) => {
                const next = new Set(cur);
                if (nowLiked) next.add(p.id);
                else next.delete(p.id);
                return next;
              });
            })
          }
          onShare={() =>
            meUid != null &&
            act(async () => {
              await sharePost(p.id, { uid: meUid, name: meName, photo: '' });
              await navigator.clipboard.writeText(`${window.location.origin}/discover?post=${p.id}`).catch(() => {});
              showToast('Reposted — link copied.');
            })
          }
          onToggleSave={() =>
            meUid != null &&
            act(async () => {
              if (savedIds.has(p.id)) {
                await unsaveFromProfile(p.id, meUid);
                setSavedIds((cur) => {
                  const next = new Set(cur);
                  next.delete(p.id);
                  return next;
                });
                showToast('Removed from your profile.');
              } else {
                await saveToProfile(p.id, meUid);
                setSavedIds((cur) => new Set(cur).add(p.id));
                showToast('Saved to your profile.');
              }
            })
          }
          onToggleFollow={() =>
            meUid != null &&
            act(async () => {
              if (followingIds.has(p.uid)) {
                await unfollowAuthor(meUid, p.uid);
                setFollowingIds((cur) => {
                  const next = new Set(cur);
                  next.delete(p.uid);
                  return next;
                });
              } else {
                await followAuthor(meUid, p.uid);
                setFollowingIds((cur) => new Set(cur).add(p.uid));
                showToast(`Following ${p.name}.`);
              }
            })
          }
          onDelete={
            p.uid === meUid
              ? () =>
                  act(async () => {
                    await deletePost(p.id, meUid);
                    setPosts((cur) => (cur ? cur.filter((x) => x.id !== p.id) : cur));
                    showToast('Post deleted.');
                  })
              : undefined
          }
        />
      ))}
    </>
  );
}

/** Signed-out composer hint — points at the auth screen instead of a dead form. */
function ComposerGate({ onGoProfile }: { onGoProfile: () => void }) {
  return (
    <div className="rounded-2xl border border-[#e9e6dd] bg-white p-4 text-center shadow-[0_1px_2px_rgba(20,20,19,0.04)]">
      <p className="text-[14px] text-[#544f46]">Create an account to post, react, and follow.</p>
      <button type="button" onClick={onGoProfile} className="btn btn-dark mt-3 px-6 py-2.5 text-[14px]">
        Create an account
      </button>
    </div>
  );
}

// ── The page ───────────────────────────────────────────────────────────────────

type Dest = 'feed' | 'viral' | 'following' | 'profile';

export function DiscoverFeed() {
  const { user, loading } = useAuth();
  const meUid = user?.uid ?? null;
  const meName = user?.displayName?.trim() || 'Anonymous';
  const mePhoto = user?.photoURL ?? '';

  const [dest, setDest] = useState<Dest>('feed');
  const [topic, setTopic] = useState('');
  const [posts, setPosts] = useState<FeedPost[] | null>(null);
  const [profile, setProfile] = useState<DiscoverProfile | null | undefined>(undefined); // undefined = loading
  const [likedIds, setLikedIds] = useState<Set<string>>(new Set());
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [followingIds, setFollowingIds] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState('');
  const toastTimer = useRef<number | undefined>(undefined);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 2400);
  }, []);

  // My profile doc (drives the setup gate + Profile destination).
  useEffect(() => {
    if (meUid == null) {
      setProfile(null);
      return;
    }
    let alive = true;
    void (async () => {
      const p = await getProfile(meUid);
      if (alive) setProfile(p);
    })();
    return () => {
      alive = false;
    };
  }, [meUid]);

  // Feed data per destination.
  useEffect(() => {
    if (meUid == null && dest !== 'feed' && dest !== 'viral') {
      setPosts([]);
      return;
    }
    if (dest === 'viral') {
      const un = streamViralFeed({ topic: topic || undefined }, setPosts);
      return () => un();
    }
    if (dest === 'feed') {
      const un = streamFeed({ topic: topic || undefined }, setPosts);
      return () => un();
    }
    if (dest === 'following') {
      let alive = true;
      void (async () => {
        const ids = meUid ? await getFollowingIds(meUid) : [];
        const list = await fetchPostsByAuthors(ids);
        if (alive) setPosts(list);
      })();
      return () => {
        alive = false;
      };
    }
    setPosts(null); // profile: ProfileView streams its own
    return undefined;
  }, [dest, topic, meUid]);

  // Saved + following sets.
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
  }, [meUid, dest]);

  // Lazy like flags.
  useEffect(() => {
    if (!posts || meUid == null) return;
    let alive = true;
    void (async () => {
      for (const p of posts.slice(0, 30)) {
        if (!alive) return;
        const liked = await isLikedBy(p.id, meUid);
        setLikedIds((cur) => {
          if (cur.has(p.id) === liked) return cur;
          const next = new Set(cur);
          if (liked) next.add(p.id);
          else next.delete(p.id);
          return next;
        });
      }
    })();
    return () => {
      alive = false;
    };
  }, [posts, meUid]);

  const act = useCallback(
    async (fn: () => Promise<unknown>, ok?: string) => {
      try {
        await fn();
        if (ok) showToast(ok);
      } catch {
        showToast('Something went wrong — try again.');
      }
    },
    [showToast]
  );

  const handleComment = useCallback(
    async (post: FeedPost, text: string) => {
      if (meUid == null) return;
      await act(() => addComment(post.id, { uid: meUid, name: meName, photo: mePhoto }, text));
    },
    [meUid, meName, mePhoto, act]
  );

  const needsProfile = meUid != null && profile === null;

  const DESTS: Array<{ key: Dest; label: string }> = [
    { key: 'feed', label: 'Feed' },
    { key: 'viral', label: 'Viral' },
    { key: 'following', label: 'Following' },
    { key: 'profile', label: 'Profile' },
  ];

  return (
    <div id="top" className="flex min-h-screen flex-col bg-[#faf9f5]">
      <a className="skip-link" href="#feed">
        Skip to the feed
      </a>
      <Header subpage />
      <main id="feed" className="relative z-10 mx-auto w-full max-w-2xl flex-1 px-4 pb-16 pt-6">
        {/* The app-style nav: four destinations, no marketing copy. */}
        <nav className="mb-5 flex rounded-full border border-[#e3e1d8] bg-white p-1">
          {DESTS.map((d) => (
            <button
              key={d.key}
              type="button"
              onClick={() => setDest(d.key)}
              className={
                'flex-1 rounded-full px-2 py-2 text-[13px] font-medium transition-colors sm:px-4 ' +
                (dest === d.key ? 'bg-[#141413] text-[#faf9f5]' : 'text-[#6b675e] hover:text-[#141413]')
              }
            >
              {d.label}
            </button>
          ))}
        </nav>

        {loading ? (
          <Spinner label="Loading…" />
        ) : meUid == null ? (
          dest === 'profile' ? (
            <AuthScreen />
          ) : (
            <>
              <ComposerGate onGoProfile={() => setDest('profile')} />
              <div className="mt-5 space-y-4">
                <FeedList
                  posts={posts}
                  dest={dest}
                  meUid={meUid}
                  meName={meName}
                  likedIds={likedIds}
                  savedIds={savedIds}
                  followingIds={followingIds}
                  act={act}
                  handleComment={handleComment}
                  setLikedIds={setLikedIds}
                  setPosts={setPosts}
                  setFollowingIds={setFollowingIds}
                  setSavedIds={setSavedIds}
                  showToast={showToast}
                />
              </div>
            </>
          )
        ) : needsProfile ? (
          <ProfileSetup
            uid={meUid}
            defaultName={meName}
            defaultPhoto={mePhoto}
            onDone={() => {
              void (async () => {
                setProfile(await getProfile(meUid));
                showToast('Profile created. Welcome to Discover.');
              })();
            }}
          />
        ) : dest === 'profile' ? (
          <ProfileView
            uid={meUid}
            profile={profile}
            savedIds={savedIds}
            onUnsave={(id) => {
              void unsaveFromProfile(id, meUid);
              setSavedIds((cur) => {
                const next = new Set(cur);
                next.delete(id);
                return next;
              });
            }}
          />
        ) : (
          <>
            <Composer
              meUid={meUid}
              meName={profile?.name ?? meName}
              mePhoto={profile?.photo ?? mePhoto}
              onPosted={() => showToast('Posted to Discover.')}
            />
            {(dest === 'feed' || dest === 'viral') && (
              <div className="my-4 flex flex-wrap gap-1.5">
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
            )}
            <div className="space-y-4">
              <FeedList
                posts={posts}
                dest={dest}
                meUid={meUid}
                meName={profile?.name ?? meName}
                likedIds={likedIds}
                savedIds={savedIds}
                followingIds={followingIds}
                act={act}
                handleComment={handleComment}
                setLikedIds={setLikedIds}
                setPosts={setPosts}
                setFollowingIds={setFollowingIds}
                setSavedIds={setSavedIds}
                showToast={showToast}
              />
            </div>
          </>
        )}
      </main>

      {toast && (
        <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-full bg-[#141413] px-4 py-2 text-[13px] text-[#faf9f5] shadow-lg">
          {toast}
        </div>
      )}

      <Footer />
    </div>
  );
}
