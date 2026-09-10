import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithCredential,
  type User
} from 'firebase/auth'
import { auth } from '../lib/firebase'

/*
 * Required sign-in gate for the desktop app.
 *
 * Google refuses its OAuth screen inside an embedded webview, so we never show it
 * in-app. "Continue with Google" asks the main process (auth-ipc.ts) to open the
 * system browser to sylorcode.vercel.app/authentication; that page signs in and relays
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
      const result = await window.sylor.auth.signInWithGoogle()
      if (!result.ok) {
        if (result.error) setError(result.error)
        return
      }
      await signInWithCredential(auth, GoogleAuthProvider.credential(result.idToken))
    } catch (err) {
      console.error('[sylor] sign-in failed:', err)
      setError('Sign-in failed. Please try again.')
    } finally {
      setBusy(false)
    }
  }, [])

  // Hold the first paint until auth state resolves, so an already-signed-in user
  // doesn't see the gate flash on launch.
  if (!ready) return null
  if (user) return <>{children}</>

  return (
    <div className="grid min-h-screen place-items-center bg-[#faf9f5] px-6 text-[#141413]">
      <div className="w-full max-w-sm text-center">
        <div className="mx-auto mb-6 grid h-14 w-14 place-items-center rounded-2xl bg-[#141413] text-3xl leading-none text-[#faf9f5]">
          ✻
        </div>
        <h1 className="mb-2 text-2xl font-semibold">Sign in to Sylor</h1>
        <p className="mb-8 text-sm text-[#141413]/60">
          Sylor opens your browser to sign in with Google, then brings you right back here.
        </p>

        {error && (
          <p className="mb-4 rounded-lg border border-[#cf5535]/30 bg-[#cf5535]/5 px-3 py-2 text-sm text-[#cf5535]">
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
