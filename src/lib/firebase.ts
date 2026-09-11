// Firebase client for the marketing site's /chat sign-in and per-user profiles.
//
// The config below is the *public* Firebase Web config. It is safe to ship in the browser bundle
// and to commit to source — it is NOT a secret. Access is enforced elsewhere: by which providers we
// enable in Firebase Authentication (Google + GitHub), by the list of Authorized Domains, and by the
// Firestore security rules (see firestore.rules) — never by hiding these values. The secret,
// server-only service-account key is a different thing and is deliberately not used here (v1 writes
// Firestore straight from the client).

import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, GithubAuthProvider, GoogleAuthProvider } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

// authDomain is our own origin, not sylor-29cab.firebaseapp.com. The mobile app opens the
// /authentication broker inside a Chrome Custom Tab and signs in with signInWithRedirect; the
// browser then blocks the cross-origin storage the Firebase auth iframe needs when authDomain is a
// different origin, so getRedirectResult comes back empty and sign-in loops. Serving auth from our
// own origin fixes that — vercel.json transparently proxies /__/auth/* to
// sylor-29cab.firebaseapp.com (Firebase's "reverse proxy" recipe), so no auth files are self-hosted.
// Requires https://sylorcode.vercel.app/__/auth/handler in the Google OAuth client's authorized
// redirect URIs, and sylorcode.vercel.app in Firebase Auth → Authorized domains.
const firebaseConfig = {
  apiKey: 'AIzaSyCLUPgeIy_gp9M5hkjHxbj1ohMoGQ4HpRQ',
  authDomain: 'sylorcode.vercel.app',
  projectId: 'sylor-29cab',
  storageBucket: 'sylor-29cab.firebasestorage.app',
  messagingSenderId: '148077878463',
  appId: '1:148077878463:web:e197d280d4a5967085fa0a',
  measurementId: 'G-9PT834YQYL',
};

export const app: FirebaseApp = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// Always show the account chooser so switching Google accounts is easy.
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

// Ask for the primary email so we can show it on the account chip.
export const githubProvider = new GithubAuthProvider();
githubProvider.addScope('read:user');
