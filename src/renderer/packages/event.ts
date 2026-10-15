import { featureFlags } from '@/utils/feature-flags'
import type { AnalyticsEventParams } from '@shared/analytics'
import platform from '@/platform'
import { settingsStore } from '@/stores/settingsStore'

export function trackingEvent(name: string, params: AnalyticsEventParams = {}) {
  const allowReportingAndTracking = settingsStore.getState().allowReportingAndTracking
  if (!featureFlags.chatboxAI || !allowReportingAndTracking) {
    return
  }
  platform.trackingEvent(name, params)
}
