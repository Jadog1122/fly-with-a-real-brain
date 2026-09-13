// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { BootOverlay } from '../src/pet/BootOverlay'
import { ErrorBoundary } from '../src/pet/ErrorBoundary'

afterEach(cleanup)

describe('BootOverlay', () => {
  it('covers the world while the brain is loading', () => {
    render(<BootOverlay state={{ kind: 'loading' }} onRetry={() => {}} />)
    expect(screen.getByRole('status')).toBeTruthy()
    expect(screen.getByText(/waking the fly up/i)).toBeTruthy()
  })

  it('gets out of the way once the fly is live', () => {
    const { container } = render(<BootOverlay state={{ kind: 'ready' }} onRetry={() => {}} />)
    expect(container.firstChild).toBeNull()
  })

  it('names every missing browser feature, and why it is needed', () => {
    render(<BootOverlay onRetry={() => {}} state={{
      kind: 'unsupported',
      missing: [
        { name: 'WebGL 2', why: 'the world is drawn on the GPU' },
        { name: 'BigInt64Array', why: 'ids are 18 digits' },
      ],
    }} />)
    expect(screen.getByText('WebGL 2')).toBeTruthy()
    expect(screen.getByText(/the world is drawn on the GPU/)).toBeTruthy()
    expect(screen.getByText('BigInt64Array')).toBeTruthy()
  })

  it('shows the real reason a boot failed, not a generic message', () => {
    render(<BootOverlay state={{ kind: 'error', err: new Error('data/pet.json: HTTP 404') }}
                        onRetry={() => {}} />)
    expect(screen.getByText('data/pet.json: HTTP 404')).toBeTruthy()
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy()
  })

  it('offers a retry that the caller controls', async () => {
    const onRetry = vi.fn()
    render(<BootOverlay state={{ kind: 'error', err: new Error('boom') }} onRetry={onRetry} />)
    screen.getByRole('button', { name: /try again/i }).click()
    expect(onRetry).toHaveBeenCalledOnce()
  })
})

describe('ErrorBoundary', () => {
  const Boom = () => { throw new Error('render exploded') }

  it('renders children when nothing throws', () => {
    render(<ErrorBoundary fallback={() => <p>fallback</p>}><p>alive</p></ErrorBoundary>)
    expect(screen.getByText('alive')).toBeTruthy()
  })

  it('shows the fallback instead of unmounting to a blank page', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <ErrorBoundary fallback={e => <p>caught: {e.message}</p>}>
        <Boom />
      </ErrorBoundary>,
    )
    expect(screen.getByText(/caught: render exploded/)).toBeTruthy()
    err.mockRestore()
  })
})
