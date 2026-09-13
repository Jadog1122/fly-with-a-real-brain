import type { Missing } from '../support'

export type BootState =
  | { kind: 'loading' }
  | { kind: 'unsupported'; missing: Missing[] }
  | { kind: 'error'; err: Error }
  | { kind: 'ready' }

/** Covers the world until the brain is live, and says what went wrong if it is not. */
export function BootOverlay({ state, onRetry }: { state: BootState; onRetry: () => void }) {
  if (state.kind === 'ready') return null

  return (
    <div className="pet-boot" role="status" aria-live="polite">
      <div className="rpg-ui-glass-panel pet-boot-card">
        {state.kind === 'loading' && (
          <>
            <div className="pet-boot-spin" aria-hidden="true" />
            <h2>Waking the fly up</h2>
            <p>Loading 45,808 neurons and wiring them together.</p>
          </>
        )}

        {state.kind === 'unsupported' && (
          <>
            <h2>This browser can&rsquo;t run it</h2>
            <p>The fly needs a few things this browser doesn&rsquo;t have:</p>
            <ul>
              {state.missing.map(m => (
                <li key={m.name}><b>{m.name}</b> — {m.why}</li>
              ))}
            </ul>
            <p className="pet-boot-hint">
              A current Chrome, Edge, Firefox or Safari 16.4+ will work.
            </p>
          </>
        )}

        {state.kind === 'error' && (
          <>
            <h2>The fly didn&rsquo;t wake up</h2>
            <p className="pet-boot-hint">{state.err.message || String(state.err)}</p>
            <button className="rpg-ui-btn" onClick={onRetry}>Try again</button>
          </>
        )}
      </div>
    </div>
  )
}
