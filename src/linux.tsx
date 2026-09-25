import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DeviceListPage } from './components/DeviceListPage';
import './index.css';

// /linux — the Linux devices on the signed-in account. Mounts the shared DeviceListPage
// filtered to the Linux OS family. Auth + Firestore talk happens inside the component.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DeviceListPage group="Linux" title="Linux devices" />
  </StrictMode>,
);
