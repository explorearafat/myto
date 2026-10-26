import { useCallback, useEffect, useState } from 'react'
import type { MytoApi } from '@shared/types'

/**
 * The Assistant pane — the front door of Myto's computer-use personal assistant.
 * Nothing here does anything until the policy is accepted; after that the pane
 * is the cockpit: a real latency probe, the messaging flow (compose a draft in
 * your tone → approve → deliver), screen-share learning, and SMTP mail.
 */

type Status = {
  accepted: boolean
  policyVersion: number
  platform: string
  hostReady: boolean
  policy: string
}

type AssistantApiShape = NonNullable<MytoApi['assistant']>

const api = (): AssistantApiShape | null => window.myto?.assistant ?? null

export function AssistantPane() {
  const [status, setStatus] = useState<Status | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string>('')

  const refresh = useCallback(async () => {
    const a = api()
    if (!a) return
    try {
      setStatus(await a.status())
    } catch {
      setStatus(null)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (!status) {
    return <p className="text-[13px] text-muted">Assistant unavailable on this platform.</p>
  }

  return (
    <div className="space-y-8">
      {!status.accepted ? (
        <PolicyCard onAccept={async () => {
          setBusy(true)
          try {
            setStatus(await api()!.accept())
            setNotice('')
          } finally {
            setBusy(false)
          }
        }} busy={busy} policy={status.policy} platform={status.platform} />
      ) : (
        <>
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-[13px] font-semibold text-text">Assistant is on</h3>
                <p className="text-[12px] text-muted">
                  The agent can use this computer when its permission mode allows · host{' '}
                  {status.hostReady ? 'ready' : 'starting…'}
                </p>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  try {
                    setStatus(await api()!.disable())
                  } finally {
                    setBusy(false)
                  }
                }}
                className="rounded-full border border-border px-3 py-1.5 text-[12px] text-muted transition-colors hover:border-red-500/40 hover:text-text"
              >
                Turn off
              </button>
            </div>
            <TestRow />
          </section>

          <MessagingSection onNotice={setNotice} />
          <LearningSection onNotice={setNotice} />
          <MailSection onNotice={setNotice} />
          <BridgeSection />
        </>
      )}
      {notice && <p className="rounded-lg bg-surface-2 px-3 py-2 text-[12px] text-text">{notice}</p>}
    </div>
  )
}

function PolicyCard({ policy, onAccept, busy, platform }: { policy: string; onAccept: () => void; busy: boolean; platform: string }) {
  const windows = platform === 'win32'
  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-[15px] font-semibold text-text">Myto Assistant</h3>
        <p className="mt-1 text-[12.5px] text-muted">
          A personal assistant that uses this computer like you do — opens apps, reads the screen,
          types, and sends your messages in your own tone. Turn it on only if you agree to the
          policy below.
        </p>
      </div>
      <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-xl border border-border bg-bg p-4 font-mono text-[11.5px] leading-relaxed text-muted">
        {policy}
      </pre>
      {!windows && (
        <p className="text-[12px] text-amber-500">
          This platform isn't supported yet — the Assistant currently runs on Windows.
        </p>
      )}
      <button
        type="button"
        disabled={busy || !windows}
        onClick={onAccept}
        className="rounded-full bg-primary px-4 py-2 text-[13px] font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {busy ? 'Turning on…' : 'I agree — turn the Assistant on'}
      </button>
    </section>
  )
}

function TestRow() {
  const [result, setResult] = useState<{ ok: boolean; detail: string } | null>(null)
  const [running, setRunning] = useState(false)
  return (
    <div className="flex items-center justify-between rounded-xl border border-border bg-surface-2/40 px-3.5 py-3">
      <div className="min-w-0">
        <p className="text-[12.5px] font-medium text-text">Live check</p>
        <p className="truncate text-[11.5px] text-muted">{result?.detail ?? 'clipboard round-trip + active window, timed'}</p>
      </div>
      <button
        type="button"
        disabled={running}
        onClick={async () => {
          setRunning(true)
          try {
            const r = await api()!.testAction()
            setResult(r)
          } finally {
            setRunning(false)
          }
        }}
        className="ml-3 shrink-0 rounded-full border border-border px-3 py-1.5 text-[12px] text-muted transition-colors hover:border-primary/40 hover:text-text"
      >
        {running ? 'running…' : 'Run'}
      </button>
    </div>
  )
}

