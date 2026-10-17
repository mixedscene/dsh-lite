import * as Sentry from '@sentry/react'

// External telemetry stays disabled regardless of persisted reporting preferences.
export function initSentry(): Promise<boolean> {
  return Promise.resolve(false)
}

export default Sentry
