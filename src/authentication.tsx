import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthBroker } from './components/AuthBroker';
import './index.css';

// The /authentication broker page: a native app opens this in the system browser to
// sign in with Google, and we relay the token back to it. No providers needed — the
// broker talks to Firebase directly and holds no long-lived state.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthBroker />
  </StrictMode>,
);
