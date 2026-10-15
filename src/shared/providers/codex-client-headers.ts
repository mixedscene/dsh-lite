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
 */
export const CODEX_CLIENT_HEADERS: Record<string, string> = {
  originator: 'codex_cli_rs',
  'x-codex-window-id': '11111111-2222-3333-4444-555555555555',
  session_id: '11111111-2222-3333-4444-555555555555',
  'OpenAI-Beta': 'responses=experimental',
  Version: '0.154.0',
}
