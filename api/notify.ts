// api/notify.ts — the push relay. A signed-in client calls it right after an
// action worth a system-tray notification (DM sent, like, comment, share,
// follow). It verifies the caller, looks up the recipient's FCM tokens
// (users/{toUid}/config/fcmTokens) with the project's service account, and
// sends the push through Firebase Cloud Messaging HTTP v1.
//
// Trust posture: the caller proves who they are with their Firebase ID token
// (verified against Google's identitytoolkit); payload sizes are capped; the
// service account lives only in the Vercel env (FIREBASE_SERVICE_ACCOUNT_JSON)
// and is never exposed. Spark-plan safe: FCM and this function are free.

import { createSign } from 'node:crypto';

export const config = { runtime: 'nodejs' };

const PROJECT_ID = 'sylor-29cab';
const WEB_API_KEY = 'AIzaSyCLUPgeIy_gp9M5hkjHxbj1ohMoGQ4HpRQ';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

interface NotifyBody {
  idToken?: unknown;
  toUid?: unknown;
  kind?: unknown;
  title?: unknown;
  body?: unknown;
  data?: unknown;
}

const KINDS = new Set(['dm', 'like', 'comment', 'share', 'follow']);
let cachedSaToken: { token: string; expiresAt: number } | null = null;

function serviceAccount(): { client_email: string; private_key: string } {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not set');
  return JSON.parse(raw);
}

/** Mint (or reuse) an access token for FCM from the service account. */
async function saAccessToken(): Promise<string> {
  if (cachedSaToken && Date.now() < cachedSaToken.expiresAt) return cachedSaToken.token;
  const sa = serviceAccount();
  const now = Math.floor(Date.now() / 1000);
  const b64 = (obj: unknown): string =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');
  const head = b64({ alg: 'RS256', typ: 'JWT' });
  const claims = b64({
    iss: sa.client_email,
    scope: FCM_SCOPE,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  });
  const signer = createSign('RSA-SHA256');
  signer.update(`${head}.${claims}`);
  const assertion = `${head}.${claims}.${base64url(signer.sign(sa.private_key))}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedSaToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 120) * 1000,
  };
  return cachedSaToken.token;
}

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** Verify a Firebase ID token via Google's identitytoolkit (public web key). */
async function verifyIdToken(idToken: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${WEB_API_KEY}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idToken }),
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { users?: Array<{ localId?: string }> };
    return data.users?.[0]?.localId ?? null;
  } catch {
    return null;
  }
}

/** The recipient's FCM tokens, read with admin access (bypasses rules). */
async function recipientTokens(toUid: string): Promise<string[]> {
  try {
    const token = await saAccessToken();
    const res = await fetch(
      `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/users/${toUid}/config/fcmTokens`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as {
      fields?: { tokens?: { mapValue?: { fields?: Record<string, unknown> } } };
    };
    const map = data.fields?.tokens?.mapValue?.fields ?? {};
    return Object.keys(map).slice(0, 5);
  } catch {
    return [];
  }
}

/** Send one FCM v1 push; returns false when the token is dead (unregistered). */
async function sendFcm(token: string, title: string, body: string, data: Record<string, string>): Promise<boolean> {
  const saToken = await saAccessToken();
  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${saToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          token,
          notification: { title: title.slice(0, 120), body: body.slice(0, 240) },
          data,
          android: {
            priority: 'HIGH',
            notification: { channel_id: 'messages', notification_priority: 'PRIORITY_HIGH' },
          },
        },
      }),
    },
  );
  if (res.ok) return true;
  const text = await res.text();
  return !text.includes('UNREGISTERED') && !text.includes('INVALID_ARGUMENT');
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return json(405, { error: 'method_not_allowed' });
  }
  let payload: NotifyBody;
  try {
    payload = (await req.json()) as NotifyBody;
  } catch {
    return json(400, { error: 'bad_json' });
  }

  const idToken = typeof payload.idToken === 'string' ? payload.idToken : '';
  const toUid = typeof payload.toUid === 'string' ? payload.toUid.trim() : '';
  const kind = typeof payload.kind === 'string' ? payload.kind : '';
  const title = typeof payload.title === 'string' ? payload.title.trim() : '';
  const body = typeof payload.body === 'string' ? payload.body.trim() : '';
  const data: Record<string, string> = {};
  if (payload.data && typeof payload.data === 'object') {
    for (const [k, v] of Object.entries(payload.data as Record<string, unknown>).slice(0, 5)) {
      if (typeof v === 'string') data[k] = v.slice(0, 200);
    }
  }

  if (!idToken || !toUid || !KINDS.has(kind) || !title) {
    return json(400, { error: 'bad_request' });
  }

  // Who is calling? A valid Firebase session is required — anonymous abuse
  // gets nothing.
  const fromUid = await verifyIdToken(idToken);
  if (!fromUid) return json(401, { error: 'unauthorized' });
  if (fromUid === toUid) return json(200, { sent: 0 }); // never push to yourself

  const tokens = await recipientTokens(toUid);
  if (tokens.length === 0) return json(200, { sent: 0 });

  let sent = 0;
  const dead: string[] = [];
  for (const token of tokens) {
    try {
      const ok = await sendFcm(token, title, body, { kind, ...data });
      if (ok) sent++;
      else dead.push(token);
    } catch {
      dead.push(token);
    }
  }

  // Prune tokens FCM rejected as unregistered (stale devices).
  if (dead.length > 0) {
    try {
      const saToken = await saAccessToken();
      const encoded = encodeURIComponent(
        `projects/${PROJECT_ID}/databases/(default)/documents/users/${toUid}/config/fcmTokens`,
      );
      for (const deadToken of dead) {
        await fetch(
          `https://firestore.googleapis.com/v1/${encoded}?mask.fieldPaths=tokens.${deadToken}`,
          { method: 'PATCH', headers: { authorization: `Bearer ${saToken}`, 'content-type': 'application/json' }, body: '{}' },
        ).catch(() => undefined);
      }
    } catch {
      // Pruning is best-effort.
    }
  }

  return json(200, { sent });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
