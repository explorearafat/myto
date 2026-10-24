import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CommunityPage } from './components/CommunityPage';
import { armReveals } from './lib/reveal';
import './index.css';

armReveals();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CommunityPage />
  </StrictMode>
);
