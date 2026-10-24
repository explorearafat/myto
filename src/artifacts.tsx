import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthProvider } from './lib/auth';
import { ArtifactsPage } from './components/ArtifactsPage';
import { armReveals } from './lib/reveal';
import './index.css';

armReveals();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <ArtifactsPage />
    </AuthProvider>
  </StrictMode>
);
