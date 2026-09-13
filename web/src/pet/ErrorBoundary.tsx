import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * Without this, a render error unmounts the tree and leaves a blank page with the
 * reason only in the console.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; fallback: (err: Error) => ReactNode },
  { err: Error | null }
> {
  state: { err: Error | null } = { err: null }

  static getDerivedStateFromError(err: Error) {
    return { err }
  }

  componentDidCatch(err: Error, info: ErrorInfo) {
    console.error('[pet] render failed', err, info.componentStack)
  }

  render() {
    return this.state.err ? this.props.fallback(this.state.err) : this.props.children
  }
}
