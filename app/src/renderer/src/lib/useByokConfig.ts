import { useEffect, useState } from 'react'
import { doc, onSnapshot } from 'firebase/firestore'
import { db } from './firebase'
import { useAuthUser } from './useAuthUser'
import { BYOK_DOC, normalizeByokConfig, type ByokConfig } from '@shared/byok'

/**
 * Live subscription to the signed-in account's BYOK chat config
 * (users/{uid}/config/byok) — the SAME document the website writes. This is the
 * single source of truth for the base URL / key / auth scheme / model list; the
 * local settings JSON is just a cache of it (see useAppStore.applyByokConfig).
 *
 * Signed-out (uid null) yields `config: null`. A Firestore read failure (offline,
 * rules) also leaves `config` null and simply stops loading — the last cache in
 * sylor-settings.json still drives the provider, so chat degrades gracefully.
 *
 * Isolated in its own module (like useAuthUser) so callers depend on a small,
 * mockable seam rather than importing the Firestore SDK directly.
 */
export function useByokConfig(): { config: ByokConfig | null; loading: boolean } {
  const user = useAuthUser()
  const uid = user?.uid ?? null
  const [config, setConfig] = useState<ByokConfig | null>(null)
  const [loading, setLoading] = useState<boolean>(!!uid)

  useEffect(() => {
    if (!uid) {
      setConfig(null)
      setLoading(false)
      return
    }
    setLoading(true)
    const ref = doc(db, 'users', uid, BYOK_DOC.col, BYOK_DOC.id)
    return onSnapshot(
      ref,
      (snap) => {
        setConfig(snap.exists() ? normalizeByokConfig(snap.data()) : null)
        setLoading(false)
      },
      () => {
        // Read failed (offline / rules): keep the last cache in settings.json.
        setLoading(false)
      }
    )
  }, [uid])

  return { config, loading }
}
