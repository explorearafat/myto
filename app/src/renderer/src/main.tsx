// browser-preview-shim MUST run first: in a plain browser (no Electron preload)
// it installs an in-memory `window.myto` so the UI renders for screenshots. It
// is a no-op inside the packaged app (the real bridge is already present).
import './lib/browser-preview-shim'
import './styles/globals.css'

import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { AuthGate } from './components/AuthGate'
import { ErrorBoundary } from './components/ErrorBoundary'
import { useEditorStore } from './store/useEditorStore'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <AuthGate>
        <App />
      </AuthGate>
    </ErrorBoundary>
  </React.StrictMode>
)

// Browser-preview only (never in the packaged app): expose the editor store so the Studio
// can be opened for screenshots/manual verification without the Electron thread UI.
if (typeof window !== 'undefined' && window.__mytoPreviewShim) {
  ;(window as unknown as { __studio?: unknown }).__studio = useEditorStore
}
