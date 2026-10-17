export type PlausibleNavigationSubscriber = (onResolved: (hrefChanged: boolean) => void) => void

// Retained for callers; no navigation listeners or external analytics are registered.
export function initPlausibleTracking(_subscribeToNavigation?: PlausibleNavigationSubscriber): Promise<void> {
  return Promise.resolve()
}
