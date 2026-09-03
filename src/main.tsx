import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { armReveals } from './lib/reveal';
import './index.css';

// Before the first paint, so revealed sections never flash in and back out.
armReveals();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
