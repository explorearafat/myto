import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { UseCasesPage } from './components/UseCasesPage';
import { armReveals } from './lib/reveal';
import './index.css';

armReveals();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <UseCasesPage />
  </StrictMode>
);
