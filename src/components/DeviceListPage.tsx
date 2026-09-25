// A per-OS device list page (/android, /apple, /windows, /linux). Each route mounts this with a
// DeviceOsGroup; it lists the account's Myto web sign-ins from that OS family, three cards per row.
// Auth-gated exactly like the /authentication dashboard (onAuthStateChanged + listDevices); signed out
// shows the same Google prompt. It only READS device history — the sign-in itself is recorded on
// /authentication — so opening a device page never mints a record or touches the broker contract.

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth';
import { Globe, LoaderCircle, LogOut, Monitor, Smartphone } from 'lucide-react';
import { auth, googleProvider } from '../lib/firebase';
import { getDeviceId, listDevices } from '../lib/devices';
import { absoluteDate, relativeTime, type DevicePlatform, type DeviceSession } from '../shared/device';
import { MytoMark } from './MytoMark';

/** Which OS family a route shows. `/apple` groups macOS + iOS; the rest map 1:1 to DeviceSession.os. */
export type DeviceOsGroup = 'Android' | 'Windows' | 'Linux' | 'Apple';

function matchesGroup(os: string, group: DeviceOsGroup): boolean {
  if (group === 'Apple') return os === 'macOS' || os === 'iOS';
  return os === group;
}

const GOOGLE_BTN =
  'flex w-full items-center justify-center gap-3 rounded-xl border border-[#e4e1d8] bg-white px-4 py-3 text-[15px] font-medium text-[#141413] transition-colors duration-150 hover:border-[#cbc6ba] hover:bg-[#fbfaf7] disabled:cursor-not-allowed disabled:opacity-60';

