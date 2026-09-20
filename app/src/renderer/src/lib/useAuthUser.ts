import { useEffect, useState } from 'react'
import { onAuthStateChanged, type User } from 'firebase/auth'
import { auth } from './firebase'

/**
 * The currently signed-in Firebase user, or `null`. AuthGate holds the canonical
 * user and only mounts the app (this rail included) once sign-in has resolved, so
 * `auth.currentUser` is already populated on the first render here — the seed
 * avoids a one-frame flash of the signed-out fallback. We still subscribe so a
 * late `displayName`/`photoURL` backfill (or a sign-out) repaints the footer.
 *
 * Isolated in its own module so the rail depends on a small, mockable seam rather
 * than importing Firebase directly (tests stub this hook instead of the SDK).
 */
export function useAuthUser(): User | null {
  const [user, setUser] = useState<User | null>(() => auth.currentUser)
  useEffect(() => onAuthStateChanged(auth, setUser), [])
  return user
}
