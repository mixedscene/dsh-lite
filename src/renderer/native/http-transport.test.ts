import { beforeEach, describe, expect, test, vi } from 'vitest'
import { nativeHttpRequest, type HttpDataEvent, type NativeHttpPlugin } from './http-transport'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function base64(value: string): string { return btoa(String.fromCharCode(...new TextEncoder().encode(value))) }

function harness() {
  const callbacks: Array<(event: HttpDataEvent) => void> = []
  const removes: ReturnType<typeof vi.fn>[] = []
  const plugin = {
    request: vi.fn<NativeHttpPlugin['request']>(),
    cancelRequest: vi.fn<NativeHttpPlugin['cancelRequest']>().mockResolvedValue(),
    addListener: vi.fn<NativeHttpPlugin['addListener']>().mockImplementation(async (_event, callback) => {
      callbacks.push(callback)
      const remove = vi.fn(async () => {})
      removes.push(remove)
      return { remove }
    }),
  }
  const emit = (index: number, event: Omit<HttpDataEvent, 'requestId'>) => {
    const requestId = plugin.request.mock.calls[index][0].requestId
    for (const callback of callbacks) callback({ requestId, ...event })
  }
  const start = (signal?: AbortSignal, body: RequestInit['body'] = '{"stream":true}') =>
    nativeHttpRequest('https://relay.example/v1/responses', 'POST', new Headers({ Authorization: 'Bearer relay-key', 'Content-Type': 'application/json' }), body, signal, plugin)
  return { plugin, removes, emit, start, callbacks }
}

