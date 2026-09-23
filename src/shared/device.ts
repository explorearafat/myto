// A record of a device that has signed in to Myto through the web sign-in page (/authentication).
// Stored in Firestore at users/{uid}/devices/{deviceId} (client-side, guarded by firestore.rules),
// one document per browser. Nothing here is secret — it is the user's own sign-in history.
//
// This module is deliberately PURE and dependency-free (like profile.ts): no localStorage, no crypto,
// no navigator. The browser-only glue — minting a device id, reading navigator.userAgent, and the
// Firestore reads/writes — lives in src/lib/devices.ts. Keeping the stored shape and the user-agent
// parser here means both stay importable and testable without a browser.

/** Which Myto surface a sign-in came through. */
export type DevicePlatform = 'web' | 'desktop' | 'mobile';

export interface DeviceSession {
  /** Stable per-browser id — also the Firestore document id. */
  deviceId: string;
  /** Browser name, e.g. "Chrome", "Safari", "Firefox", "Edge". */
  browser: string;
  /** Operating system, e.g. "Windows", "macOS", "Android", "iOS", "Linux". */
  os: string;
  /** Human summary, e.g. "Chrome on Windows". Refreshed on each sign-in. */
  label: string;
  /** The surface the most recent sign-in came through. */
  platform: DevicePlatform;
  /** Raw user-agent string at the last sign-in (kept for reference). */
  userAgent: string;
  /** Epoch ms — set once, when the device is first seen. */
  firstSeenAt: number;
  /** Epoch ms — refreshed on every sign-in. */
  lastSeenAt: number;
  /** How many sign-ins we've recorded from this device. */
  count: number;
}

/**
 * Best-effort parse of a user-agent string into browser + OS + a one-line label. Pure: the caller
 * passes the UA (from navigator.userAgent) so this stays testable and dependency-free. Order matters —
 * Edge's UA also contains "Chrome", Chrome's also contains "Safari", and Android's also says "Linux" —
 * so the more specific token is always checked first.
 */
export function parseUserAgent(ua: string): { browser: string; os: string; label: string } {
  const s = ua || '';

  let os = 'this device';
  if (/Windows/i.test(s)) os = 'Windows';
  else if (/Android/i.test(s)) os = 'Android';
  else if (/(iPhone|iPad|iPod)/i.test(s)) os = 'iOS';
  else if (/(Mac OS X|Macintosh)/i.test(s)) os = 'macOS';
  else if (/Linux/i.test(s)) os = 'Linux';

  let browser = 'Browser';
  if (/Edg\//i.test(s)) browser = 'Edge';
  else if (/(OPR\/|Opera)/i.test(s)) browser = 'Opera';
  else if (/Firefox\//i.test(s)) browser = 'Firefox';
  else if (/Chrome\//i.test(s)) browser = 'Chrome';
  else if (/Safari\//i.test(s)) browser = 'Safari';

  const label = os === 'this device' ? browser : `${browser} on ${os}`;
  return { browser, os, label };
}

/** A calendar date like "10 Sept 2026", for "first signed in" copy. */
export function absoluteDate(ts: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(ts);
  } catch {
    return new Date(ts).toDateString();
  }
}

/** A short relative time: "just now", "5 min ago", "3 hours ago", "2 days ago", else a date. */
export function relativeTime(ts: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < min) return 'just now';
  if (diff < hour) return `${Math.floor(diff / min)} min ago`;
  if (diff < day) {
    const n = Math.floor(diff / hour);
    return `${n} hour${n === 1 ? '' : 's'} ago`;
  }
  const days = Math.floor(diff / day);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return absoluteDate(ts);
}
