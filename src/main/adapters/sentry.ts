import type { SentryAdapter, SentryScope } from '../../shared/utils/sentry_adapter'
import { normalizeErrorForSentry } from '../../shared/utils/sentry_policy'

/** Preserves the error adapter API while keeping failures in local logs. */
export class MainSentryAdapter implements SentryAdapter {
  captureException(error: unknown): void {
    console.error(normalizeErrorForSentry(error))
  }

  withScope(callback: (scope: SentryScope) => void): void {
    callback({
      setTag(_key: string, _value: string): void {},
      setExtra(_key: string, _value: unknown): void {},
    })
  }
}

export const sentry = new MainSentryAdapter()

// There is no external telemetry queue to flush.
export function flushSentry(_timeout: number): Promise<boolean> {
  return Promise.resolve(true)
}
