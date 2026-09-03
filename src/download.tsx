import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DownloadPage } from './components/DownloadPage';
import { armReveals } from './lib/reveal';
import './index.css';

// Same as the product page: arm before the first paint so nothing flashes in and back out.
armReveals();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DownloadPage />
  </StrictMode>,
);
