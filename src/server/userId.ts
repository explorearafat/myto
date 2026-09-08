// Stable per-visitor identity for the token quota. We prefer an HttpOnly cookie; when a client
// sends no cookie we bill that request to a hashed IP so cookie-refusers can't reset their bucket
// simply by dropping the cookie. A cookie is still issued, so a normal browser gets its own
// per-browser bucket from its second message onward.

const COOKIE = 'sylor_uid';
const ONE_YEAR = 60 * 60 * 24 * 365;

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(header);
  return m ? decodeURIComponent(m[1]) : null;
}

// Non-cryptographic (djb2) — this is only a bucket key, never a token, and we prefer not to
// store raw IPs. Collisions merely share a quota bucket, which is acceptable for a free tier.
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export interface Identity {
  /** The quota bucket key for this request. */
  uid: string;
  /** A Set-Cookie value to attach to the response, when a new cookie should be issued. */
  setCookie?: string;
}

export function resolveIdentity(req: Request): Identity {
  const existing = readCookie(req.headers.get('cookie'), COOKIE);
  if (existing) return { uid: existing };

  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'anon';
  const uid = `ip-${hash(ip)}`;
  const fresh = crypto.randomUUID();
  const setCookie = `${COOKIE}=${fresh}; Path=/; Max-Age=${ONE_YEAR}; HttpOnly; SameSite=Lax`;
  return { uid, setCookie };
}
