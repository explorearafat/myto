import { useCallback, useState } from 'react';
import { GoogleAuthProvider, signInWithPopup } from 'firebase/auth';
import { auth, googleProvider } from '../lib/firebase';

/*
 * The browser-mediated sign-in broker — the page a native app opens to sign in.
 *
 * Google refuses its OAuth screen inside embedded webviews (disallowed_useragent),
 * which is why sign-in fails from inside the desktop and mobile apps. So instead the
 * app opens the *system browser* here, we run the ordinary popup sign-in (which works
 * in a real browser), and hand the resulting Google ID token back to the app:
 *   • desktop → a loopback URL   http://127.0.0.1:<port>/callback
 *   • mobile  → a custom scheme   sylor://auth-callback
 * The app then completes Firebase sign-in itself with signInWithCredential — so no
 * server secret and no token minting happens here; we only relay Google's own token.
 */

type Platform = 'desktop' | 'mobile';
type Phase = 'idle' | 'signing' | 'handoff' | 'done' | 'error';

interface Target {
  platform: Platform;
  port: string | null;
  state: string;
}

/** Parse + validate the query the app opened us with. null = opened wrong / directly. */
function readTarget(): Target | null {
  const q = new URLSearchParams(window.location.search);
  const platform = q.get('platform');
  if (platform !== 'desktop' && platform !== 'mobile') return null;
  const port = q.get('port');
  if (platform === 'desktop') {
    const n = Number(port);
    if (!port || !Number.isInteger(n) || n < 1024 || n > 65535) return null;
  }
  return { platform, port, state: q.get('state') || '' };
}

/** Where to send the browser to hand the token back to the waiting app. */
function callbackUrl(t: Target, idToken: string): string {
  const params = new URLSearchParams({ id_token: idToken, state: t.state });
  return t.platform === 'desktop'
    ? `http://127.0.0.1:${t.port}/callback?${params.toString()}`
    : `sylor://auth-callback?${params.toString()}`;
}

export function AuthBroker() {
  const target = readTarget();
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState('');

  const start = useCallback(async () => {
    if (!target) return;
    setPhase('signing');
    setMessage('');
    try {
      const result = await signInWithPopup(auth, googleProvider);
      const idToken = GoogleAuthProvider.credentialFromResult(result)?.idToken;
      if (!idToken) throw new Error('no-id-token');
      setPhase('handoff');
      // Hand the token back to the app that opened this page, then leave a note behind.
      window.location.href = callbackUrl(target, idToken);
      window.setTimeout(() => setPhase('done'), 600);
    } catch (err) {
      const code = (err as { code?: string })?.code || '';
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
        setPhase('idle');
        return;
      }
      setPhase('error');
      setMessage(
        code === 'auth/unauthorized-domain'
          ? 'This site isn’t an authorized domain in Firebase yet.'
          : 'Sign-in failed. Please try again.',
      );
    }
  }, [target]);

  const appName = target?.platform === 'mobile' ? 'the Sylor app' : 'the Sylor desktop app';

  return (
    <main className="grid min-h-screen place-items-center bg-[#faf9f5] px-6 text-[#141413]">
      <div className="w-full max-w-sm text-center">
        <div className="mx-auto mb-6 grid h-12 w-12 place-items-center rounded-xl bg-[#141413] text-2xl leading-none text-[#faf9f5]">
          ✻
        </div>

        {!target ? (
          <>
            <h1 className="font-display mb-2 text-2xl font-normal">Nothing to authorize</h1>
            <p className="mb-8 text-sm text-[#141413]/60">
              Open this page from the “Sign in with Google” button inside the Sylor desktop or
              mobile app — it isn’t meant to be visited directly.
            </p>
            <a
              href="/"
              className="inline-block rounded-lg border border-[#141413]/15 px-4 py-2 text-sm font-medium hover:bg-[#141413]/5"
            >
              Back to Sylor
            </a>
          </>
        ) : (
          <>
            <h1 className="font-display mb-2 text-2xl font-normal">Sign in to Sylor</h1>
            <p className="mb-8 text-sm text-[#141413]/60">
              Continue with Google to finish signing in to {appName}.
            </p>

            {phase === 'error' && (
              <p className="mb-4 rounded-lg border border-[#cf5535]/30 bg-[#cf5535]/5 px-3 py-2 text-sm text-[#cf5535]">
                {message}
              </p>
            )}

            {(phase === 'idle' || phase === 'error') && (
              <button
                type="button"
                onClick={start}
                className="w-full rounded-lg bg-[#141413] px-4 py-3 font-medium text-[#faf9f5] transition hover:opacity-90"
              >
                Continue with Google
              </button>
            )}

            {phase === 'signing' && (
              <p className="text-sm text-[#141413]/60">Opening Google…</p>
            )}
            {phase === 'handoff' && (
              <p className="text-sm text-[#141413]/60">Returning you to {appName}…</p>
            )}
            {phase === 'done' && (
              <div>
                <p className="font-display mb-1 text-lg font-normal">You’re signed in.</p>
                <p className="text-sm text-[#141413]/60">
                  You can close this tab and return to {appName}.
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}
