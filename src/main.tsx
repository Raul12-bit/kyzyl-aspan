import '@fontsource-variable/onest';
import '@fontsource-variable/geist-mono';
import './app/theme';
import './styles/index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { ensureLocale, useLocaleStore } from './i18n';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

// Load the visitor's dictionary chunk before the first paint, so nobody sees an English flash.
void ensureLocale(useLocaleStore.getState().locale).finally(() => {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
