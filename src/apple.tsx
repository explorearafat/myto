import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DeviceListPage } from './components/DeviceListPage';
import './index.css';

// /apple — the Apple devices on the signed-in account. Groups macOS + iOS into one Apple family,
// mounting the shared DeviceListPage. Auth + Firestore talk happens inside the component.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DeviceListPage group="Apple" title="Apple devices" />
  </StrictMode>,
);
