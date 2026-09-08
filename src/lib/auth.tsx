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

interface AuthContextValue {
  /** null until the first auth state resolves, then the signed-in user or null. */
  user: User | null;
  /** The signed-in user's Firestore profile, or null if they haven't onboarded yet. */
  profile: UserProfile | null;
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track the signed-in user and load their profile document.
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      setLoading(false);
      if (!u) {
        setProfile(null);
        return;
      }
      setProfileLoading(true);
      try {
        const snap = await getDoc(doc(db, 'users', u.uid));
        setProfile(snap.exists() ? (snap.data() as UserProfile) : null);
      } catch {
        // Offline, or rules not deployed yet — treat as "no profile" so onboarding can retry.
        setProfile(null);
      } finally {
        setProfileLoading(false);
      }
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
      await setDoc(doc(db, 'users', u.uid), next, { merge: true });
      setProfile(next);
    },
    [profile?.createdAt],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      profile,
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
