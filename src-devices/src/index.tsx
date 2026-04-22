// Dev entry point — ONLY used by `vite` dev server (npm run start). The production bundle is
// produced via Module Federation from Components.tsx; `index.html` + this file are ignored there.
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

const container = document.getElementById('root');
if (container) {
    createRoot(container).render(
        <React.StrictMode>
            <App />
        </React.StrictMode>,
    );
}
