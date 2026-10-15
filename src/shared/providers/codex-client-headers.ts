/**
 * Codex-only relay gateways (for example a sub2api instance running with
 * `codex_cli_only`) answer streaming requests without the official Codex CLI
 * fingerprint with
 *   403 {"error":{"message":"This account only allows Codex official clients"}}
 * even when the API key itself is valid. Sending the same headers a Codex CLI
 * request carries makes the gateway route the request to its Codex upstream.
 *
 * Verified against the gateway: with these headers every advertised model answers
 * 200 on both `/chat/completions` and `/responses`, streaming and non-streaming.
 * Each header alone (only `originator`, or only a `x-codex-*` header) is not enough,
 * so the whole set is sent together.
 *
 * `user-agent` is part of the fingerprint: the gateway rejects a request whose
 * User-Agent does not start with a `client/version` token. Measured with the same
 * request/body while varying only the User-Agent:
 *   - `ai-sdk/openai/3.0.88 ai-sdk/provider-utils/4.0.40 runtime/browser` -> 403
 *   - `codex_cli_rs/0.154.0` (and that value followed by the AI SDK suffix) -> 200
 *   - missing User-Agent -> 403, `MyProbe/1.0` -> 403, `curl/8.12.0-DEV` -> 200
 * The AI SDK appends its own `ai-sdk/...` suffix to whatever we set, so the final
 * header reads `codex_cli_rs/0.154.0 ai-sdk/...` and is still accepted.
 */

/** Official Codex CLI version whose fingerprint we mirror. */
export const CODEX_CLIENT_VERSION = '0.154.0'

/** User-Agent the official Codex CLI sends. */
export const CODEX_CLIENT_USER_AGENT = `codex_cli_rs/${CODEX_CLIENT_VERSION}`

/**
 * Headers a Codex CLI request carries. Custom OpenAI / OpenAI-compatible providers
 * send this set by default, so a Codex-only gateway works without any toggle.
 */
export const CODEX_CLIENT_HEADERS: Record<string, string> = {
  'user-agent': CODEX_CLIENT_USER_AGENT,
  originator: 'codex_cli_rs',
  'x-codex-window-id': '11111111-2222-3333-4444-555555555555',
  session_id: '11111111-2222-3333-4444-555555555555',
  'OpenAI-Beta': 'responses=experimental',
  Version: CODEX_CLIENT_VERSION,
}

/** The default header set rendered as the editable `key: value` text. */
export const DEFAULT_CLIENT_HEADERS_TEXT = Object.entries(CODEX_CLIENT_HEADERS)
  .map(([key, value]) => `${key}: ${value}`)
  .join('\n')

/** Sentinel for "send no extra headers at all". */
export const DISABLE_CLIENT_HEADERS = '-'

/** RFC 9110 field-name characters; anything else is refused before reaching the native relay. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/**
 * Parse an override written as `key: value` lines (a JSON object is also accepted).
 * Blank lines and `#` comments are ignored; unusable entries are dropped.
 */
export function parseClientHeaders(text: string | undefined): Record<string, string> | undefined {
  const source = text?.trim()
  if (!source) return undefined

  const parsed: Record<string, string> = {}
  if (source.startsWith('{')) {
    try {
      const value: unknown = JSON.parse(source)
      if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
      for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
        const name = key.trim()
        if (HEADER_NAME.test(name) && typeof raw === 'string' && raw.trim()) parsed[name] = raw.trim()
      }
    } catch {
      return undefined
    }
  } else {
    for (const line of source.split(/\r?\n/)) {
      const entry = line.trim()
      if (!entry || entry.startsWith('#')) continue
      const separator = entry.indexOf(':')
      if (separator <= 0) continue
      const name = entry.slice(0, separator).trim()
      const value = entry.slice(separator + 1).trim()
      if (HEADER_NAME.test(name) && value) parsed[name] = value
    }
  }

  return Object.keys(parsed).length > 0 ? parsed : undefined
}

/**
 * Headers to attach to a custom provider request.
 *
 * - unset/blank       -> the built-in Codex CLI fingerprint (no switch needed)
 * - `-` (or `none`)   -> no extra headers at all
 * - anything parseable-> that list
 * - unparseable input -> the built-in fingerprint, so a typo cannot silently break
 *                        a gateway that requires the fingerprint
 */
export function resolveClientHeaders(override: string | undefined): Record<string, string> | undefined {
  const source = override?.trim()
  if (!source) return CODEX_CLIENT_HEADERS
  if (source === DISABLE_CLIENT_HEADERS || source.toLowerCase() === 'none') return undefined
  return parseClientHeaders(source) ?? CODEX_CLIENT_HEADERS
}
