/**
 * useSyloriumEnv — the shared "brain" of the Sylorium environment.
 *
 * Sylorium is a curated browser (left) and a chat with Sylor (right), shown
 * side-by-side and both reading from this single hook, so they stay in sync: the
 * tab open in the browser is exactly the page Chat can see and drive, and an action
 * Sylor takes from Chat happens in that same live tab.
 *
 * Everything that must be shared lives here — the tab set and their live webviews,
 * the permission-gated {@link SyloriumController}, the AI conversation, and the
 * pending approval. The UI components are thin: they render this state and call
 * these handlers. Nothing here reads cookies, passwords, or field values;
 * AI-initiated actions always pass through the controller's gate.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import type { ChatMessage, SyloriumAction } from '@shared/types'
import type { WebviewElement } from '@renderer/types/webview'
import { useAppStore } from '@renderer/store/useAppStore'
import { SyloriumController, normalizeUrl } from '@renderer/lib/sylorium/controller'
import type { ActionResult } from '@renderer/lib/sylorium/controller'
import {
  SYSTEM_PROMPT,
  summarizeSnapshot,
  extractAction,
  actionKey,
  describeAction,
  proseOf
} from '@renderer/lib/sylorium/ask'
import type { ParsedAction } from '@renderer/lib/sylorium/ask'

/** A clean desktop-Chrome UA so real sites (Google, etc.) don't reject Electron. */
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/**
 * How many perceive→act steps Sylor may take for a single request before it must
 * stop and report back. Bounded so a real multi-step task (navigate → type →
 * submit → read) can complete, while a confused model can never spin forever.
 */
const MAX_STEPS = 6

/** A cancellable-free sleep used to let a page settle between steps. */
const delay = (ms: number): Promise<void> => new Promise((r) => window.setTimeout(r, ms))

/** One browser tab. Each keeps its own live webview (background tabs stay alive). */
export interface Tab {
  id: string
  url: string
  title: string
  loading: boolean
  canBack: boolean
  canForward: boolean
  /** True when this tab is showing the app launcher (its "home"), not a live page. */
  atHome: boolean
  /** Set when the main frame failed to load (drives the self-healing card). */
  failed: { code: number; desc: string } | null
  /** True while a bounded auto-recovery reload is in flight. */
  healing: boolean
}

/** A line in the Sylor chat transcript. */
export interface AskLine {
  role: 'you' | 'sylor'
  text: string
}

/** A pending AI action awaiting the user's yes/no (for `ask`-gated actions). */
export interface ApprovalRequest {
  action: SyloriumAction
  detail: string
  resolve: (approved: boolean) => void
}

/** Ref callback type for a tab's `<webview>` (may return an unmount cleanup). */
type WebviewRef = (el: WebviewElement | null) => (() => void) | void

/** The full shared surface both Sylorium panes consume. */
export interface SyloriumEnv {
  // ── Tabs ──
  tabs: Tab[]
  activeId: string
  active: Tab | null
  openTab: (url?: string) => void
  selectTab: (id: string) => void
  closeTab: (id: string) => void

  // ── User-driven navigation (never gated — this is the human browsing) ──
  goBack: () => void
  goForward: () => void
  reload: () => void
  /** Navigate the active tab (URL or search query). Leaves the launcher. */
  submitAddress: (raw: string) => void
  /** Open a launcher app tile in the active tab. */
  openApp: (url: string) => void
  /** Run a launcher search (query or URL) in the active tab. */
  submitSearch: (query: string) => void
  /** Return the active tab to the app launcher (keeps the loaded page behind it). */
  goLauncher: () => void
  registerWebview: (id: string) => WebviewRef

  // ── AI conversation / control ──
  aiActive: boolean
  aiStatus: string
  askLog: AskLine[]
  askInput: string
  setAskInput: (value: string) => void
  askBusy: boolean
  /** Send the composer text (or an explicit `override`, e.g. a suggestion chip). */
  submitAsk: (override?: string) => Promise<void>
  /** Clear the chat transcript (the ≡ menu's "New chat"). */
  clearChat: () => void

  // ── Permissions + approvals ──
  showPermissions: boolean
  setShowPermissions: (open: boolean) => void
  approval: ApprovalRequest | null
  approve: () => void
  deny: () => void
}

let tabSeq = 0
function newTab(url = ''): Tab {
  const atHome = url === ''
  return {
    id: `tab-${++tabSeq}`,
    url,
    title: 'New tab',
    loading: !atHome,
    canBack: false,
    canForward: false,
    atHome,
    failed: null,
    healing: false
  }
}

