import { Capacitor } from '@capacitor/core'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { nativeHttpRequest } from '@/native/http-transport'
import { createNativeReadableStream } from '@/native/stream-http'
import { handleMobileRequest } from './mobile-request'

vi.mock('@/native/http-transport', () => ({ nativeHttpRequest: vi.fn() }))
vi.mock('@capacitor/core', () => ({ Capacitor: { getPlatform: vi.fn(() => 'ios') }, CapacitorHttp: { request: vi.fn() } }))

vi.mock('@/native/stream-http', () => ({
  createNativeReadableStream: vi.fn(),
}))

describe('mobile request native streaming', () => {
  beforeEach(() => {
    vi.mocked(Capacitor.getPlatform).mockReturnValue('ios')
    vi.mocked(createNativeReadableStream).mockReset()
    vi.mocked(createNativeReadableStream).mockReturnValue(new ReadableStream<Uint8Array>())
  })

  test('passes the request signal directly to the native stream', async () => {
    const abortController = new AbortController()

    await handleMobileRequest(
      'https://example.com/stream',
      'POST',
      new Headers({ Authorization: 'Bearer test' }),
      JSON.stringify({ stream: true }),
      abortController.signal
    )

    expect(createNativeReadableStream).toHaveBeenCalledWith(
      {
        url: 'https://example.com/stream',
        method: 'POST',
        headers: {
          Accept: 'text/event-stream',
          authorization: 'Bearer test',
        },
        body: JSON.stringify({ stream: true }),
      },
      { signal: abortController.signal }
    )
  })

  test('passes an already-aborted signal to native stream setup', async () => {
    const abortController = new AbortController()
    abortController.abort(123_456)

    await handleMobileRequest(
      'https://example.com/stream',
      'POST',
      new Headers(),
      JSON.stringify({ stream: true }),
      abortController.signal
    )

    expect(createNativeReadableStream).toHaveBeenCalledWith(expect.any(Object), {
      signal: abortController.signal,
    })
  })

  test('passes an explicit undefined signal to native stream setup', async () => {
    await handleMobileRequest('https://example.com/stream', 'POST', new Headers(), JSON.stringify({ stream: true }))

    expect(createNativeReadableStream).toHaveBeenCalledWith(expect.any(Object), { signal: undefined })
  })
})

describe('Android original renderer requests', () => {
  beforeEach(() => {
    vi.mocked(Capacitor.getPlatform).mockReturnValue('android')
    vi.mocked(nativeHttpRequest).mockReset()
    vi.mocked(createNativeReadableStream).mockClear()
  })

  test.each([
    ['/v1/chat/completions', JSON.stringify({ stream: true, messages: [] })],
    ['/v1/responses', JSON.stringify({ stream: true, input: 'hello' })],
    ['/v1/models', undefined],
    ['/upload', new Blob(['attachment'])],
  ])('uses generic Android HTTP for %s with original key and body', async (path, body) => {
    const response = new Response('upstream', { status: 429, headers: { 'retry-after': '7' } })
    vi.mocked(nativeHttpRequest).mockResolvedValue(response)
    const headers = new Headers({ Authorization: 'Bearer relay-test-only' })
    const signal = new AbortController().signal
    const method = body === undefined ? 'GET' : 'POST'

    const result = await handleMobileRequest(`http://127.0.0.1:8080${path}`, method, headers, body, signal)

    expect(result).toBe(response)
    expect(result.status).toBe(429)
    expect(result.headers.get('retry-after')).toBe('7')
    expect(nativeHttpRequest).toHaveBeenCalledWith(`http://127.0.0.1:8080${path}`, method, headers, body, signal)
    expect(createNativeReadableStream).not.toHaveBeenCalled()
  })
})
