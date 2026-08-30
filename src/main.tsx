import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from '@/app/App';
import { registerServiceWorker } from '@/app/registerServiceWorker';

import '@/styles/global.css';

const rootElement = document.getElementById('root');

// Non-null assertions are banned, so the missing-element case is handled for
// real. `getElementById` returns `HTMLElement | null` and this narrows it.
if (!rootElement) {
  throw new Error('Patchbay could not start: no #root element in index.html');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// After render, not before: the first paint is not waiting on this.
registerServiceWorker();