function MessagingSection({ onNotice }: { onNotice: (s: string) => void }) {
  const [contact, setContact] = useState('')
  const [intent, setIntent] = useState('')
  const [draft, setDraft] = useState<string | null>(null)
  const [windowTitle, setWindowTitle] = useState('')
  const [busy, setBusy] = useState<'compose' | 'deliver' | null>(null)

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-[13px] font-semibold text-text">Messages</h3>
        <p className="text-[12px] text-muted">
          Open the chat on screen, then compose: the Assistant reads your last messages, matches
          your tone exactly, and shows a draft. Nothing sends until you approve it.
        </p>
      </div>
      <input
        value={contact}
        onChange={(e) => setContact(e.target.value)}
        placeholder="Who is it for? e.g. Rafi Bhai"
        className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-[13px] text-text placeholder:text-muted/70 focus:border-primary/50 focus:outline-none"
      />
      <textarea
        value={intent}
        onChange={(e) => setIntent(e.target.value)}
        placeholder="What should the message say? e.g. tell him I'll be 30 minutes late"
        rows={2}
        className="w-full resize-none rounded-lg border border-border bg-bg px-3 py-2 text-[13px] text-text placeholder:text-muted/70 focus:border-primary/50 focus:outline-none"
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy !== null || !contact.trim() || !intent.trim()}
          onClick={async () => {
            setBusy('compose')
            try {
              const r = await api()!.compose({ contact: contact.trim(), intent: intent.trim() })
              if (r.ok && r.draft) setDraft(r.draft)
              else onNotice(`compose failed: ${r.detail}`)
            } finally {
              setBusy(null)
            }
          }}
          className="rounded-full bg-primary px-4 py-2 text-[12.5px] font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy === 'compose' ? 'composing…' : 'Compose draft'}
        </button>
        {draft && (
          <button
            type="button"
            onClick={() => {
              setDraft(null)
              setIntent('')
            }}
            className="text-[12px] text-muted hover:text-text"
          >
            discard
          </button>
        )}
      </div>
      {draft && (
        <div className="space-y-2 rounded-xl border border-primary/30 bg-surface-2/40 p-3.5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-primary">Draft — nothing sent yet</p>
          <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-text">{draft}</p>
          <input
            value={windowTitle}
            onChange={(e) => setWindowTitle(e.target.value)}
            placeholder="Window to paste into (leave empty for the focused one) e.g. WhatsApp"
            className="w-full rounded-lg border border-border bg-bg px-3 py-1.5 text-[12px] text-text placeholder:text-muted/70 focus:border-primary/50 focus:outline-none"
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy !== null}
              onClick={async () => {
                setBusy('deliver')
                try {
                  const r = await api()!.deliver({ text: draft, windowTitle: windowTitle.trim() || undefined, pressEnter: true })
                  onNotice(r.ok ? 'delivered — check the chat window' : `delivery failed: ${r.detail}`)
                  if (r.ok) setDraft(null)
                } finally {
                  setBusy(null)
                }
              }}
              className="rounded-full bg-green-600 px-4 py-1.5 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy === 'deliver' ? 'delivering…' : 'Approve & send'}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={async () => {
                setBusy('deliver')
                try {
                  const r = await api()!.deliver({ text: draft, windowTitle: windowTitle.trim() || undefined, pressEnter: false })
                  onNotice(r.ok ? 'pasted — review and press Enter yourself' : `paste failed: ${r.detail}`)
                  if (r.ok) setDraft(null)
                } finally {
                  setBusy(null)
                }
              }}
              className="rounded-full border border-border px-4 py-1.5 text-[12.5px] text-muted transition-colors hover:text-text"
            >
              Paste only
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

function LearningSection({ onNotice }: { onNotice: (s: string) => void }) {
  const [goal, setGoal] = useState('')
  const [name, setName] = useState('')
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState(false)

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-[13px] font-semibold text-text">Teach a task</h3>
        <p className="text-[12px] text-muted">
          Press start, do the task on screen once — the Assistant watches and learns the steps.
          Afterwards it can practise silently until every step verifies.
        </p>
      </div>
      <div className="flex gap-2">
        <input
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="What are you teaching? e.g. send a photo in WhatsApp"
          className="min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 py-2 text-[13px] text-text placeholder:text-muted/70 focus:border-primary/50 focus:outline-none"
        />
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="skill name"
          className="w-36 rounded-lg border border-border bg-bg px-3 py-2 text-[13px] text-text placeholder:text-muted/70 focus:border-primary/50 focus:outline-none"
        />
        {recording ? (
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                const r = await api()!.learnStop({ name: name.trim() || goal.trim().slice(0, 24) || 'task' })
                setRecording(false)
                onNotice(r.detail)
              } finally {
                setBusy(false)
              }
            }}
            className="shrink-0 rounded-full bg-red-500 px-4 py-2 text-[12.5px] font-medium text-white disabled:opacity-50"
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            disabled={busy || !goal.trim()}
            onClick={async () => {
              setBusy(true)
              try {
                const r = await api()!.learnStart({ goal: goal.trim() })
                if (r.ok) setRecording(true)
                onNotice(r.detail)
              } finally {
                setBusy(false)
              }
            }}
            className="shrink-0 rounded-full border border-border px-4 py-2 text-[12.5px] text-text transition-colors hover:border-primary/40 disabled:opacity-50"
          >
            Start watching
          </button>
        )}
      </div>
    </section>
  )
}

