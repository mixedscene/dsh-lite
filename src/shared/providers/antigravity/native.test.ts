import { describe, expect, it } from 'vitest'
import { createNativeAntigravityTransport, type AntigravityHttpChunk, type AntigravityNativePlugin } from './native'

function mockPlugin() {
  let listener: ((event: AntigravityHttpChunk) => void) | undefined
  let removed = 0
  const cancelled: string[] = []
  const calls: Parameters<AntigravityNativePlugin['request']>[0][] = []
  const plugin = {
    async addListener(_name: string, callback: (event: AntigravityHttpChunk) => void) { listener = callback; return { async remove() { removed++ } } },
    async cancelRequest({ requestId }: { requestId: string }) { cancelled.push(requestId) },
    async request(options: Parameters<AntigravityNativePlugin['request']>[0]) { calls.push(options); return { requestId: options.requestId, status: 200, headers: { 'Content-Type': 'text/event-stream' } } },
  } as AntigravityNativePlugin
  return { plugin, calls, cancelled, emit(event: AntigravityHttpChunk) { listener?.(event) }, removed: () => removed }
}
const request = { accountId: 'A', url: 'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse', body: '{}', stream: true }

describe('native token-free transport', () => {
  it('registers before request and buffers chunks arriving before response headers', async () => {
    const mock = mockPlugin()
    mock.plugin.request = async (options) => {
      mock.calls.push(options)
      mock.emit({ requestId: 'unrelated', accountId: 'A', chunk: 'wrong request', done: true })
      mock.emit({ requestId: options.requestId, accountId: 'B', chunk: 'wrong account', done: true })
      mock.emit({ requestId: options.requestId, accountId: 'A', chunk: '青竹🌿' })
      mock.emit({ requestId: options.requestId, accountId: 'A', chunk: 'data', done: true })
      return { requestId: options.requestId, status: 200, headers: { 'Content-Type': 'text/event-stream' } }
    }
    const response = await createNativeAntigravityTransport(mock.plugin).request(request)
    expect(await response.text()).toBe('青竹🌿data')
    expect(mock.removed()).toBe(1)
    expect(mock.calls[0]).toMatchObject({ accountId: 'A', method: 'POST', stream: true })
    expect(JSON.stringify(mock.calls)).not.toMatch(/access_token|refresh_token|Authorization/)
  })
  it('cancels the exact native request on abort after headers', async () => {
    const mock = mockPlugin()
    const controller = new AbortController()
    const response = await createNativeAntigravityTransport(mock.plugin).request({ ...request, signal: controller.signal })
    const pending = response.body!.getReader().read()
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(mock.cancelled).toEqual([mock.calls[0].requestId])
    expect(mock.removed()).toBe(1)
  })
  it('cancels native request when the stream consumer exits early', async () => {
    const mock = mockPlugin()
    const response = await createNativeAntigravityTransport(mock.plugin).request(request)
    await response.body!.cancel()
    expect(mock.cancelled).toEqual([mock.calls[0].requestId])
    expect(mock.removed()).toBe(1)
  })
  it('returns HTTP failure headers and cleans listeners', async () => {
    const mock = mockPlugin()
    mock.plugin.request = async (options) => { mock.calls.push(options); return { requestId: options.requestId, status: 429, headers: { 'Retry-After': '30' }, body: 'rate limited' } }
    const response = await createNativeAntigravityTransport(mock.plugin).request(request)
    expect(response.status).toBe(429)
    expect(response.headers.get('Retry-After')).toBe('30')
    expect(await response.text()).toBe('rate limited')
    expect(mock.removed()).toBe(1)
    expect(mock.cancelled).toEqual([mock.calls[0].requestId])
  })
  it('propagates native streaming errors and removes listeners', async () => {
    const mock = mockPlugin()
    const response = await createNativeAntigravityTransport(mock.plugin).request(request)
    const pending = response.body!.getReader().read()
    mock.emit({ requestId: mock.calls[0].requestId, accountId: 'A', error: 'Transport failed' })
    await expect(pending).rejects.toThrow('Transport failed')
    expect(mock.removed()).toBe(1)
  })
})
