import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ModelsPage } from './components/ModelsPage';
import { armReveals } from './lib/reveal';
import './index.css';

armReveals();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ModelsPage />
  </StrictMode>
);
