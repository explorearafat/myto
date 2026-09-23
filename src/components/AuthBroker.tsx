import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  GoogleAuthProvider,
  getRedirectResult,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type User,
} from 'firebase/auth';
import { Globe, LoaderCircle, LogOut, Monitor, Smartphone } from 'lucide-react';
import { auth, googleProvider } from '../lib/firebase';
import { getDeviceId, listDevices, recordDeviceSignIn } from '../lib/devices';
import { absoluteDate, relativeTime, type DevicePlatform, type DeviceSession } from '../shared/device';
import { MytoMark } from './MytoMark';
import { ByokPanel } from './ByokPanel';

/*
 * The browser-mediated sign-in broker — the page a native app opens to sign in — and the account's
 * device dashboard.
 *
 * Google refuses its OAuth screen inside embedded webviews (disallowed_useragent), which is why
 * sign-in fails from inside the desktop and mobile apps. So instead the app opens the *system browser*
 * here, we run Google sign-in (which works in a real browser), and hand the resulting Google ID token
 * back to the app:
 *   • desktop → a loopback URL   http://127.0.0.1:<port>/callback
 *   • mobile  → a custom scheme   sylor://auth-callback
 * The app then completes Firebase sign-in itself with signInWithCredential — so no server secret and
 * no token minting happens here; we only relay Google's own token. The query parsing (readTarget) and
 * the callback URL (callbackUrl) are the app's contract and must stay byte-for-byte stable.
 *
 * When opened by an app, the flow is two explicit steps:
 *   1. "Continue with Google" — the OAuth grant. Desktop uses a popup; mobile opens this page inside a
 *      Chrome Custom Tab, which can't host a popup, so mobile uses signInWithRedirect (+ getRedirectResult
 *      on the way back). We capture Google's OIDC id_token at that moment (it only exists then).
 *   2. "Authorize this device" — records the device at users/{uid}/devices/{deviceId} (best-effort),
 *      then counts down 3 seconds and redirects back to the app with the id_token.
 *
 * Visiting /authentication directly while signed in (no app target) shows the account's devices — how
 * many have signed in, and when.
 */

type Platform = 'desktop' | 'mobile';
type Phase = 'idle' | 'signing' | 'authorize' | 'authorizing' | 'redirecting' | 'error';

interface Target {
  platform: Platform;
  port: string | null;
  state: string;
}

/** Google's OIDC id_token, stashed so it survives the full-page reload the mobile redirect does. */
const IDTOKEN_STASH_KEY = 'sylor.broker.idtoken';
/** Seconds shown on the "returning you to the app" countdown after a device is authorized. */
const REDIRECT_SECONDS = 3;

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

/** Turn a Firebase sign-in error into a short line, or '' when it should be silent (user closed it). */
function describeSignInError(err: unknown): string {
  const code = (err as { code?: string })?.code || '';
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return '';
  if (code === 'auth/unauthorized-domain') return 'This site isn’t an authorized domain in Firebase yet.';
  if (code === 'auth/popup-blocked') return 'Your browser blocked the sign-in popup. Allow popups and try again.';
  return 'Sign-in failed. Please try again.';
}

