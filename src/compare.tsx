import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ComparePage } from './components/ComparePage';
import { armReveals } from './lib/reveal';
import './index.css';

armReveals();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ComparePage />
  </StrictMode>
);
