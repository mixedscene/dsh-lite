import type { Plausible } from '@/analytics/plausible'

declare global {
  interface Window {
    plausible?: Plausible
  }
}

// Preserve the event API without collecting or sending any telemetry.
export function trackEvent(_event: string, _props: Record<string, unknown> = {}): void {}