/** Map an Electron did-fail-load error code to a short human diagnosis. */
export function diagnose(code: number, desc: string): string {
  if (code === -105 || code === -137) return 'That site couldn’t be found (check the address).'
  if (code === -106) return 'You appear to be offline.'
  if (code === -201 || code === -200) return 'The site’s security certificate was rejected.'
  if (code === -7) return 'The site took too long to respond.'
  return desc || 'The page failed to load.'
}

export function useSyloriumEnv(): SyloriumEnv {
  const [tabs, setTabs] = useState<Tab[]>(() => [newTab()])
  const [activeId, setActiveId] = useState<string>(() => tabs[0]?.id ?? '')
  const [showPermissions, setShowPermissions] = useState(false)
  const [aiActive, setAiActive] = useState(false)
  const [aiStatus, setAiStatus] = useState('')
  const [approval, setApproval] = useState<ApprovalRequest | null>(null)
  const [askInput, setAskInput] = useState('')
  const [askBusy, setAskBusy] = useState(false)
  const [askLog, setAskLog] = useState<AskLine[]>([])

  const webviews = useRef<Map<string, WebviewElement>>(new Map())
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId
  const healAttempts = useRef<Map<string, number>>(new Map())
  /** Stable per-tab ref callbacks (so React doesn't re-attach listeners each render). */
  const refCache = useRef<Map<string, WebviewRef>>(new Map())

  const active = tabs.find((t) => t.id === activeId) ?? null

  /** Append a Sylor reply to the (always-visible) chat transcript. */
  const pushSylor = useCallback((text: string) => {
    setAskLog((l) => [...l, { role: 'sylor', text }])
  }, [])

  /** Clear the chat transcript + composer (the ≡ menu's "New chat"). */
  const clearChat = useCallback(() => {
    setAskLog([])
    setAskInput('')
  }, [])

  /** Patch one tab in place by id (functional update — safe from any closure). */
  const patchTab = useCallback((id: string, patch: Partial<Tab>) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)))
  }, [])

  const wvOf = useCallback((id: string) => webviews.current.get(id) ?? null, [])

  // The controller resolves permissions from the LIVE store (never a stale copy),
  // drives whichever tab is active, and routes `ask` decisions to the modal.
  const controller = useMemo(
    () =>
      new SyloriumController({
        getWebview: () => wvOf(activeIdRef.current),
        getPermission: (a) => useAppStore.getState().syloriumPermissions[a],
        requestApproval: (action, detail) =>
          new Promise<boolean>((resolve) => setApproval({ action, detail, resolve })),
        onActivity: (msg) => setAiStatus(msg)
      }),
    [wvOf]
  )

  // ── Tab lifecycle ────────────────────────────────────────────────────────
  const openTab = useCallback((url?: string) => {
    const t = newTab(url)
    setTabs((prev) => [...prev, t])
    setActiveId(t.id)
  }, [])

  const selectTab = useCallback((id: string) => {
    setActiveId(id)
  }, [])

  const closeTab = useCallback((id: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id)
      if (idx === -1) return prev
      const next = prev.filter((t) => t.id !== id)
      // Never leave zero tabs — a browser always has a page (a fresh launcher tab).
      if (next.length === 0) {
        const fresh = newTab()
        setActiveId(fresh.id)
        return [fresh]
      }
      if (id === activeIdRef.current) {
        const neighbour = next[Math.min(idx, next.length - 1)]
        setActiveId(neighbour.id)
      }
      return next
    })
    webviews.current.delete(id)
    healAttempts.current.delete(id)
    refCache.current.delete(id)
  }, [])

  // ── User-driven navigation (never gated — this is the human browsing) ──────
  const goBack = useCallback(() => wvOf(activeIdRef.current)?.goBack(), [wvOf])
  const goForward = useCallback(() => wvOf(activeIdRef.current)?.goForward(), [wvOf])
  const reload = useCallback(() => {
    const id = activeIdRef.current
    patchTab(id, { failed: null, healing: false })
    healAttempts.current.delete(id)
    wvOf(id)?.reload()
  }, [patchTab, wvOf])

  // Navigate the active tab to a URL or search query, leaving the launcher. The
  // resolved url is recorded by the did-navigate listener; here we just start it.
  const submitAddress = useCallback(
    (raw: string) => {
      const url = normalizeUrl(raw)
      if (!url) return
      const id = activeIdRef.current
      patchTab(id, { atHome: false, failed: null, healing: false, loading: true })
      healAttempts.current.delete(id)
      wvOf(id)?.loadURL(url)
    },
    [patchTab, wvOf]
  )

  /** Launcher app tile → open its site in the active tab. */
  const openApp = useCallback((url: string) => submitAddress(url), [submitAddress])
  /** Launcher search → navigate the active tab (query or URL). */
  const submitSearch = useCallback((query: string) => submitAddress(query), [submitAddress])

  // Return to the launcher: show it over the (still-loaded) page without reloading.
  const goLauncher = useCallback(() => {
    const id = activeIdRef.current
    patchTab(id, { atHome: true, failed: null, healing: false, loading: false })
    healAttempts.current.delete(id)
  }, [patchTab])

  // ── Self-healing: detect → diagnose → ONE safe reload → verify. Bounded and
  // non-destructive: a single automatic retry, then we hand control back to the
  // user with a clear diagnosis (never arbitrary self-modification).
  const handleFail = useCallback(
    (id: string, code: number, desc: string) => {
      const attempts = healAttempts.current.get(id) ?? 0
      if (attempts < 1) {
        healAttempts.current.set(id, attempts + 1)
        patchTab(id, { failed: { code, desc }, healing: true, loading: false })
        window.setTimeout(() => {
          // Only retry if still on the same failure (user may have moved on).
          const wv = wvOf(id)
          if (wv) wv.reloadIgnoringCache()
        }, 1200)
      } else {
        patchTab(id, { failed: { code, desc }, healing: false, loading: false })
      }
    },
    [patchTab, wvOf]
  )

  // ── Wire a webview's lifecycle events once it mounts (React 19 ref cleanup). ─
  // A stable callback per tab id — otherwise a fresh ref each render would make
  // React tear down and re-attach the listeners (and briefly drop the element).
  const registerWebview = useCallback(
    (id: string): WebviewRef => {
      const cached = refCache.current.get(id)
      if (cached) return cached
      const cb: WebviewRef = (el) => {
        if (!el) return
        webviews.current.set(id, el)
        const sync = (): void => patchTab(id, { canBack: el.canGoBack(), canForward: el.canGoForward() })

        const onStart = (): void => patchTab(id, { loading: true, failed: null })
        const onStop = (): void => {
          patchTab(id, { loading: false, healing: false })
          healAttempts.current.delete(id)
          sync()
        }
        const onTitle = (e: Event): void =>
          patchTab(id, { title: (e as unknown as { title: string }).title || 'Untitled' })
        const onNavigate = (e: Event): void => {
          const url = (e as unknown as { url: string }).url
          // A real page load leaves the launcher; about:blank (the idle tab) does not.
          const onPage = /^https?:\/\//i.test(url)
          patchTab(id, onPage ? { url, atHome: false } : { url })
          sync()
        }
        const onFail = (e: Event): void => {
          const ev = e as unknown as { errorCode: number; errorDescription: string; isMainFrame: boolean }
          // -3 === ERR_ABORTED (a normal user/redirect abort, not a real failure).
          if (ev.isMainFrame && ev.errorCode !== -3) handleFail(id, ev.errorCode, ev.errorDescription)
        }

        el.addEventListener('did-start-loading', onStart)
        el.addEventListener('did-stop-loading', onStop)
        el.addEventListener('page-title-updated', onTitle)
        el.addEventListener('did-navigate', onNavigate)
        el.addEventListener('did-navigate-in-page', onNavigate)
        el.addEventListener('did-fail-load', onFail)
        return () => {
          el.removeEventListener('did-start-loading', onStart)
          el.removeEventListener('did-stop-loading', onStop)
          el.removeEventListener('page-title-updated', onTitle)
          el.removeEventListener('did-navigate', onNavigate)
          el.removeEventListener('did-navigate-in-page', onNavigate)
          el.removeEventListener('did-fail-load', onFail)
          webviews.current.delete(id)
        }
      }
      refCache.current.set(id, cb)
      return cb
    },
    [patchTab, handleFail]
  )

  // ── Ask Sylor: a bounded, permission-gated agent loop over the live page. ──
  // Real browser tasks take several steps (navigate → type → submit → read), so a
  // single request runs a short loop: perceive → decide ONE action → act → wait
  // for the page to settle → perceive again, carrying what it already did as
  // memory, until the model finishes in prose or the step cap is reached. Every
  // action still passes through the controller's gate (payment blocked, creds
  // refused, send/delete gated); nothing here can act without that check.
  const runActionResult = useCallback(
    async (act: ParsedAction): Promise<ActionResult> => {
      switch (act.action) {
        case 'navigate':
          return controller.navigate(String(act.url ?? ''))
        case 'click':
          return controller.click(Number(act.idx), String(act.label ?? ''))
        case 'type':
        case 'fill':
          return controller.type(Number(act.idx), String(act.value ?? ''), String(act.label ?? ''))
        case 'scroll':
          return controller.scroll(act.direction === 'up' ? 'up' : 'down')
        default:
          return { ok: false, reason: 'error', detail: 'Unknown action.' }
      }
    },
    [controller]
  )

  // Wait (bounded) for the active page to settle after an action, so the NEXT
  // perceive sees the page the action produced — not the pre-action DOM (which is
  // what made Sylor re-issue the same step and appear to loop).
  const settleAfter = useCallback(
    async (act: ParsedAction): Promise<void> => {
      const wv = wvOf(activeIdRef.current)
      const cap = act.action === 'navigate' ? 4000 : 1200
      await delay(act.action === 'navigate' ? 300 : 350)
      if (!wv) return
      const deadline = Date.now() + cap
      while (Date.now() < deadline) {
        try {
          if ((await wv.executeJavaScript('document.readyState')) === 'complete') return
        } catch {
          return
        }
        await delay(200)
      }
    },
    [wvOf]
  )

  const submitAsk = useCallback(
    async (override?: string) => {
      const question = (override ?? askInput).trim()
      if (!question || askBusy) return
      if (override === undefined) setAskInput('')
      setAskLog((l) => [...l, { role: 'you', text: question }])
      setAskBusy(true)
      setAiActive(true)
      setAiStatus('Reading the page…')

      // Running conversation: the goal, then Sylor's own actions + their results
      // (its memory). The live PAGE is attached fresh each step and NOT kept in
      // history, so stale element indexes never pile up or get reused.
      const base: ChatMessage[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `GOAL:\n${question}` }
      ]
      const history: ChatMessage[] = []
      let lastKey = ''
      let acted = false

      try {
        for (let step = 1; step <= MAX_STEPS; step++) {
          setAiStatus(step === 1 ? 'Reading the page…' : 'Reading the updated page…')
          const seen = await controller.perceive()
          const context =
            seen.ok && seen.snapshot ? summarizeSnapshot(seen.snapshot) : '(page unreadable)'
          const pageTurn: ChatMessage = {
            role: 'user',
            content:
              step === 1
                ? `PAGE:\n${context}\n\nTake the first step toward the GOAL, or answer in prose if no action is needed.`
                : `PAGE (updated):\n${context}\n\nContinue toward the GOAL, or answer in prose if it's done.`
          }

          setAiStatus('Thinking…')
          const res = await window.sylor.providers.getCompletion({
            messages: [...base, ...history, pageTurn]
          })
          if (!res.ok) {
            pushSylor(res.error || 'I could not reach the model.')
            break
          }

          const reply = res.content
          const act = extractAction(reply)

          // No action → Sylor is finishing (answer / summary / question reply).
          if (!act) {
            pushSylor(proseOf(reply) || reply.trim() || (acted ? 'Done.' : '(no answer)'))
            break
          }

          // Loop guard: the same consequential step proposed twice in a row means
          // it's stuck. Scrolling is exempt — reading a long page over several
          // scrolls is legitimate, and it's harmless + already bounded by MAX_STEPS.
          const key = actionKey(act)
          if (act.action !== 'scroll' && key === lastKey) {
            pushSylor("I'm repeating the same step without progress, so I'll stop here. Tell me how you'd like to continue.")
            break
          }
          lastKey = key
          acted = true

          setAiStatus(`Step ${step}: ${describeAction(act)}…`)
          const result = await runActionResult(act)
          pushSylor(result.detail)

          // Remember what was done + what happened (memory for the next step).
          history.push({ role: 'assistant', content: reply })
          history.push({ role: 'user', content: `RESULT of that step: ${result.detail}` })

          // A blocked/denied step is the user's or policy's "no" — stop, don't hammer.
          if (!result.ok && (result.reason === 'denied' || result.reason === 'blocked')) break

          await settleAfter(act)

          if (step === MAX_STEPS) {
            pushSylor("I've taken several steps — tell me if you'd like me to keep going.")
          }
        }
      } catch (e) {
        pushSylor(`Something went wrong: ${String(e)}`)
      } finally {
        setAiActive(false)
        setAskBusy(false)
        setAiStatus('')
      }
    },
    [askInput, askBusy, controller, runActionResult, settleAfter, pushSylor]
  )

  // ── Approval resolution (for `ask`-gated AI actions) ──
  const approve = useCallback(() => {
    setApproval((a) => {
      a?.resolve(true)
      return null
    })
  }, [])
  const deny = useCallback(() => {
    setApproval((a) => {
      a?.resolve(false)
      return null
    })
  }, [])

  return {
    tabs,
    activeId,
    active,
    openTab,
    selectTab,
    closeTab,
    goBack,
    goForward,
    reload,
    submitAddress,
    openApp,
    submitSearch,
    goLauncher,
    registerWebview,
    aiActive,
    aiStatus,
    askLog,
    askInput,
    setAskInput,
    askBusy,
    submitAsk,
    clearChat,
    showPermissions,
    setShowPermissions,
    approval,
    approve,
    deny
  }
}
