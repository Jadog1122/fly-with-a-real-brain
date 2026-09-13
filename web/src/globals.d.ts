// Ambient declarations for the handful of places that reach outside typed APIs.

interface Window {
  /** Dev-only debug handle; guarded by import.meta.env.DEV. */
  __fly?: unknown
  /** Dev-only debug handle; guarded by import.meta.env.DEV. */
  __pet?: unknown
  /** Safari before 14.1 only exposes the prefixed constructor. */
  webkitAudioContext?: typeof AudioContext
}