function MailSection({ onNotice }: { onNotice: (s: string) => void }) {
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [cfg, setCfg] = useState({ host: '', port: 465, secure: true, user: '', pass: '' })
  const [configured, setConfigured] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api()
      ?.mailGetConfig()
      .then((c) => {
        if (c) {
          setCfg((prev) => ({ ...prev, host: c.host, port: c.port, secure: c.secure, user: c.user }))
          setConfigured(true)
        }
      })
  }, [])

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-[13px] font-semibold text-text">Email</h3>
        <p className="text-[12px] text-muted">
          SMTP over TLS — {configured ? 'server saved; the password never leaves this machine.' : 'fill your server once (Gmail: smtp.gmail.com, app password).'}
        </p>
      </div>
      {!configured && (
        <div className="grid grid-cols-2 gap-2">
          <input value={cfg.host} onChange={(e) => setCfg({ ...cfg, host: e.target.value })} placeholder="smtp.gmail.com" className="rounded-lg border border-border bg-bg px-3 py-2 text-[12.5px] text-text placeholder:text-muted/70" />
          <input value={cfg.user} onChange={(e) => setCfg({ ...cfg, user: e.target.value })} placeholder="you@gmail.com" className="rounded-lg border border-border bg-bg px-3 py-2 text-[12.5px] text-text placeholder:text-muted/70" />
          <input value={cfg.pass} onChange={(e) => setCfg({ ...cfg, pass: e.target.value })} type="password" placeholder="app password" className="rounded-lg border border-border bg-bg px-3 py-2 text-[12.5px] text-text placeholder:text-muted/70" />
          <label className="flex items-center gap-2 text-[12px] text-muted">
            <input type="checkbox" checked={cfg.secure} onChange={(e) => setCfg({ ...cfg, secure: e.target.checked, port: e.target.checked ? 465 : 587 })} /> TLS (465)
          </label>
        </div>
      )}
      <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="To: who@gmail.com" className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-[13px] text-text placeholder:text-muted/70" />
      <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-[13px] text-text placeholder:text-muted/70" />
      <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} placeholder="What should the email say?" className="w-full resize-none rounded-lg border border-border bg-bg px-3 py-2 text-[13px] text-text placeholder:text-muted/70" />
      <button
        type="button"
        disabled={busy || !to.trim() || !body.trim() || !cfg.host || !cfg.user}
        onClick={async () => {
          setBusy(true)
          try {
            const r = await api()!.mailSend({
              config: { host: cfg.host, port: cfg.port, secure: cfg.secure, user: cfg.user, pass: cfg.pass || undefined },
              message: { to: to.trim(), subject: subject.trim() || '(no subject)', body }
            })
            onNotice(r.ok ? `email sent ✓ ${r.messageId ?? ''}` : `send failed: ${r.transcript.split('\n').slice(-1)[0]}`)
            if (r.ok) {
              setTo('')
              setSubject('')
              setBody('')
              setConfigured(true)
            }
          } finally {
            setBusy(false)
          }
        }}
        className="rounded-full bg-primary px-4 py-2 text-[12.5px] font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {busy ? 'sending…' : 'Send email'}
      </button>
    </section>
  )
}

function BridgeSection() {
  const [info, setInfo] = useState<{ enabled: boolean; running: boolean; port: number; token: string; urls: string[] } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api()
      ?.bridgeGet()
      .then(setInfo)
  }, [])

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-[13px] font-semibold text-text">Phone bridge</h3>
          <p className="text-[12px] text-muted">
            Let the Myto phone app drive this PC's assistant over Wi-Fi. Token-guarded, off by
            default — same Wi-Fi only.
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              setInfo(await api()!.bridgeSet({ enabled: !(info?.enabled ?? false) }))
            } finally {
              setBusy(false)
            }
          }}
          className={
            'shrink-0 rounded-full px-3 py-1.5 text-[12px] font-medium transition-colors ' +
            (info?.enabled ? 'bg-green-600 text-white hover:opacity-90' : 'border border-border text-muted hover:text-text')
          }
        >
          {info?.enabled ? (info.running ? 'On — running' : 'On — starting…') : 'Off'}
        </button>
      </div>
      {info?.enabled && info.running && (
        <div className="space-y-1.5 rounded-xl border border-border bg-surface-2/40 p-3.5 font-mono text-[11.5px] text-muted">
          {info.urls.map((u) => (
            <p key={u} className="truncate">
              {u}
            </p>
          ))}
          <p className="break-all">
            token: <span className="text-text">{info.token}</span>
          </p>
        </div>
      )}
    </section>
  )
}
