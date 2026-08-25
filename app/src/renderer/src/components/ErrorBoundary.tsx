/**
 * Renderer crash barrier.
 *
 * Electron has no browser chrome to fall back on: an uncaught render error
 * unmounts React's whole tree and leaves a **blank white window** with no way
 * back except killing the app — which is exactly the failure this was written
 * for (a specialist role missing from the chat's role-metadata map threw mid-plan
 * and blanked the app). A boundary turns that into a contained, readable card
 * with a retry, so one bad component can't take the window with it.
 *
 * Deliberately a class component: `getDerivedStateFromError` /
 * `componentDidCatch` have no hook equivalent in React 19.
 */
import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** Label for the failing region, shown in the fallback ("Chat", "Preview", …). */
  label?: string
}

interface State {
  error: Error | null
  /** Bumped on retry so the subtree remounts from scratch. */
  attempt: number
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, attempt: 0 }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the stack in the devtools console — the fallback shows only the
    // message, but a real diagnosis needs the component stack.
    console.error('[sylor] renderer error:', error, info.componentStack)
  }

  private retry = (): void => {
    this.setState((s) => ({ error: null, attempt: s.attempt + 1 }))
  }

  private reload = (): void => {
    window.location.reload()
  }

  render(): ReactNode {
    const { error } = this.state
    // Success path renders a keyed Fragment, NOT a wrapper <div>: a real element
    // here has no height class, so `height: 100%`/`h-full` children (App's root,
    // AppLayout's Group) would resolve against an auto-height box and collapse to
    // content height — the "app only fills the top third" regression. A Fragment
    // emits no DOM node, so the boundary is invisible to the layout while the
    // `attempt` key still forces a clean remount on Retry.
    if (!error) return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>

    const what = this.props.label ? `${this.props.label} hit an error` : 'Something went wrong'
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-6">
        <div className="max-w-md rounded-lg border border-red-500/40 bg-red-500/5 p-4">
          <div className="mb-1 text-[13px] font-semibold text-text">{what}</div>
          <p className="mb-3 text-[12px] leading-relaxed text-muted">
            Your conversations and settings are safe — they&apos;re stored on disk, not in this
            view. Retry to re-render, or reload the window if it keeps failing.
          </p>
          <pre className="mb-3 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-surface-2 p-2 text-[11px] text-red-300">
            {error.message || String(error)}
          </pre>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={this.retry}
              className="rounded bg-primary/15 px-2.5 py-1 text-[12px] font-medium text-primary transition-colors hover:bg-primary/25"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={this.reload}
              className="rounded bg-surface-2 px-2.5 py-1 text-[12px] font-medium text-muted transition-colors hover:text-text"
            >
              Reload window
            </button>
          </div>
        </div>
      </div>
    )
  }
}
