import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthProvider } from './lib/auth';
import { SignInGate } from './components/SignInGate';
import { armReveals } from './lib/reveal';
import './index.css';

// Same as the other pages: arm before the first paint so the hero doesn't flash in and out.
armReveals();

// Sign-in is required for /chat, so the gate wraps the whole page: it shows the sign-in screen and
// the one-time profile form, then hands off to <ChatPage /> once the visitor is signed in with a
// profile.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <SignInGate />
    </AuthProvider>
  </StrictMode>,
);