/** Multicolor Google "G", inlined so the page needs no brand-icon set (mirrors AuthBroker). */
function GoogleG({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.28-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

/** The paper page frame with the warm hero wash, matching the /authentication shell. */
function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="relative min-h-[100dvh] overflow-hidden bg-[#faf9f5] px-6 py-14 text-[#141413]">
      <div aria-hidden="true" className="hero-aura" />
      <div className="chat-in relative mx-auto w-full max-w-4xl">{children}</div>
    </main>
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

/** One key/value line inside a device card. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-[12px] uppercase tracking-wide text-[#9c988e]">{label}</dt>
      <dd className="min-w-0 truncate text-right font-medium text-[#544f46]">{children}</dd>
    </div>
  );
}

export function DeviceListPage({ group, title }: { group: DeviceOsGroup; title: string }) {
  // undefined = auth still resolving, null = signed out, User = signed in.
  const [authUser, setAuthUser] = useState<User | null | undefined>(undefined);
  const [devices, setDevices] = useState<DeviceSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => onAuthStateChanged(auth, (u) => setAuthUser(u)), []);

  // Signed in: load the account's devices once. Read-only — no recordDeviceSignIn here.
  useEffect(() => {
    if (!authUser) return;
    let alive = true;
    setLoading(true);
    void (async () => {
      const rows = await listDevices(authUser.uid);
      if (!alive) return;
      setDevices(rows);
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [authUser]);
  const signIn = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      await signInWithPopup(auth, googleProvider);
    } catch {
      setError('Sign-in failed. Please try again.');
    } finally {
      setBusy(false);
    }
  }, []);

  const doSignOut = useCallback(async () => {
    await signOut(auth);
    setDevices([]);
  }, []);

  // Auth still resolving.
  if (authUser === undefined) {
    return (
      <Shell>
        <div className="flex flex-col items-center gap-3 py-20 text-[#6b675e]">
          <MytoMark size={30} title="Myto" />
          <LoaderCircle className="h-5 w-5 animate-spin text-[#141413]" aria-hidden="true" />
        </div>
      </Shell>
    );
  }

  // Signed out — the same Google prompt as the dashboard.
  if (!authUser) {
    return (
      <Shell>
        <div className="mx-auto max-w-sm text-center">
          <MytoMark size={34} title="Myto" />
          <h1 className="font-display mt-4 text-[26px] font-normal leading-tight">{title}</h1>
          <p className="mx-auto mt-2 max-w-[44ch] text-[14px] leading-relaxed text-[#6b675e]">
            Sign in with Google to see the {title.toLowerCase()} on your account.
          </p>
          <div className="mt-7">
            <button type="button" onClick={signIn} disabled={busy} className={GOOGLE_BTN}>
              {busy ? (
                <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden="true" />
              ) : (
                <GoogleG className="h-5 w-5" />
              )}
              Continue with Google
            </button>
          </div>
          {error ? (
            <p className="mt-4 rounded-lg border border-[#e4b8a8] bg-[#f9ede8] px-3 py-2 text-[13px] leading-relaxed text-[#8a3b22]">
              {error}
            </p>
          ) : null}
          <div className="mt-6">
            <a
              href="/authentication"
              className="text-[13px] font-medium text-[#141413] underline decoration-[#cbc6ba] underline-offset-2 transition-colors duration-150 hover:decoration-[#141413]"
            >
              Back to your account
            </a>
          </div>
        </div>
      </Shell>
    );
  }
  // Signed in — the device grid for this OS family.
  const matches = devices.filter((d) => matchesGroup(d.os, group));
  const currentId = getDeviceId();

  return (
    <Shell>
      <div className="mb-6 flex items-center justify-between gap-3">
        <a
          href="/authentication"
          className="inline-flex items-center gap-2 text-[13px] font-medium text-[#6b675e] transition-colors duration-150 hover:text-[#141413]"
        >
          <span aria-hidden="true">←</span> Back to your account
        </a>
        <div className="flex items-center gap-2">
          <MytoMark size={22} title="Myto" />
          <span className="font-display text-[17px] font-normal">Myto</span>
        </div>
      </div>

      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-[30px] font-normal leading-tight">{title}</h1>
          <p className="mt-1 text-[14px] text-[#6b675e]">
            {loading
              ? 'Loading your devices…'
              : `${matches.length} device${matches.length === 1 ? '' : 's'} signed in through Myto’s web sign-in.`}
          </p>
        </div>
        <button
          type="button"
          onClick={doSignOut}
          className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-[#e4e1d8] bg-white px-3 py-2 text-[13px] font-medium text-[#141413] transition-colors duration-150 hover:border-[#cbc6ba] hover:bg-[#fbfaf7]"
        >
          <LogOut className="h-4 w-4" aria-hidden="true" /> Sign out
        </button>
      </div>
      {loading ? (
        <div className="flex items-center justify-center gap-2 rounded-2xl border border-[#e9e6dd] bg-white/60 py-16 text-[14px] text-[#6b675e]">
          <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading your devices…
        </div>
      ) : matches.length === 0 ? (
        <div className="rounded-2xl border border-[#e9e6dd] bg-white/60 px-6 py-16 text-center">
          <p className="text-[15px] text-[#6b675e]">No {title.toLowerCase()} recorded yet.</p>
          <p className="mx-auto mt-2 max-w-[46ch] text-[13px] leading-relaxed text-[#9c988e]">
            Sign in to Myto from this kind of device and it’ll show up here.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {matches.map((d) => {
            const current = d.deviceId === currentId;
            return (
              <div
                key={d.deviceId}
                className="rounded-2xl border border-[#e4e1d8] bg-white p-5 text-left"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[#f4f1ea] text-[#8a6f5f]">
                      <PlatformIcon platform={d.platform} />
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-[15px] font-medium text-[#141413]">{d.label}</div>
                      <div className="text-[12px] text-[#9c988e]">
                        {platformLabel(d.platform)} · {d.count} sign-in{d.count === 1 ? '' : 's'}
                      </div>
                    </div>
                  </div>
                  {current ? (
                    <span className="shrink-0 rounded-full border border-[#d8d5cc] bg-[#fbeee9] px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-[#57544e]">
                      This device
                    </span>
                  ) : null}
                </div>

                <dl className="mt-4 space-y-2 border-t border-[#eceae2] pt-4 text-[13px]">
                  <Row label="First seen">{absoluteDate(d.firstSeenAt)}</Row>
                  <Row label="Last active">{relativeTime(d.lastSeenAt)}</Row>
                  <Row label="IP">{d.ip || '—'}</Row>
                  <Row label="Location">{d.location || '—'}</Row>
                </dl>
              </div>
            );
          })}
        </div>
      )}

      <p className="mt-6 text-center text-[12px] leading-relaxed text-[#9c988e]">
        Only sign-ins made through Myto’s web sign-in are listed. IP and location are best-effort and
        stored only on your own account.
      </p>
    </Shell>
  );
}
