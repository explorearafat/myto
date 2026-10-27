// The Discover community feed as a full-screen desktop overlay — the same
// Firestore-backed social feed the website's /discover and the mobile Discover
// tab serve. The signed-in user IS the Discover account: the rail opens this
// with their credential already attached, and every post/comment/save/follow is
// written under their uid (see lib/social.ts + firestore.rules).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuthUser } from '@renderer/lib/useAuthUser'
import {
  addComment,
  createPost,
  deletePost,
  fetchLinkMeta,
  fetchMyNotifications,
  fetchPostsByAuthors,
  firstUrl,
  followAuthor,
  getFollowingIds,
  hydratePosts,
  isLikedBy,
  listSavedIds,
  MAX_POST_CHARS,
  prioritizePosts,
  saveToProfile,
  sharePost,
  streamComments,
  streamFeed,
  TOPICS,
  toggleLike,
  unfollowAuthor,
  unsaveFromProfile,
  type FeedComment,
  type FeedPost,
} from '@renderer/lib/social'

function relativeTime(ms: number): string {
  if (!ms) return 'just now'
  const s = Math.max(1, Math.floor((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d`
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Render text with #hashtags and https links tinted. */
function PostText({ text }: { text: string }) {
  const parts = useMemo(() => {
    const out: Array<{ kind: 'text' | 'link' | 'tag'; value: string }> = []
    const re = /(https:\/\/[^\s<]+)|(#([a-z0-9]{1,20}))/gi
    let last = 0
    for (const m of text.matchAll(re)) {
      const at = m.index ?? 0
      if (at > last) out.push({ kind: 'text', value: text.slice(last, at) })
      if (m[1]) out.push({ kind: 'link', value: m[1] })
      else out.push({ kind: 'tag', value: m[2] })
      last = at + m[0].length
    }
    if (last < text.length) out.push({ kind: 'text', value: text.slice(last) })
    return out
  }, [text])
  return (
    <p className="whitespace-pre-wrap break-words text-[14px] leading-relaxed text-text">
      {parts.map((p, i) =>
        p.kind === 'text' ? (
          <span key={i}>{p.value}</span>
        ) : (
          <span key={i} className={p.kind === 'tag' ? 'font-medium text-primary' : 'text-primary underline underline-offset-2'}>
            {p.value}
          </span>
        )
      )}
    </p>
  )
}

function Avatar({ photo, name }: { photo: string; name: string }) {
  const initial = (name || '?').trim().charAt(0).toUpperCase()
  return photo ? (
    <img src={photo} alt="" className="h-9 w-9 shrink-0 rounded-full object-cover ring-1 ring-border" />
  ) : (
    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary/15 text-[13px] font-semibold text-primary ring-1 ring-border">
      {initial}
    </span>
  )
}

// ── Comments ───────────────────────────────────────────────────────────────────

function Comments({
  postId,
  onSend,
}: {
  postId: string
  onSend: (text: string) => Promise<void>
}) {
  const [comments, setComments] = useState<FeedComment[] | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => streamComments(postId, setComments), [postId])

  return (
    <div className="mt-3 rounded-lg bg-surface-2/50 p-3">
      <div className="max-h-64 space-y-3 overflow-y-auto">
        {comments == null ? (
          <p className="text-[12.5px] text-muted">Loading comments…</p>
        ) : comments.length === 0 ? (
          <p className="text-[12.5px] text-muted">No comments yet — start the thread.</p>
        ) : (
          comments.map((c) => (
            <div key={c.id} className="flex items-start gap-2.5">
              <Avatar photo={c.photo} name={c.name} />
              <div className="min-w-0">
                <p className="text-[12px]">
                  <span className="font-semibold text-text">{c.name}</span>{' '}
                  <span className="text-muted">{relativeTime(c.createdAtMs)}</span>
                </p>
                <p className="whitespace-pre-wrap break-words text-[13px] text-text/90">{c.text}</p>
              </div>
            </div>
          ))
        )}
      </div>
      <form
        className="mt-3 flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault()
          if (!draft.trim() || busy) return
          setBusy(true)
          try {
            await onSend(draft)
            setDraft('')
          } finally {
            setBusy(false)
          }
        }}
      >
        <input
          type="text"
          value={draft}
          maxLength={300}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Write a comment…"
          className="min-w-0 flex-1 rounded-full border border-border bg-surface px-3.5 py-2 text-[13px] text-text placeholder:text-muted focus:border-primary focus:outline-none"
        />
        <button
          type="submit"
          disabled={!draft.trim() || busy}
          className="rounded-full bg-primary px-4 py-2 text-[12.5px] font-medium text-bg transition-opacity disabled:opacity-40"
        >
          Reply
        </button>
      </form>
    </div>
  )
}

// ── Post card ──────────────────────────────────────────────────────────────────

interface PostCardProps {
  post: FeedPost
  meUid: string
  liked: boolean
  saved: boolean
  following: boolean
  onToggleLike: () => void
  onShare: () => void
  onToggleSave: () => void
  onToggleFollow: () => void
  onComment: (text: string) => Promise<void>
  onDelete?: () => void
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
  const [commentsOpen, setCommentsOpen] = useState(false)
  const mine = post.uid === meUid

  return (
    <article className="rounded-xl border border-border bg-surface p-4">
      <div className="flex items-start gap-3">
        <Avatar photo={post.photo} name={post.name} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13.5px] font-semibold text-text">{post.name}</span>
            {!mine && (
              <button
                type="button"
                onClick={onToggleFollow}
                className={
                  'rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ' +
                  (following
                    ? 'border-primary/30 bg-primary/10 text-primary'
                    : 'border-border text-muted hover:text-text')
                }
              >
                {following ? 'Following' : 'Follow'}
              </button>
            )}
            {mine && onDelete && (
              <button
                type="button"
                onClick={onDelete}
                className="rounded-full px-2 py-0.5 text-[11px] text-muted transition-colors hover:text-red-500"
              >
                Delete
              </button>
            )}
          </div>
          <span className="text-[11.5px] text-muted">{relativeTime(post.createdAtMs)}</span>
        </div>
      </div>

      <div className="mt-2.5">
        <PostText text={post.text} />
      </div>

      {post.link && (
        <a
          href={post.link}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 block overflow-hidden rounded-lg border border-border bg-surface-2/40 no-underline transition-colors hover:border-primary/40"
        >
          {post.linkImage && (
            <img src={post.linkImage} alt="" className="max-h-48 w-full object-cover" loading="lazy" />
          )}
          <div className="px-3 py-2">
            {post.linkTitle && (
              <p className="truncate text-[12.5px] font-semibold text-text">{post.linkTitle}</p>
            )}
            <p className="truncate text-[11px] text-muted">{post.linkSite || post.link}</p>
          </div>
        </a>
      )}

      {post.topics.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {post.topics.map((t) => (
            <span key={t} className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-muted">
              #{t}
            </span>
          ))}
        </div>
      )}

      <div className="mt-3 flex items-center gap-1 border-t border-border/70 pt-2 text-[12.5px] text-muted">
        <button
          type="button"
          onClick={onToggleLike}
          className={
            'flex items-center gap-1.5 rounded-full px-2.5 py-1.5 transition-colors hover:bg-surface-2 hover:text-text ' +
            (liked ? 'bg-red-500/10 text-red-500' : '')
          }
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill={liked ? 'currentColor' : 'none'} aria-hidden="true">
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
          className="flex items-center gap-1.5 rounded-full px-2.5 py-1.5 transition-colors hover:bg-surface-2 hover:text-text"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
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
          onClick={onShare}
          className="flex items-center gap-1.5 rounded-full px-2.5 py-1.5 transition-colors hover:bg-surface-2 hover:text-text"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M9.5 3 14 6.5 9.5 10V7.6C5.8 7.6 3.6 9 2.2 11.6c0-4 2.5-6.9 7.3-7.2z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          </svg>
          {post.shareCount > 0 ? post.shareCount : 'Share'}
        </button>
        <button
          type="button"
          onClick={onToggleSave}
          className={
            'ml-auto flex items-center gap-1.5 rounded-full px-2.5 py-1.5 transition-colors hover:bg-surface-2 hover:text-text ' +
            (saved ? 'bg-primary/10 text-primary' : '')
          }
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill={saved ? 'currentColor' : 'none'} aria-hidden="true">
            <path d="M4 2.5h8a.8.8 0 0 1 .8.8v10.2L8 10.4l-4.8 3.1V3.3a.8.8 0 0 1 .8-.8z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          </svg>
          {saved ? 'Saved' : 'Save'}
        </button>
      </div>

      {commentsOpen && (
        <Comments postId={post.id} onSend={onComment} />
      )}
    </article>
  )
}

// ── Composer ───────────────────────────────────────────────────────────────────

function Composer({
  me,
  onPosted,
}: {
  me: { uid: string; name: string; photo: string }
  onPosted: () => void
}) {
  const [text, setText] = useState('')
  const [topics, setTopics] = useState<string[]>([])
  const [meta, setMeta] = useState<{ url: string; title: string; image: string; site: string } | null>(null)
  const [linkBusy, setLinkBusy] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const lastUrl = useRef('')

  const url = firstUrl(text)

  useEffect(() => {
    if (!url) {
      setMeta(null)
      lastUrl.current = ''
      return
    }
    if (url === lastUrl.current) return
    const t = setTimeout(async () => {
      lastUrl.current = url
      setLinkBusy(true)
      const m = await fetchLinkMeta(url)
      setMeta({ url, ...m })
      setLinkBusy(false)
    }, 700)
    return () => clearTimeout(t)
  }, [url])

  const remaining = MAX_POST_CHARS - text.length
  const canPost = text.trim().length > 0 && remaining >= 0 && !busy

  return (
    <div className="rounded-xl border border-border bg-surface p-3.5">
      <textarea
        value={text}
        maxLength={MAX_POST_CHARS + 50}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        placeholder="Share something about AI, Myto, crypto… (attach a link and its preview shows up)"
        className="w-full resize-none rounded-lg border border-border bg-surface-2/40 px-3 py-2.5 text-[14px] leading-relaxed text-text placeholder:text-muted focus:border-primary focus:outline-none"
      />

      {linkBusy && <p className="mt-1.5 text-[11.5px] text-muted">Fetching link preview…</p>}
      {meta && (meta.title || meta.image) && (
        <div className="mt-2 flex items-center gap-3 rounded-lg border border-border bg-surface-2/40 p-2">
          {meta.image && <img src={meta.image} alt="" className="h-12 w-16 shrink-0 rounded object-cover" />}
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12.5px] font-semibold text-text">{meta.title || meta.url}</p>
            <p className="truncate text-[11px] text-muted">{meta.site || meta.url}</p>
          </div>
          <button
            type="button"
            onClick={() => {
              setMeta(null)
              setText((t) => t.replace(meta.url, '').replace(/\s{2,}/g, ' ').trimEnd())
              lastUrl.current = ''
            }}
            className="rounded px-2 py-1 text-[11.5px] text-muted hover:text-text"
          >
            Remove
          </button>
        </div>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {TOPICS.map((t) => {
          const active = topics.includes(t)
          return (
            <button
              key={t}
              type="button"
              onClick={() => setTopics((cur) => (active ? cur.filter((x) => x !== t) : [...cur, t].slice(0, 4)))}
              className={
                'rounded-full border px-2.5 py-1 text-[11.5px] font-medium transition-colors ' +
                (active
                  ? 'border-primary/40 bg-primary/10 text-primary'
                  : 'border-border text-muted hover:text-text')
              }
            >
              #{t}
            </button>
          )
        })}
        <span className={'ml-auto font-mono text-[11.5px] ' + (remaining < 0 ? 'text-red-500' : 'text-muted')}>
          {Math.max(0, remaining)}
        </span>
        <button
          type="button"
          disabled={!canPost}
          onClick={async () => {
            if (!canPost) return
            setBusy(true)
            setError('')
            try {
              const attached = meta?.url ?? url ?? ''
              await createPost(
                me,
                text,
                topics,
                attached,
                meta ? { title: meta.title, image: meta.image, site: meta.site } : { title: '', image: '', site: '' }
              )
              setText('')
              setTopics([])
              setMeta(null)
              lastUrl.current = ''
              onPosted()
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Could not post. Try again.')
            } finally {
              setBusy(false)
            }
          }}
          className="rounded-full bg-primary px-5 py-2 text-[13px] font-medium text-bg transition-all active:scale-[0.97] disabled:opacity-40"
        >
          {busy ? 'Posting…' : 'Post'}
        </button>
      </div>
      {error && <p className="mt-1.5 text-[12px] text-red-500">{error}</p>}
    </div>
  )
}

// ── The overlay ────────────────────────────────────────────────────────────────

type FeedTab = 'feeds' | 'following' | 'mine' | 'saved'

export function DiscoverOverlay({ onClose }: { onClose: () => void }) {
  const user = useAuthUser()
  const me = useMemo(
    () => ({ uid: user?.uid ?? '', name: user?.displayName?.trim() || 'Anonymous', photo: user?.photoURL ?? '' }),
    [user?.uid, user?.displayName, user?.photoURL]
  )

  const [tab, setTab] = useState<FeedTab>('feeds')
  const [topic, setTopic] = useState('')
  const [posts, setPosts] = useState<FeedPost[] | null>(null)
  const [likedIds, setLikedIds] = useState<Set<string>>(new Set())
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set())
  const [followingIds, setFollowingIds] = useState<Set<string>>(new Set())
  const [toast, setToast] = useState('')
  const [seed, setSeed] = useState(0)
  const [notifOpen, setNotifOpen] = useState(false)
  const toastTimer = useRef<number | undefined>(undefined)

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(''), 2200)
  }, [])

  // Feed data per tab.
  useEffect(() => {
    if (tab === 'mine') {
      const un = streamFeed({ authorUid: me.uid }, setPosts)
      return () => un()
    }
    if (tab === 'following') {
      let alive = true
      void (async () => {
        const ids = await getFollowingIds(me.uid)
        const list = await fetchPostsByAuthors(ids)
        if (alive) setPosts(list)
      })()
      return () => {
        alive = false
      }
    }
    if (tab === 'saved') {
      let alive = true
      void (async () => {
        const ids = await listSavedIds(me.uid)
        const list = await hydratePosts(ids)
        if (alive) setPosts(list)
      })()
      return () => {
        alive = false
      }
    }
    const un = streamFeed({ topic: topic || undefined }, setPosts)
    return () => un()
  }, [tab, topic, me.uid])

  // Saved + following sets.
  useEffect(() => {
    let alive = true
    void (async () => {
      const [saved, following] = await Promise.all([listSavedIds(me.uid), getFollowingIds(me.uid)])
      if (!alive) return
      setSavedIds(new Set(saved))
      setFollowingIds(new Set(following))
    })()
    return () => {
      alive = false
    }
  }, [me.uid])

  // Lazy like flags for the visible posts.
  useEffect(() => {
    if (!posts) return
    let alive = true
    void (async () => {
      for (const p of posts.slice(0, 30)) {
        if (!alive) return
        const liked = await isLikedBy(p.id, me.uid)
        setLikedIds((cur) => {
          if (cur.has(p.id) === liked) return cur
          const next = new Set(cur)
          if (liked) next.add(p.id)
          else next.delete(p.id)
          return next
        })
      }
    })()
    return () => {
      alive = false
    }
  }, [posts, me.uid])

  const act = useCallback(
    async (fn: () => Promise<unknown>, ok?: string) => {
      try {
        await fn()
        if (ok) showToast(ok)
      } catch {
        showToast('Something went wrong — try again.')
      }
    },
    [showToast]
  )

  const handleComment = useCallback(
    async (post: FeedPost, text: string) => {
      await act(() => addComment(post.id, me, text), 'Comment added.')
    },
    [me, act]
  )

  const TABS: Array<{ key: FeedTab; label: string }> = [
    { key: 'feeds', label: 'Feeds' },
    { key: 'following', label: 'Following' },
    { key: 'mine', label: 'My posts' },
    { key: 'saved', label: 'Saved' },
  ]

  // The unfiltered Feeds tab flows by priority (engagement + recency + follows +
  // per-refresh jitter); topic filters, Following, Mine and Saved stay as-is.
  const visiblePosts = useMemo(() => {
    if (!posts) return posts
    if (tab !== 'feeds' || topic) return posts
    return prioritizePosts(posts, { following: followingIds, seed })
  }, [posts, tab, topic, followingIds, seed])

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-bg/95 backdrop-blur-sm">
      {/* Header row — back · cursive Myto · notifications (per the mobile design) */}
      <div className="flex items-center justify-between border-b border-border px-5 py-2.5">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onClose}
            aria-label="Back"
            className="grid h-8 w-8 place-items-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-text"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <h1 className="font-cursive text-[30px] leading-none text-text">Myto</h1>
          <span className="hidden text-[12px] text-muted sm:inline">the community</span>
        </div>
        <div className="relative flex items-center gap-1">
          <button
            type="button"
            onClick={() => setSeed((s) => s + 1)}
            aria-label="Shuffle the feed"
            title="Shuffle the flow"
            className="grid h-8 w-8 place-items-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-text"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M20 11A8 8 0 0 0 5.6 6.6L4 8.3M4 5v3.5h3.5M4 13a8 8 0 0 0 14.4 4.4L20 15.7M20 19v-3.5h-3.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => setNotifOpen((o) => !o)}
            aria-label="Notifications"
            className="grid h-8 w-8 place-items-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-text"
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M6 9a6 6 0 1 1 12 0c0 4 1.5 5.5 2 6.2.2.3 0 .8-.5.8h-15c-.5 0-.7-.5-.5-.8.5-.7 2-2.2 2-6.2zM10 19a2.2 2.2 0 0 0 4 0" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {notifOpen && <NotificationsPanel uid={me.uid} onClose={() => setNotifOpen(false)} />}
        </div>
      </div>

      {/* Tabs + topics */}
      <div className="border-b border-border px-5 py-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <div className="flex rounded-full bg-surface-2/60 p-0.5">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={
                  'rounded-full px-3.5 py-1.5 text-[12.5px] font-medium transition-colors ' +
                  (tab === t.key ? 'bg-surface text-text shadow-sm' : 'text-muted hover:text-text')
                }
              >
                {t.label}
              </button>
            ))}
          </div>
          {tab === 'feeds' && (
            <div className="ml-2 flex flex-wrap gap-1">
              <button
                type="button"
                onClick={() => setTopic('')}
                className={
                  'rounded-full px-2.5 py-1 text-[11.5px] font-medium transition-colors ' +
                  (topic === '' ? 'bg-primary text-bg' : 'bg-surface-2 text-muted hover:text-text')
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
                    'rounded-full px-2.5 py-1 text-[11.5px] font-medium transition-colors ' +
                    (topic === t ? 'bg-primary text-bg' : 'bg-surface-2 text-muted hover:text-text')
                  }
                >
                  #{t}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Feed */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="mx-auto max-w-2xl space-y-4">
          {tab === 'feeds' && <Composer me={me} onPosted={() => showToast('Posted to Discover.')} />}

          {visiblePosts == null ? (
            <p className="py-10 text-center text-[13px] text-muted">Loading…</p>
          ) : visiblePosts.length === 0 ? (
            <p className="py-10 text-center text-[13px] text-muted">
              {tab === 'following'
                ? 'Follow authors and their posts land here.'
                : tab === 'mine'
                  ? 'You have not posted yet.'
                  : tab === 'saved'
                    ? 'Nothing saved yet — tap Save on a post.'
                    : 'Nothing here yet — be the first to post.'}
            </p>
          ) : (
            visiblePosts.map((p) => (
              <PostCard
                key={p.id}
                post={p}
                meUid={me.uid}
                liked={likedIds.has(p.id)}
                saved={savedIds.has(p.id)}
                following={followingIds.has(p.uid)}
                onComment={(text) => handleComment(p, text)}
                onToggleLike={() =>
                  act(async () => {
                    const nowLiked = await toggleLike(p.id, me.uid)
                    setLikedIds((cur) => {
                      const next = new Set(cur)
                      if (nowLiked) next.add(p.id)
                      else next.delete(p.id)
                      return next
                    })
                  })
                }
                onShare={() =>
                  act(async () => {
                    await sharePost(p.id, me)
                    showToast('Reposted to your profile.')
                  })
                }
                onToggleSave={() =>
                  act(async () => {
                    if (savedIds.has(p.id)) {
                      await unsaveFromProfile(p.id, me.uid)
                      setSavedIds((cur) => {
                        const next = new Set(cur)
                        next.delete(p.id)
                        return next
                      })
                      showToast('Removed from your profile.')
                    } else {
                      await saveToProfile(p.id, me.uid)
                      setSavedIds((cur) => new Set(cur).add(p.id))
                      showToast('Saved to your profile.')
                    }
                  })
                }
                onToggleFollow={() =>
                  act(async () => {
                    if (followingIds.has(p.uid)) {
                      await unfollowAuthor(me.uid, p.uid)
                      setFollowingIds((cur) => {
                        const next = new Set(cur)
                        next.delete(p.uid)
                        return next
                      })
                    } else {
                      await followAuthor(me.uid, p.uid)
                      setFollowingIds((cur) => new Set(cur).add(p.uid))
                      showToast(`Following ${p.name}.`)
                    }
                  })
                }
                onDelete={
                  p.uid === me.uid
                    ? () =>
                        act(async () => {
                          await deletePost(p.id)
                          setPosts((cur) => (cur ? cur.filter((x) => x.id !== p.id) : cur))
                          showToast('Post deleted.')
                        })
                    : undefined
                }
              />
            ))
          )}
        </div>
      </div>

      {toast && (
        <div className="pointer-events-none absolute bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-full bg-text px-4 py-2 text-[12.5px] text-bg shadow-lg">
          {toast}
        </div>
      )}
    </div>
  )
}

// ── Notifications (the bell) ───────────────────────────────────────────────────

function NotificationsPanel({ uid, onClose }: { uid: string; onClose: () => void }) {
  const [items, setItems] = useState<Awaited<ReturnType<typeof fetchMyNotifications>> | null>(null)

  useEffect(() => {
    let alive = true
    void fetchMyNotifications(uid).then((list) => {
      if (alive) setItems(list)
    })
    return () => {
      alive = false
    }
  }, [uid])

  return (
    <>
      <div className="fixed inset-0 z-10" onClick={onClose} aria-hidden="true" />
      <div className="absolute right-0 top-10 z-20 w-80 rounded-xl border border-border bg-surface p-2 shadow-lg">
        <p className="px-2 py-1.5 text-[12px] font-semibold uppercase tracking-wide text-muted">
          Notifications
        </p>
        {items == null ? (
          <p className="px-2 py-4 text-center text-[12.5px] text-muted">Loading…</p>
        ) : items.length === 0 ? (
          <p className="px-2 py-4 text-center text-[12.5px] text-muted">
            No activity yet — comments on your posts show up here.
          </p>
        ) : (
          <div className="max-h-72 overflow-y-auto">
            {items.map((n) => (
              <div key={n.id} className="rounded-lg px-2 py-2 hover:bg-surface-2/60">
                <p className="text-[12.5px] leading-snug text-text">
                  <span className="font-semibold">{n.who}</span>{' '}
                  <span className="text-muted">{relativeTime(n.atMs)}</span>
                </p>
                <p className="truncate text-[12px] text-muted">{n.text}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}
