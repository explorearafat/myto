import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { FeaturesPage } from './components/FeaturesPage';
import { armReveals } from './lib/reveal';
import './index.css';

armReveals();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <FeaturesPage />
  </StrictMode>
);
