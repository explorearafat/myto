// Auth + profile state for /chat, shared through React context. Wrap the page in <AuthProvider> and
// read it with useAuth(). It tracks the Firebase user, loads/saves the users/{uid} profile document
// in Firestore, and exposes the sign-in / sign-out / save actions the gate needs.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type AuthProvider as FirebaseAuthProvider,
  type User,
} from 'firebase/auth';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { auth, db, githubProvider, googleProvider } from './firebase';
import type { ProfileDraft, UserProfile } from '../shared/profile';
import { BYOK_DOC, normalizeByokConfig, type ByokConfig } from '../shared/byok';

interface AuthContextValue {
  /** null until the first auth state resolves, then the signed-in user or null. */
  user: User | null;
  /** The signed-in user's Firestore profile, or null if they haven't onboarded yet. */
  profile: UserProfile | null;
  /** The signed-in user's bring-your-own-key chat config, or null if none saved yet. */
  byok: ByokConfig | null;
  /** True until the first onAuthStateChanged fires. */
  loading: boolean;
  /** True while a signed-in user's profile document is being fetched. */
  profileLoading: boolean;
  /** A short, human-readable sign-in error, cleared on the next attempt. */
  error: string | null;
  signInWithGoogle: () => Promise<void>;
  signInWithGithub: () => Promise<void>;
  signOutUser: () => Promise<void>;
  saveProfile: (draft: ProfileDraft) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function firstName(full: string | null | undefined): string {
  return (full || '').trim().split(/\s+/)[0] || '';
}

/** Turn a Firebase sign-in error into a short, friendly line ('' = silent, e.g. user closed popup). */
function describeAuthError(err: unknown): string {
  const code = (err as { code?: string })?.code || '';
  switch (code) {
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return '';
    case 'auth/operation-not-allowed':
      return 'That sign-in method isn’t enabled yet — turn it on in the Firebase console.';
    case 'auth/account-exists-with-different-credential':
      return 'This email is already linked to a different sign-in method. Use that one.';
    case 'auth/unauthorized-domain':
      return 'This site isn’t an authorized domain in Firebase yet.';
    case 'auth/popup-blocked':
      return 'Your browser blocked the sign-in popup. Allow popups and try again.';
    case 'auth/network-request-failed':
      return 'Network error during sign-in. Check your connection and try again.';
    default:
      return 'Sign-in failed. Please try again.';
  }
}

/**
 * Reject a hung Firestore call instead of letting the UI spin forever. Reads and writes can stall for
 * minutes when the Cloud Firestore database is unreachable — e.g. it hasn't been created in the
 * project yet, or the client is offline — because the SDK keeps retrying rather than failing fast
 * (a queued write only resolves once the server acknowledges it). This bounds that wait so the gate
 * can fall back to onboarding, and "Start chatting" can surface an error, instead of hanging.
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [byok, setByok] = useState<ByokConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track the signed-in user and load their profile + BYOK config documents.
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      setLoading(false);
      if (!u) {
        setProfile(null);
        setByok(null);
        return;
      }
      setProfileLoading(true);
      // Read the profile and the BYOK config together; neither should block the other.
      const [profileSnap, byokSnap] = await Promise.all([
        withTimeout(getDoc(doc(db, 'users', u.uid)), 12000, 'Profile read').catch((e) => {
          // Offline, rules not deployed, or Firestore not created yet — treat as "no profile" so
          // onboarding shows its form instead of the splash hanging for minutes.
          console.warn('[sylor] profile read failed — showing onboarding:', e);
          return null;
        }),
        withTimeout(
          getDoc(doc(db, 'users', u.uid, BYOK_DOC.col, BYOK_DOC.id)),
          12000,
          'Config read',
        ).catch((e) => {
          console.warn('[sylor] BYOK config read failed:', e);
          return null;
        }),
      ]);
      setProfile(profileSnap && profileSnap.exists() ? (profileSnap.data() as UserProfile) : null);
      setByok(byokSnap && byokSnap.exists() ? normalizeByokConfig(byokSnap.data()) : null);
      setProfileLoading(false);
    });
    return unsub;
  }, []);

  const runSignIn = useCallback(async (provider: FirebaseAuthProvider) => {
    setError(null);
    try {
      await signInWithPopup(auth, provider);
    } catch (err) {
      const msg = describeAuthError(err);
      if (msg) setError(msg);
    }
  }, []);

  const signInWithGoogle = useCallback(() => runSignIn(googleProvider), [runSignIn]);
  const signInWithGithub = useCallback(() => runSignIn(githubProvider), [runSignIn]);

  const signOutUser = useCallback(async () => {
    await signOut(auth);
    setProfile(null);
    setByok(null);
  }, []);

  const saveProfile = useCallback(
    async (draft: ProfileDraft) => {
      const u = auth.currentUser;
      if (!u) throw new Error('Not signed in');
      const now = Date.now();
      const next: UserProfile = {
        uid: u.uid,
        name: draft.name.trim() || u.displayName || '',
        nickname: draft.nickname.trim() || firstName(draft.name || u.displayName) || 'there',
        role: draft.role.trim(),
        company: draft.company.trim(),
        about: draft.about.trim(),
        email: u.email || '',
        photoURL: u.photoURL || '',
        createdAt: profile?.createdAt || now,
        updatedAt: now,
      };
      await withTimeout(
        setDoc(doc(db, 'users', u.uid), next, { merge: true }),
        15000,
        'Profile save',
      );
      setProfile(next);
    },
    [profile?.createdAt],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      profile,
      byok,
      loading,
      profileLoading,
      error,
      signInWithGoogle,
      signInWithGithub,
      signOutUser,
      saveProfile,
    }),
    [
      user,
      profile,
      byok,
      loading,
      profileLoading,
      error,
      signInWithGoogle,
      signInWithGithub,
      signOutUser,
      saveProfile,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}
