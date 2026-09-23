// Browser + Firestore glue for the device sign-in history shown on /authentication. The pure stored
// shape and the user-agent parser live in ../shared/device; everything here touches a browser global
// (localStorage, crypto, navigator) or Firestore, so it is deliberately kept out of that shared module.

import { collection, doc, getDoc, getDocs, setDoc } from 'firebase/firestore';
import { db } from './firebase';
import { parseUserAgent, type DevicePlatform, type DeviceSession } from '../shared/device';

const DEVICE_ID_KEY = 'sylor.device.id';

// When localStorage is unavailable (private mode, storage disabled) we fall back to one id per page
// load so a device still records rather than throwing.
let memoryDeviceId: string | null = null;

function randomId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through to the Math.random id */
  }
  return `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** A stable id for this browser, persisted in localStorage; created on first call. */
export function getDeviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_ID_KEY);
    if (existing) return existing;
    const id = randomId();
    localStorage.setItem(DEVICE_ID_KEY, id);
    return id;
  } catch {
    if (!memoryDeviceId) memoryDeviceId = randomId();
    return memoryDeviceId;
  }
}

/**
 * Reject a hung Firestore call instead of letting the page wait forever — the SDK keeps retrying when
 * the database is unreachable or hasn't been created yet. Mirrors the helper in ./auth.tsx; kept local
 * so this lib doesn't import a React-context module for one utility.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Record that this browser just signed in, at users/{uid}/devices/{deviceId}. Upserts: the first time
 * it creates the row (setting firstSeenAt); afterwards it refreshes the label/platform and bumps the
 * sign-in count. Best-effort — any failure (rules not published yet, offline, no database) is swallowed
 * and logged so it can never block the sign-in or the token handoff. Returns true when the write lands.
 */
export async function recordDeviceSignIn(uid: string, platform: DevicePlatform): Promise<boolean> {
  try {
    const deviceId = getDeviceId();
    const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    const { browser, os, label } = parseUserAgent(userAgent);
    const ref = doc(db, 'users', uid, 'devices', deviceId);
    const now = Date.now();
    const snap = await withTimeout(getDoc(ref), 6000, 'Device read');
    if (!snap.exists()) {
      const fresh: DeviceSession = {
        deviceId,
        browser,
        os,
        label,
        platform,
        userAgent,
        firstSeenAt: now,
        lastSeenAt: now,
        count: 1,
      };
      await withTimeout(setDoc(ref, fresh), 6000, 'Device create');
    } else {
      const prev = snap.data() as Partial<DeviceSession>;
      await withTimeout(
        setDoc(
          ref,
          { browser, os, label, platform, userAgent, lastSeenAt: now, count: (prev.count ?? 0) + 1 },
          { merge: true },
        ),
        6000,
        'Device update',
      );
    }
    return true;
  } catch (e) {
    console.warn('[myto] device sign-in not recorded:', e);
    return false;
  }
}

/** Every device that has signed in for this user, most-recently-active first. [] on any failure. */
export async function listDevices(uid: string): Promise<DeviceSession[]> {
  try {
    const snap = await withTimeout(
      getDocs(collection(db, 'users', uid, 'devices')),
      6000,
      'Devices read',
    );
    const rows = snap.docs.map((d) => d.data() as DeviceSession);
    rows.sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));
    return rows;
  } catch (e) {
    console.warn('[myto] devices list failed:', e);
    return [];
  }
}
