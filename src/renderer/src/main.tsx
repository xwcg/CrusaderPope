import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { installTestApi } from './testApi';
import { applyScriptFacts } from '../../shared/scriptFacts';
import './styles/app.css';
import './styles/controls.css';
import './styles/read.css';
import './styles/images.css';

installTestApi();

// the script database's facts for the picker's tables (docs/script-database.md); none: the hand-written tables stay
void window.api.scriptDbFacts().then((f) => f && applyScriptFacts(f)).catch(() =>
{});
window.api.onScriptDbFacts(applyScriptFacts);

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <ErrorBoundary>
            <App />
        </ErrorBoundary>
    </StrictMode>
);
