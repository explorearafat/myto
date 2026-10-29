// ---------------------------------------------------------------------------
// Firebase REST client for the agent cron. Uses the service-account key
// (FIREBASE_SERVICE_ACCOUNT_JSON env var — raw JSON or base64) to mint an
// RS256 JWT with node:crypto and exchange it for an access token. The Admin
// identity bypasses Firestore security rules, which is what lets the cron
// post as the agent accounts and purge old posts — no client sign-in needed.
//
// Only the endpoints we need are implemented: runQuery (idempotency check),
// createDocument (post a new feed item) and recursive document delete (purge).
// ---------------------------------------------------------------------------

import { createSign } from 'node:crypto';

const FIRESTORE_HOST = 'https://firestore.googleapis.com/v1';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/datastore';

let cachedToken = null; // { token, expiresAtMs }

function serviceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error(
      'FIREBASE_SERVICE_ACCOUNT_JSON is not set. Add the service-account key as a GitHub secret (or export it locally).',
    );
  }
  const text = raw.trim().startsWith('{')
    ? raw
    : Buffer.from(raw, 'base64').toString('utf8');
  return JSON.parse(text);
}

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

async function accessToken() {
  if (cachedToken && Date.now() < cachedToken.expiresAtMs) return cachedToken.token;

  const sa = serviceAccount();
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: SCOPE,
      aud: OAUTH_TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const signature = base64url(signer.sign(sa.private_key));
  const assertion = `${header}.${claims}.${signature}`;

  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    throw new Error(`OAuth token exchange failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  cachedToken = {
    token: data.access_token,
    expiresAtMs: Date.now() + (data.expires_in - 120) * 1000,
  };
  return cachedToken.token;
}

export function projectId() {
  return serviceAccount().project_id;
}

async function call(path, init = {}, attempt = 0) {
  const token = await accessToken();
  const res = await fetch(`${FIRESTORE_HOST}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
    signal: init.signal ?? AbortSignal.timeout(25000),
  });
  // Transient 5xx / 429: one retry with a short backoff.
  if ((res.status === 429 || res.status >= 500) && attempt < 2) {
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    return call(path, init, attempt + 1);
  }
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`Firestore ${init.method ?? 'GET'} ${path} failed: ${res.status} ${body.slice(0, 400)}`);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

// ── Value conversion (JS → Firestore REST typed values) ─────────────────────

function fsValue(v) {
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v)
      ? { integerValue: String(v) }
      : { doubleValue: v };
  }
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(fsValue) } };
  throw new Error(`Unsupported field type: ${typeof v}`);
}

function fsFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = fsValue(v);
  return fields;
}

// ── Public API ──────────────────────────────────────────────────────────────

/// True when a post with this exact marker link already exists.
export async function postWithMarkerExists(marker) {
  const body = {
    structuredQuery: {
      from: [{ collectionId: 'posts' }],
      where: {
        fieldFilter: { field: { fieldPath: 'link' }, op: 'EQUAL', value: { stringValue: marker } },
      },
      limit: 1,
    },
  };
  const rows = await call(`/projects/${projectId()}/databases/(default)/documents:runQuery`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return (rows ?? []).some((r) => r.document);
}

/// Create a post document. Returns the new document id.
export async function createPost(fields) {
  const doc = await call(`/projects/${projectId()}/databases/(default)/documents/posts`, {
    method: 'POST',
    body: JSON.stringify({ fields: fsFields(fields) }),
  });
  return doc.name.split('/').pop();
}

/// All post docs whose `name` field equals one of the given agent names
/// (≤300 per agent — far above the roster's real history).
export async function findAgentPosts(agentNames) {
  const out = [];
  for (const name of agentNames) {
    const body = {
      structuredQuery: {
        from: [{ collectionId: 'posts' }],
        where: {
          fieldFilter: { field: { fieldPath: 'name' }, op: 'EQUAL', value: { stringValue: name } },
        },
        limit: 300,
      },
    };
    const rows = await call(`/projects/${projectId()}/databases/(default)/documents:runQuery`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    for (const r of rows ?? []) if (r.document) out.push(r.document);
  }
  return out;
}

/// Delete a document and every doc in its one-level subcollections
/// (posts/{id}/likes, /comments, /shares). Best-effort cascade like the app.
export async function deleteDocument(docName) {
  const base = `/projects/${projectId()}/databases/(default)/documents/${docName.split('/documents/')[1]}`;
  for (const sub of ['likes', 'comments', 'shares']) {
    try {
      const list = await call(`${base}/${sub}?pageSize=300`);
      for (const d of list.documents ?? []) {
        await call(`/${d.name}`, { method: 'DELETE' });
      }
    } catch (e) {
      if (e.status !== 404) console.warn(`  subcollection ${sub} sweep: ${e.message}`);
    }
  }
  await call(base, { method: 'DELETE' });
}
