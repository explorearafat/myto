import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ChangelogPage } from './components/ChangelogPage';
import { armReveals } from './lib/reveal';
import './index.css';

armReveals();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ChangelogPage />
  </StrictMode>
);