/** Multicolor Google "G", inlined so the page depends on no brand-icon set (mirrors SignInGate). */
function GoogleG({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.28-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

const GOOGLE_BTN =
  'flex w-full items-center justify-center gap-3 rounded-xl border border-[#e4e1d8] bg-white px-4 py-3 text-[15px] font-medium text-[#141413] transition-colors duration-150 hover:border-[#cbc6ba] hover:bg-[#fbfaf7] disabled:cursor-not-allowed disabled:opacity-60';
const PRIMARY_BTN =
  'flex w-full items-center justify-center gap-2 rounded-xl bg-[#141413] px-4 py-3 text-[15px] font-medium text-white transition-colors duration-150 hover:bg-[#2b2a27] disabled:cursor-not-allowed disabled:opacity-60';
const ERROR_BOX =
  'rounded-lg border border-[#e4b8a8] bg-[#f9ede8] px-3 py-2 text-[13px] leading-relaxed text-[#8a3b22]';

/** The paper page frame with the warm hero wash behind, shared by every state. */
function Shell({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <main className="relative grid min-h-[100dvh] place-items-center overflow-hidden bg-[#faf9f5] px-6 py-16 text-[#141413]">
      <div aria-hidden="true" className="hero-aura" />
      <div className={'chat-in relative w-full ' + (wide ? 'max-w-lg' : 'max-w-sm')}>{children}</div>
    </main>
  );
}

/** The centered star + heading + subhead used at the top of each card. */
function CardHead({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center text-center">
      <MytoMark size={34} title="Myto" />
      <h1 className="font-display mt-4 text-[26px] font-normal leading-tight">{title}</h1>
      <p className="mt-2 max-w-[44ch] text-[14px] leading-relaxed text-[#6b675e]">{children}</p>
    </div>
  );
}

function PlatformIcon({ platform }: { platform: DevicePlatform }) {
  const cls = 'h-4 w-4';
  if (platform === 'desktop') return <Monitor className={cls} aria-hidden="true" />;
  if (platform === 'mobile') return <Smartphone className={cls} aria-hidden="true" />;
  return <Globe className={cls} aria-hidden="true" />;
}

function platformLabel(platform: DevicePlatform): string {
  if (platform === 'desktop') return 'Desktop app';
  if (platform === 'mobile') return 'Mobile app';
  return 'Web';
}

/** Two initials for the avatar fallback when the account has no photo. */
function initialsOf(u: User): string {
  const base = (u.displayName || u.email || '').trim();
  if (!base) return 'M';
  const parts = base.split(/\s+/);
  const first = parts[0]?.[0] || '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase() || base[0].toUpperCase();
}

/** Avatar + name + email for the signed-in account, reused by the authorize card and the dashboard. */
function AccountIdentity({ user }: { user: User }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      {user.photoURL ? (
        <img src={user.photoURL} alt="" className="h-9 w-9 rounded-full" />
      ) : (
        <div className="grid h-9 w-9 place-items-center rounded-full bg-[#141413] text-[13px] font-semibold text-[#faf9f5]">
          {initialsOf(user)}
        </div>
      )}
      <div className="min-w-0">
        <div className="truncate text-[14px] font-medium text-[#141413]">
          {user.displayName || 'Signed in'}
        </div>
        {user.email ? <div className="truncate text-[13px] text-[#6b675e]">{user.email}</div> : null}
      </div>
    </div>
  );
}

/** The list of devices that have signed in — one calm row each. */
function DeviceList({ devices }: { devices: DeviceSession[] }) {
  if (devices.length === 0) {
    return (
      <p className="rounded-xl border border-[#e4e1d8] bg-white px-4 py-5 text-center text-[14px] text-[#6b675e]">
        No device sign-ins recorded yet.
      </p>
    );
  }
  const currentId = getDeviceId();
  return (
    <ul className="space-y-3">
      {devices.map((d) => {
        const current = d.deviceId === currentId;
        return (
          <li
            key={d.deviceId}
            className="flex items-start gap-3.5 rounded-xl border border-[#e4e1d8] bg-white p-4 text-left"
          >
            <div className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[#f4f1ea] text-[#8a6f5f]">
              <PlatformIcon platform={d.platform} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-[15px] font-medium text-[#141413]">{d.label}</span>
                {current ? (
                  <span className="rounded-full border border-[#d8d5cc] bg-[#fbeee9] px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-[#57544e]">
                    This device
                  </span>
                ) : null}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] text-[#6b675e]">
                <span className="rounded-md bg-[#f0eee6] px-1.5 py-0.5 text-[12px] font-medium">
                  {platformLabel(d.platform)}
                </span>
                <span>Last active {relativeTime(d.lastSeenAt)}</span>
              </div>
              <div className="mt-1 text-[12px] text-[#9c988e]">
                First signed in {absoluteDate(d.firstSeenAt)} · {d.count} sign-in
                {d.count === 1 ? '' : 's'}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function AuthBroker() {
  const [target] = useState(readTarget);
  // undefined = auth still resolving, null = signed out, User = signed in.
  const [authUser, setAuthUser] = useState<User | null | undefined>(undefined);
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState('');
  // Google's OIDC id_token, captured at the OAuth moment and handed back to the app.
  const [idToken, setIdToken] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(REDIRECT_SECONDS);
  const [devices, setDevices] = useState<DeviceSession[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [recordOk, setRecordOk] = useState(true);
  const [directBusy, setDirectBusy] = useState(false);
  // Guards the direct-visit record so it runs once per mount (StrictMode double-invokes effects).
  const recordedRef = useRef(false);
  // Guards the one-shot getRedirectResult read on the broker path.
  const redirectCheckedRef = useRef(false);

  // Track the web sign-in state so a direct visit can show the account's devices.
  useEffect(() => onAuthStateChanged(auth, (u) => setAuthUser(u)), []);

  // Broker path: on load, pick up the result of a mobile signInWithRedirect (or a stashed token from a
  // reload) and move straight to the "authorize this device" step. A no-op on the desktop popup path.
  useEffect(() => {
    if (!target || redirectCheckedRef.current) return;
    redirectCheckedRef.current = true;
    void (async () => {
      try {
        const result = await getRedirectResult(auth);
        const token = result ? GoogleAuthProvider.credentialFromResult(result)?.idToken : undefined;
        if (token) {
          try {
            sessionStorage.setItem(IDTOKEN_STASH_KEY, token);
          } catch {
            /* sessionStorage unavailable — keep the in-memory copy */
          }
          setIdToken(token);
          setPhase('authorize');
          return;
        }
      } catch (err) {
        const msg = describeSignInError(err);
        if (msg) {
          setPhase('error');
          setMessage(msg);
          return;
        }
      }
      // No fresh redirect result: restore a stashed token if a reload dropped our in-memory one.
      try {
        const stashed = sessionStorage.getItem(IDTOKEN_STASH_KEY);
        if (stashed) {
          setIdToken(stashed);
          setPhase('authorize');
        }
      } catch {
        /* sessionStorage unavailable — stay on the sign-in step */
      }
    })();
  }, [target]);

  // Direct visit while signed in: record this browser once, then load the device list.
  useEffect(() => {
    if (target || !authUser || recordedRef.current) return;
    recordedRef.current = true;
    setDevicesLoading(true);
    void (async () => {
      const ok = await recordDeviceSignIn(authUser.uid, 'web');
      const rows = await listDevices(authUser.uid);
      setRecordOk(ok);
      setDevices(rows);
      setDevicesLoading(false);
    })();
  }, [target, authUser]);

  // Once a device is authorized, tick the countdown down and hand the token back to the app at zero.
  useEffect(() => {
    if (phase !== 'redirecting') return;
    if (countdown <= 0) {
      try {
        sessionStorage.removeItem(IDTOKEN_STASH_KEY);
      } catch {
        /* ignore */
      }
      if (target && idToken) window.location.href = callbackUrl(target, idToken);
      return;
    }
    const t = window.setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => window.clearTimeout(t);
  }, [phase, countdown, target, idToken]);

  // Step 1 of the broker flow: the Google OAuth grant. Popup on desktop; redirect on mobile, whose
  // Custom Tab can't host a popup (the page then reloads and the effect above resumes at 'authorize').
  const beginSignIn = useCallback(async () => {
    if (!target) return;
    setPhase('signing');
    setMessage('');
    try {
      if (target.platform === 'mobile') {
        await signInWithRedirect(auth, googleProvider);
        return; // the page navigates away to Google
      }
      const result = await signInWithPopup(auth, googleProvider);
      const token = GoogleAuthProvider.credentialFromResult(result)?.idToken;
      if (!token) throw new Error('no-id-token');
      try {
        sessionStorage.setItem(IDTOKEN_STASH_KEY, token);
      } catch {
        /* non-fatal */
      }
      setIdToken(token);
      setPhase('authorize');
    } catch (err) {
      const msg = describeSignInError(err);
      if (!msg) {
        setPhase('idle');
        return;
      }
      setPhase('error');
      setMessage(msg);
    }
  }, [target]);

  // Step 2: record this device (best-effort — never blocks the handoff), then start the countdown.
  const authorizeDevice = useCallback(async () => {
    if (!target || !idToken) return;
    setPhase('authorizing');
    setMessage('');
    const uid = authUser?.uid ?? auth.currentUser?.uid;
    if (uid) await recordDeviceSignIn(uid, target.platform);
    setCountdown(REDIRECT_SECONDS);
    setPhase('redirecting');
  }, [target, idToken, authUser]);

  // Direct-visit sign-in: onAuthStateChanged then drives the dashboard effect above.
  const signInPlain = useCallback(async () => {
    setDirectBusy(true);
    setMessage('');
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      setMessage(describeSignInError(err));
    } finally {
      setDirectBusy(false);
    }
  }, []);

  const doSignOut = useCallback(async () => {
    await signOut(auth);
    setDevices([]);
    setRecordOk(true);
    recordedRef.current = false;
  }, []);

  // ── Broker flow (app opened this page). Independent of the web session — always mint a fresh token. ──
  if (target) {
    const appName = target.platform === 'mobile' ? 'the Myto app' : 'the Myto desktop app';

    // Signed in with a fresh token — authorize this device, then count down and hand off.
    if (phase === 'authorize' || phase === 'authorizing' || phase === 'redirecting') {
      const redirecting = phase === 'redirecting';
      const subhead = redirecting
        ? `This device is authorized. Returning you to ${appName} in ${countdown}…`
        : phase === 'authorizing'
          ? 'Authorizing this device…'
          : `You’re signed in${authUser?.email ? ' as ' + authUser.email : ''}. Authorize this device to finish and return to ${appName}.`;
      return (
        <Shell>
          <CardHead title={redirecting ? 'Device authorized' : 'Authorize this device'}>
            {subhead}
          </CardHead>

          {authUser ? (
            <div className="mt-6 rounded-xl border border-[#e4e1d8] bg-white px-4 py-3">
              <AccountIdentity user={authUser} />
            </div>
          ) : null}

          <div className="mt-6">
            {phase === 'authorize' ? (
              <button type="button" onClick={authorizeDevice} className={PRIMARY_BTN}>
                Authorize this device
              </button>
            ) : (
              <p className="flex items-center justify-center gap-2 text-[14px] text-[#6b675e]">
                <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                {redirecting ? `Returning to ${appName} in ${countdown}…` : 'Authorizing…'}
              </p>
            )}
          </div>

          {phase === 'authorize' ? (
            <p className="mt-5 text-center text-[12px] leading-relaxed text-[#9c988e]">
              This device will be added to your account. You can review it any time on this page.
            </p>
          ) : null}
        </Shell>
      );
    }

    // Not signed in yet — run the Google OAuth grant.
    return (
      <Shell>
        <CardHead title="Sign in to Myto">
          Continue with Google to sign in to {appName}.
        </CardHead>

        {phase === 'error' && message ? <p className={'mt-5 ' + ERROR_BOX}>{message}</p> : null}

        <div className="mt-7">
          {phase === 'idle' || phase === 'error' ? (
            <button type="button" onClick={beginSignIn} className={GOOGLE_BTN}>
              <GoogleG className="h-5 w-5" />
              Continue with Google
            </button>
          ) : (
            <p className="flex items-center justify-center gap-2 text-[14px] text-[#6b675e]">
              <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
              Opening Google…
            </p>
          )}
        </div>
      </Shell>
    );
  }

  // ── Direct visit: wait for auth, then show the dashboard or a sign-in prompt. ──
  if (authUser === undefined) {
    return (
      <Shell>
        <div className="flex flex-col items-center gap-3 py-6 text-[#6b675e]">
          <MytoMark size={30} title="Myto" />
          <LoaderCircle className="h-5 w-5 animate-spin text-[#141413]" aria-hidden="true" />
        </div>
      </Shell>
    );
  }

  if (authUser) {
    const count = devices.length;
    return (
      <Shell wide>
        <CardHead title="Your devices">
          {count === 0
            ? 'This is where sign-ins made through Myto’s web sign-in show up.'
            : `Signed in on ${count} device${count === 1 ? '' : 's'} through Myto’s web sign-in.`}
        </CardHead>

        <div className="mt-6 mb-4 flex items-center justify-between gap-3 rounded-xl border border-[#e4e1d8] bg-white px-4 py-3">
          <AccountIdentity user={authUser} />
          <button
            type="button"
            onClick={doSignOut}
            className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-[#e4e1d8] bg-white px-3 py-2 text-[13px] font-medium text-[#141413] transition-colors duration-150 hover:border-[#cbc6ba] hover:bg-[#fbfaf7]"
          >
            <LogOut className="h-4 w-4" aria-hidden="true" />
            Sign out
          </button>
        </div>

        {devicesLoading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-[14px] text-[#6b675e]">
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
            Loading your devices…
          </div>
        ) : recordOk ? (
          <DeviceList devices={devices} />
        ) : (
          <p className={ERROR_BOX}>
            Couldn’t load your devices. If this keeps happening, the sign-in security rules may not be
            published yet.
          </p>
        )}

        <p className="mt-5 text-center text-[12px] leading-relaxed text-[#9c988e]">
          Only sign-ins made through this page are listed — not every session on every device.
        </p>

        <div className="mt-10 border-t border-[#e4e1d8] pt-8">
          <div className="mb-5 text-center">
            <h2 className="font-display text-[22px] font-normal leading-tight text-[#141413]">
              Your models
            </h2>
            <p className="mx-auto mt-2 max-w-[46ch] text-[14px] leading-relaxed text-[#6b675e]">
              Add your own provider and models. These power chat in Myto’s web app, desktop app, and
              mobile app — everywhere you’re signed in.
            </p>
          </div>
          <ByokPanel uid={authUser.uid} />
        </div>
      </Shell>
    );
  }

  // Signed out, opened directly.
  return (
    <Shell>
      <CardHead title="Myto sign-in">
        This is the page the Myto desktop and mobile apps open to sign in with Google. Sign in here to
        see the devices on your account.
      </CardHead>

      <div className="mt-7">
        <button type="button" onClick={signInPlain} disabled={directBusy} className={GOOGLE_BTN}>
          {directBusy ? (
            <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden="true" />
          ) : (
            <GoogleG className="h-5 w-5" />
          )}
          Continue with Google
        </button>
      </div>

      {message ? <p className={'mt-4 ' + ERROR_BOX}>{message}</p> : null}

      <div className="mt-6 text-center">
        <a
          href="/"
          className="text-[13px] font-medium text-[#141413] underline decoration-[#cbc6ba] underline-offset-2 transition-colors duration-150 hover:decoration-[#141413]"
        >
          Back to Myto
        </a>
      </div>
    </Shell>
  );
}
