import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/theme.css'
import './index.css'
import App from './App.tsx'
import { consumeAuthCallback } from './auth'

// Persist any token delivered via the iOS redirect-mode sign-in flow
// (/auth/callback#token=…) before <App/> reads getToken() to derive its
// initial auth state. Synchronous + one-shot.
consumeAuthCallback()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