describe('Android HTTP bridge', () => {
  let h: ReturnType<typeof harness>
  beforeEach(() => {
    h = harness()
    h.plugin.request.mockResolvedValue({ status: 200, headers: { 'content-type': 'text/event-stream' } })
  })

  test('returns actual headers before streaming unchanged Chat Completions / Responses bytes', async () => {
    const response = await h.start()
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    const reader = response.body!.getReader()
    const frames = 'event: response.output_text.delta\ndata: {"delta":"你好😀"}\n\ndata: [DONE]\n\n'
    const bytes = new TextEncoder().encode(frames)
    // Deliberately divide a multi-byte Unicode character between native chunks.
    const split = bytes.indexOf(0xe4) + 1
    h.emit(0, { base64: btoa(String.fromCharCode(...bytes.subarray(0, split))) })
    expect((await reader.read()).value).toEqual(bytes.subarray(0, split))
    h.emit(0, { base64: btoa(String.fromCharCode(...bytes.subarray(split))) })
    h.emit(0, { done: true })
    expect((await reader.read()).value).toEqual(bytes.subarray(split))
    expect((await reader.read()).done).toBe(true)
    expect(h.removes[0]).toHaveBeenCalledOnce()
    expect(h.plugin.cancelRequest).not.toHaveBeenCalled()
  })

  test.each([401, 403, 429, 500, 503])('preserves HTTP %i, Retry-After and JSON error body', async (status) => {
    h.plugin.request.mockResolvedValue({ status, headers: { 'content-type': 'application/json', 'retry-after': '7', 'x-request-id': 'relay-1' } })
    const response = await h.start()
    h.emit(0, { base64: base64('{"error":{"message":"quota exceeded"}}'), done: true })
    expect(response.status).toBe(status)
    expect(response.ok).toBe(false)
    expect(response.headers.get('retry-after')).toBe('7')
    expect(response.headers.get('x-request-id')).toBe('relay-1')
    expect(await response.json()).toEqual({ error: { message: 'quota exceeded' } })
    expect(h.plugin.request).toHaveBeenCalledOnce()
  })

  test('does not parse or rewrite raw non-streaming text and request credentials', async () => {
    const response = await h.start(undefined, 'not JSON')
    const options = h.plugin.request.mock.calls[0][0]
    expect(atob(options.bodyBase64!)).toBe('not JSON')
    expect(options.headers).toEqual({ authorization: 'Bearer relay-key', 'content-type': 'application/json' })
    expect(Object.keys(options).sort()).toEqual(['bodyBase64', 'headers', 'method', 'requestId', 'url'])
    h.emit(0, { base64: base64('plain body'), done: true })
    expect(await response.text()).toBe('plain body')
  })

  test('preserves early data and completion received before the header promise returns', async () => {
    const headers = deferred<{ status: number; headers: Record<string, string> }>()
    h.plugin.request.mockReturnValue(headers.promise)
    const pending = h.start()
    await vi.waitFor(() => expect(h.plugin.request).toHaveBeenCalledOnce())
    h.emit(0, { base64: base64('early'), done: true })
    headers.resolve({ status: 200, headers: {} })
    expect(await (await pending).text()).toBe('early')
    expect(h.removes[0]).toHaveBeenCalledOnce()
  })

  test('settles even if invalid response metadata arrives after native completion', async () => {
    const headers = deferred<{ status: number; headers: Record<string, string> }>()
    h.plugin.request.mockReturnValue(headers.promise)
    const pending = h.start()
    const rejection = expect(pending).rejects.toThrow()
    await vi.waitFor(() => expect(h.plugin.request).toHaveBeenCalledOnce())
    h.emit(0, { done: true })
    headers.resolve({ status: 0, headers: {} })
    await rejection
  })

  test('isolates simultaneous streams by IDs chosen before native start', async () => {
    const [first, second] = await Promise.all([h.start(), h.start()])
    expect(h.plugin.request.mock.calls[0][0].requestId).not.toBe(h.plugin.request.mock.calls[1][0].requestId)
    h.emit(1, { base64: base64('second'), done: true })
    h.emit(0, { base64: base64('first'), done: true })
    expect(await first.text()).toBe('first')
    expect(await second.text()).toBe('second')
  })

  test('rejects pre-aborted requests without invoking native code', async () => {
    const abort = new AbortController()
    abort.abort('stop')
    await expect(h.start(abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(h.plugin.addListener).not.toHaveBeenCalled()
    expect(h.plugin.request).not.toHaveBeenCalled()
  })

  test('aborts immediately while listener registration is pending, and removes a late handle', async () => {
    const handle = deferred<{ remove: () => Promise<void> }>()
    const remove = vi.fn(async () => {})
    h.plugin.addListener.mockReturnValue(handle.promise)
    const abort = new AbortController()
    const pending = h.start(abort.signal)
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(h.plugin.addListener).toHaveBeenCalledOnce())
    abort.abort('stop')
    await rejection
    handle.resolve({ remove })
    await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce())
    expect(h.plugin.request).not.toHaveBeenCalled()
    expect(h.plugin.cancelRequest).not.toHaveBeenCalled()
  })

  test('aborts before headers without waiting for the native request promise', async () => {
    const headers = deferred<{ status: number; headers: Record<string, string> }>()
    h.plugin.request.mockReturnValue(headers.promise)
    const abort = new AbortController()
    const pending = h.start(abort.signal)
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(h.plugin.request).toHaveBeenCalledOnce())
    abort.abort(123)
    await rejection
    expect(h.plugin.cancelRequest).toHaveBeenCalledExactlyOnceWith({ requestId: h.plugin.request.mock.calls[0][0].requestId })
    headers.reject(new Error('late native cancellation'))
    expect(h.removes[0]).toHaveBeenCalledOnce()
  })

  test('abort errors a locked reader and cancels native exactly once', async () => {
    const abort = new AbortController()
    const response = await h.start(abort.signal)
    const reader = response.body!.getReader()
    const reading = expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' })
    abort.abort()
    h.emit(0, { done: true })
    await reading
    expect(h.plugin.cancelRequest).toHaveBeenCalledOnce()
    expect(h.removes[0]).toHaveBeenCalledOnce()
  })

  test('reader cancellation cancels the native connection and detaches abort handling', async () => {
    const abort = new AbortController()
    const response = await h.start(abort.signal)
    await response.body!.getReader().cancel()
    abort.abort()
    expect(h.plugin.cancelRequest).toHaveBeenCalledOnce()
    expect(h.removes[0]).toHaveBeenCalledOnce()
  })

  test('surfaces failures after headers through body consumption', async () => {
    const response = await h.start()
    const text = expect(response.text()).rejects.toThrow('connection lost')
    h.emit(0, { error: 'connection lost' })
    await text
    expect(h.plugin.cancelRequest).toHaveBeenCalledOnce()
    expect(h.removes[0]).toHaveBeenCalledOnce()
  })

  test('does not fall back or repeat a failed native request', async () => {
    h.plugin.request.mockRejectedValue(new Error('connection failed'))
    await expect(h.start()).rejects.toThrow('connection failed')
    expect(h.plugin.request).toHaveBeenCalledOnce()
    expect(h.removes[0]).toHaveBeenCalledOnce()
  })

  test.each([204, 205, 304])('supports bodyless status %i', async (status) => {
    h.plugin.request.mockResolvedValue({ status, headers: { 'x-test': 'empty' } })
    const response = await h.start()
    expect(response.status).toBe(status)
    expect(response.body).toBeNull()
    expect(await response.text()).toBe('')
    h.emit(0, { done: true })
    expect(h.removes[0]).toHaveBeenCalledOnce()
  })

  test('supports HEAD metadata without constructing an illegal body', async () => {
    const response = await nativeHttpRequest('https://relay.example/models', 'HEAD', new Headers(), undefined, undefined, h.plugin)
    expect(response.body).toBeNull()
    expect(h.plugin.request.mock.calls[0][0].method).toBe('HEAD')
    expect(h.plugin.request.mock.calls[0][0].bodyBase64).toBeUndefined()
    h.emit(0, { done: true })
  })

  test('serializes multipart bodies with their generated boundary', async () => {
    const data = new FormData()
    data.append('file', new Blob(['example']), 'example.txt')
    const response = await nativeHttpRequest('https://relay.example/upload', 'POST', new Headers(), data, undefined, h.plugin)
    const options = h.plugin.request.mock.calls[0][0]
    expect(options.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/)
    expect(atob(options.bodyBase64!)).toContain('example.txt')
    h.emit(0, { done: true })
    await response.text()
  })
})
