import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from '../pet/ErrorBoundary'

// not StrictMode: its dev double-mount would open two sockets and take two seats
createRoot(document.getElementById('root')!).render(
  <ErrorBoundary
    fallback={err => (
      <div className="pet-boot">
        <div className="rpg-ui-glass-panel pet-boot-card">
          <h2>Something broke</h2>
          <p className="pet-boot-hint">{err.message}</p>
          <button className="rpg-ui-btn" onClick={() => location.reload()}>Reload</button>
        </div>
      </div>
    )}
  >
    <App />
  </ErrorBoundary>,
)
