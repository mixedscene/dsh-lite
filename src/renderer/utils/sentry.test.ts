import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { reportError } from './sentry'

const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }))

vi.mock('@sentry/react', () => ({ captureException }))

describe('local reportError', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('keeps classified errors in local logs without external reporting', () => {
    const error = new Error('boom')

    reportError(error, {
      domain: 'session',
      extras: { retryCount: 2 },
      handled: false,
      operation: 'generation',
      priority: 'high',
      tags: { provider: 'openai' },
    })

    expect(console.error).toHaveBeenCalledWith('[session] generation', error)
    expect(captureException).not.toHaveBeenCalled()
  })

  test('normalizes non-Error values in local logs', () => {
    reportError('failed', { domain: 'application', operation: 'startup' })

    expect(console.error).toHaveBeenCalledWith(
      '[application] startup',
      expect.objectContaining({ name: 'NonErrorException', message: 'Non-Error exception (string)' })
    )
    expect(captureException).not.toHaveBeenCalled()
  })

  test('does not log fields from provider error objects', () => {
    reportError(
      {
        type: 'server_error',
        code: 'server_shutdown',
        message: 'private provider response',
        apiKey: 'sk-private-secret',
      },
      { domain: 'ai-generation', operation: 'send_message' }
    )

    expect(console.error).toHaveBeenCalledWith(
      '[ai-generation] send_message',
      expect.objectContaining({ message: 'Non-Error exception (object; type=server_error; code=server_shutdown)' })
    )
    expect(captureException).not.toHaveBeenCalled()
  })
})
