// Firebase client for the desktop app's Google sign-in. This is the SAME *public*
// Firebase Web config the marketing site ships — safe to embed in the bundle (it is
// not a secret; access is gated by enabled providers, authorized domains, and
// Firestore rules). The app never runs Google's popup itself (Google blocks it inside
// webviews); it completes sign-in with a Google ID token relayed from the system
// browser via signInWithCredential (a plain REST call, no popup).

import { initializeApp } from 'firebase/app'
import {
  browserLocalPersistence,
  getAuth,
  indexedDBLocalPersistence,
  setPersistence
} from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'

const firebaseConfig = {
  apiKey: 'AIzaSyCLUPgeIy_gp9M5hkjHxbj1ohMoGQ4HpRQ',
  authDomain: 'sylor-29cab.firebaseapp.com',
  projectId: 'sylor-29cab',
  storageBucket: 'sylor-29cab.firebasestorage.app',
  messagingSenderId: '148077878463',
  appId: '1:148077878463:web:e197d280d4a5967085fa0a',
  measurementId: 'G-9PT834YQYL'
}

export const app = initializeApp(firebaseConfig)
export const auth = getAuth(app)
export const db = getFirestore(app)

// Persist the session so the desktop app signs in once, not on every relaunch. IndexedDB is the
// most durable in the Electron renderer; fall back to localStorage if it's unavailable.
void setPersistence(auth, indexedDBLocalPersistence).catch(() =>
  setPersistence(auth, browserLocalPersistence).catch(() => {})
)
