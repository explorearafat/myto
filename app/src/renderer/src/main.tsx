// browser-preview-shim MUST run first: in a plain browser (no Electron preload)
// it installs an in-memory `window.sylor` so the UI renders for screenshots. It
// is a no-op inside the packaged app (the real bridge is already present).
import './lib/browser-preview-shim'
// monaco-env MUST be imported early so MonacoEnvironment + the local loader are
// registered before any <Editor /> mounts (otherwise it falls back to the CDN).
import './lib/monaco-env'
import './styles/globals.css'

import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { AuthGate } from './components/AuthGate'
import { ErrorBoundary } from './components/ErrorBoundary'
import { StatusWidget } from './components/StatusWidget'

/*
 * One bundle, two windows.
 *
 * `main/widget.ts` loads this same entry at `#/widget` so the floating status card
 * inherits the preload bridge, the CSP, the theme tokens and the fonts for free —
 * a second HTML entry would have to be given all four again. There is no router
 * here (and adding one for a single frameless card would be a lot of machinery for
 * one branch), so the hash is checked directly.
 */
const isWidget = window.location.hash.startsWith('#/widget')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>{isWidget ? <StatusWidget /> : <AuthGate><App /></AuthGate>}</ErrorBoundary>
  </React.StrictMode>
)
