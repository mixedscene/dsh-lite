// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { initSettingsStore, getState, subscribe, initJkAnalytics, trackJkViewEvent, sentryInit } = vi.hoisted(() => ({
  initSettingsStore: vi.fn(),
  getState: vi.fn(),
  subscribe: vi.fn(),
  initJkAnalytics: vi.fn(),
  trackJkViewEvent: vi.fn(),
  sentryInit: vi.fn(),
}))

vi.mock('@/analytics/jk', () => ({ initJkAnalytics, trackJkViewEvent }))
vi.mock('@sentry/react', () => ({ init: sentryInit }))
vi.mock('@/stores/settingsStore', () => ({
  initSettingsStore,
  settingsStore: { getState, subscribe },
}))

import { initGoogleAnalyticsTracking } from './ga_init'
import { initJkTracking } from './jk_analytics_init'
import { initPlausibleTracking } from './plausible_init'
import { initSentry } from './sentry_init'

describe('permanently disabled telemetry initialization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.plausible = undefined
  })

  it.each([false, true])('ignores persisted reporting consent (%s)', async (allowReportingAndTracking) => {
    initSettingsStore.mockResolvedValue({ allowReportingAndTracking })
    getState.mockReturnValue({ allowReportingAndTracking })
    const plausible = vi.fn()
    const navigationSubscriber = vi.fn()
    window.plausible = plausible

    await initGoogleAnalyticsTracking()
    await initJkTracking()
    await initPlausibleTracking(navigationSubscriber)
    expect(await initSentry()).toBe(false)

    expect(initSettingsStore).not.toHaveBeenCalled()
    expect(getState).not.toHaveBeenCalled()
    expect(subscribe).not.toHaveBeenCalled()
    expect(navigationSubscriber).not.toHaveBeenCalled()
    expect(plausible).not.toHaveBeenCalled()
    expect(initJkAnalytics).not.toHaveBeenCalled()
    expect(trackJkViewEvent).not.toHaveBeenCalled()
    expect(sentryInit).not.toHaveBeenCalled()
  })
})
