import { normalizeErrorForSentry, type SentryErrorPriority } from '@shared/utils/sentry_policy'

export interface ReportErrorContext {
  domain: string
  extras?: Record<string, unknown>
  handled?: boolean
  operation: string
  priority?: SentryErrorPriority
  tags?: Record<string, string | number | boolean>
}

/** Keeps unexpected renderer failures in local logs without external reporting. */
export function reportError(error: unknown, context: ReportErrorContext): void {
  console.error(`[${context.domain}] ${context.operation}`, normalizeErrorForSentry(error))
}
