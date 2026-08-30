/**
 * JSX + DOM typing for the Electron `<webview>` tag used by the live-preview panel.
 *
 * `<webview>` is a custom element Electron injects when `webviewTag: true` is set
 * (see window.ts) — it is not a standard HTML element, so React's JSX namespace
 * has no built-in definition for it. We declare only the handful of attributes and
 * imperative methods PreviewPanel actually touches. React 19 scopes the JSX
 * namespace inside the `react` module, so we augment it with `declare module`.
 */
import type { DetailedHTMLProps, HTMLAttributes } from 'react'

/** Attributes we set on `<webview>` in JSX. */
interface WebviewHTMLAttributes<T> extends HTMLAttributes<T> {
  /** Localhost URL to load in the guest page. */
  src?: string
  /** Session partition; `preview` keeps the guest outside the strict app CSP. */
  partition?: string
  /** Present to allow popups — Electron exposes this as a boolean attribute. */
  allowpopups?: boolean
  /** Present (as "true") to isolate the guest in its own OS process. */
  webpreferences?: string
  /** User agent override for the guest page. */
  useragent?: string
}

/** The subset of Electron's WebviewTag DOM API the panel/Sylorium call imperatively. */
export interface WebviewElement extends HTMLElement {
  reload(): void
  reloadIgnoringCache(): void
  loadURL(url: string): Promise<void>
  getURL(): string
  getTitle(): string
  stop(): void
  goBack(): void
  goForward(): void
  canGoBack(): boolean
  canGoForward(): boolean
  /** Run JS in the guest and resolve with its result — the DOM-perception path. */
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
  /**
   * Snapshot the guest as a NativeImage — the vision/OCR fallback of last resort
   * (see perception.ts). `toDataURL()` yields a `data:image/png;base64,…` string
   * we can hand to a vision model when the DOM and accessibility tree come back
   * empty (canvas apps, cross-origin frames).
   */
  capturePage(): Promise<{ toDataURL(): string; isEmpty(): boolean }>
}

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<WebviewHTMLAttributes<WebviewElement>, WebviewElement>
    }
  }
}
