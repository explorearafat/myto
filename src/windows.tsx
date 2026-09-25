import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DeviceListPage } from './components/DeviceListPage';
import './index.css';

// /windows — the Windows devices on the signed-in account. Mounts the shared DeviceListPage
// filtered to the Windows OS family. Auth + Firestore talk happens inside the component.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DeviceListPage group="Windows" title="Windows devices" />
  </StrictMode>,
);
