// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { initSettingsStore, getState, subscribe, initTracking, onWindowFocused, trackingEvent } = vi.hoisted(() => ({
  initSettingsStore: vi.fn(),
  getState: vi.fn(),
  subscribe: vi.fn(),
  initTracking: vi.fn(),
  onWindowFocused: vi.fn(),
  trackingEvent: vi.fn(),
}))

vi.mock('@/platform', () => ({ default: { initTracking, onWindowFocused, trackingEvent } }))
vi.mock('@/stores/settingsStore', () => ({
  initSettingsStore,
  settingsStore: { getState, subscribe },
}))

import { initGoogleAnalyticsTracking } from './ga_init'

describe('permanently disabled Google Analytics', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([false, true])('does not initialize or emit events with reporting consent %s', async (allowReportingAndTracking) => {
    initSettingsStore.mockResolvedValue({ allowReportingAndTracking })
    getState.mockReturnValue({ allowReportingAndTracking })

    await initGoogleAnalyticsTracking()
    await initGoogleAnalyticsTracking()
    await vi.advanceTimersByTimeAsync(31 * 60 * 1_000)

    expect(initSettingsStore).not.toHaveBeenCalled()
    expect(getState).not.toHaveBeenCalled()
    expect(subscribe).not.toHaveBeenCalled()
    expect(initTracking).not.toHaveBeenCalled()
    expect(onWindowFocused).not.toHaveBeenCalled()
    expect(trackingEvent).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
