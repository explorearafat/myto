import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthProvider } from './lib/auth';
import { DiscoverFeed } from './components/DiscoverFeed';
import { armReveals } from './lib/reveal';
import './index.css';

armReveals();

// Discover is readable by everyone; signing in (same Google/GitHub identity as /chat)
// unlocks posting, reacting, commenting, following and saving.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <DiscoverFeed />
    </AuthProvider>
  </StrictMode>
);
