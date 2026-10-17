import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getSettingsState } = vi.hoisted(() => ({ getSettingsState: vi.fn() }))

vi.mock('@/stores/settingsStore', () => ({ settingsStore: { getState: getSettingsState } }))

import { trackEvent } from './track'

describe('permanently disabled trackEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each([false, true])('does not send events with reporting consent %s', (allowReportingAndTracking) => {
    const plausible = vi.fn()
    getSettingsState.mockReturnValue({ allowReportingAndTracking })
    vi.stubGlobal('window', {
      location: { href: 'https://example.test/#/session/private-session-id' },
      plausible,
    })

    trackEvent('generate', { provider: 'openai' })
    trackEvent('generate')

    expect(plausible).not.toHaveBeenCalled()
    expect(getSettingsState).not.toHaveBeenCalled()
  })

  it('is safe without a browser window', () => {
    vi.stubGlobal('window', undefined)

    expect(() => trackEvent('generate')).not.toThrow()
  })
})
