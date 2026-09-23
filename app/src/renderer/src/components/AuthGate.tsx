import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithCredential,
  type User
} from 'firebase/auth'
import { auth } from '../lib/firebase'
import { MytoMark } from './MytoMark'

/*
 * Required sign-in gate for the desktop app.
 *
 * Google refuses its OAuth screen inside an embedded webview, so we never show it
 * in-app. "Continue with Google" asks the main process (auth-ipc.ts) to open the
 * system browser to mytocode.vercel.app/authentication; that page signs in and relays
 * the Google ID token back to a loopback listener. We finish here with
 * signInWithCredential — a plain REST call that needs no popup and no extra setup.
 *
 * Sign-in is required: until a user is present, the gate covers the whole app.
 */
export function AuthGate({ children }: { children: ReactNode }): React.JSX.Element | null {
  const [user, setUser] = useState<User | null>(null)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(
    () =>
      onAuthStateChanged(auth, (u) => {
        setUser(u)
        setReady(true)
      }),
    []
  )

  const signIn = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      const result = await window.myto.auth.signInWithGoogle()
      if (!result.ok) {
        if (result.error) setError(result.error)
        return
      }
      await signInWithCredential(auth, GoogleAuthProvider.credential(result.idToken))
    } catch (err) {
      console.error('[myto] sign-in failed:', err)
      setError('Sign-in failed. Please try again.')
    } finally {
      setBusy(false)
    }
  }, [])

  // Hold the first paint until auth state resolves, so an already-signed-in user
  // doesn't see the gate flash on launch.
  if (!ready) return null
  if (user) return <>{children}</>

  // The browser-preview shim (DEV-only, never present in the packaged app — see
  // browser-preview-shim.ts) can't run Google's loopback sign-in, so the gate
  // would block the very screenshots the shim exists to enable. When it's active,
  // treat the app as signed-in chrome and render straight through.
  if (window.__mytoPreviewShim) return <>{children}</>


  return (
    <div className="grid min-h-screen place-items-center bg-[#faf9f5] px-6 text-[#141413]">
      <div className="w-full max-w-sm text-center">
        <div className="mx-auto mb-6 flex justify-center">
          <MytoMark size={40} />
        </div>
        <h1 className="mb-2 text-2xl font-semibold">Sign in to Myto</h1>
        <p className="mb-8 text-sm text-[#141413]/60">
          Myto opens your browser to sign in with Google, then brings you right back here.
        </p>

        {error && (
          <p className="mb-4 rounded-lg border border-[#141413]/20 bg-[#141413]/[0.04] px-3 py-2 text-sm text-[#141413]/80">
            {error}
          </p>
        )}

        <button
          type="button"
          onClick={signIn}
          disabled={busy}
          className="w-full rounded-lg bg-[#141413] px-4 py-3 font-medium text-[#faf9f5] transition hover:opacity-90 disabled:opacity-60"
        >
          {busy ? 'Waiting for your browser…' : 'Continue with Google'}
        </button>
      </div>
    </div>
  )
}
