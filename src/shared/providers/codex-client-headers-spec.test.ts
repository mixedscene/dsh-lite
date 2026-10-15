import { describe, expect, it } from 'vitest'
import {
  CODEX_CLIENT_HEADERS,
  CODEX_CLIENT_USER_AGENT,
  DEFAULT_CLIENT_HEADERS_TEXT,
  parseClientHeaders,
  resolveClientHeaders,
} from './codex-client-headers'

describe('codex client headers', () => {
  it('sends the Codex CLI fingerprint by default, without any toggle', () => {
    expect(resolveClientHeaders(undefined)).toBe(CODEX_CLIENT_HEADERS)
    expect(resolveClientHeaders('')).toBe(CODEX_CLIENT_HEADERS)
    expect(resolveClientHeaders('   ')).toBe(CODEX_CLIENT_HEADERS)
  })

  it('mirrors the official CLI fingerprint, including the user agent', () => {
    // The gateway rejects the AI SDK default user agent; only a client/version
    // token passes, so `user-agent` has to be part of the fingerprint.
    expect(CODEX_CLIENT_HEADERS['user-agent']).toBe(CODEX_CLIENT_USER_AGENT)
    expect(CODEX_CLIENT_USER_AGENT).toBe('codex_cli_rs/0.154.0')
    expect(CODEX_CLIENT_HEADERS.originator).toBe('codex_cli_rs')
    expect(CODEX_CLIENT_HEADERS.Version).toBe('0.154.0')
    expect(CODEX_CLIENT_HEADERS['OpenAI-Beta']).toBe('responses=experimental')
  })

  it('can be switched off with the sentinel', () => {
    expect(resolveClientHeaders('-')).toBeUndefined()
    expect(resolveClientHeaders('  none ')).toBeUndefined()
  })

  it('parses a per-line override', () => {
    expect(parseClientHeaders('user-agent: MyClient/1.2.3\nx-extra: 1')).toEqual({
      'user-agent': 'MyClient/1.2.3',
      'x-extra': '1',
    })
  })

  it('keeps the value intact when it contains a colon', () => {
    expect(parseClientHeaders('authorization: Bearer abc:def')).toEqual({ authorization: 'Bearer abc:def' })
  })

  it('ignores comments, blank lines and unusable names', () => {
    expect(parseClientHeaders('# a note\n\nbad name: x\nok: y\nempty:\n: nope')).toEqual({ ok: 'y' })
  })

  it('accepts a JSON object override and drops non-string values', () => {
    expect(parseClientHeaders('{"a":"1","b":2,"c":" "}')).toEqual({ a: '1' })
  })

  it('falls back to the fingerprint when the override is unusable', () => {
    expect(resolveClientHeaders('not a header line')).toBe(CODEX_CLIENT_HEADERS)
    expect(resolveClientHeaders('{oops')).toBe(CODEX_CLIENT_HEADERS)
  })

  it('uses the override when it parses', () => {
    expect(resolveClientHeaders('originator: other-client')).toEqual({ originator: 'other-client' })
  })

  it('renders the built-in fingerprint as an editable text block', () => {
    expect(DEFAULT_CLIENT_HEADERS_TEXT.split('\n')[0]).toBe('user-agent: codex_cli_rs/0.154.0')
    expect(parseClientHeaders(DEFAULT_CLIENT_HEADERS_TEXT)).toEqual(CODEX_CLIENT_HEADERS)
  })
})
