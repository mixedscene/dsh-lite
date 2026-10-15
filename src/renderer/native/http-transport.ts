import { registerPlugin, type PluginListenerHandle } from '@capacitor/core'

export interface HttpDataEvent {
  requestId: string
  base64?: string
  done?: boolean
  error?: string
}
export interface NativeHttpPlugin {
  request(options: {
    requestId: string
    url: string
    method: string
    headers: Record<string, string>
    bodyBase64?: string
  }): Promise<{ status: number; headers: Record<string, string> }>
  cancelRequest(options: { requestId: string }): Promise<void>
  addListener(event: 'httpData', listener: (event: HttpDataEvent) => void): Promise<PluginListenerHandle>
}

const nativeHttp = registerPlugin<NativeHttpPlugin>('HttpTransport')
const MAX_BODY_BYTES = 32 * 1024 * 1024

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error && signal.reason.name === 'AbortError'
    ? signal.reason
    : new DOMException('The operation was aborted.', 'AbortError')
}
function encodeBase64(bytes: Uint8Array): string {
  const parts: string[] = []
  // Multiples of three keep padding out of intermediate chunks.
  for (let offset = 0; offset < bytes.length; offset += 49152) {
    let binary = ''
    for (const byte of bytes.subarray(offset, offset + 49152)) binary += String.fromCharCode(byte)
    parts.push(btoa(binary))
  }
  return parts.join('')
}
function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
}

/** Android fetch bridge. Only explicitly supplied headers carry credentials. */
export async function nativeHttpRequest(
  url: string,
  method: string,
  headers: Headers,
  body?: RequestInit['body'],
  signal?: AbortSignal,
  plugin: NativeHttpPlugin = nativeHttp
): Promise<Response> {
  if (signal?.aborted) throw abortError(signal)
  method = method.toUpperCase()
  if (body != null && (method === 'GET' || method === 'HEAD')) throw new TypeError('GET and HEAD cannot have a request body.')
  const requestHeaders = new Headers(headers)
  let bodyBase64: string | undefined
  if (body != null) {
    const serialized = new Response(body)
    const bytes = new Uint8Array(await serialized.arrayBuffer())
    if (bytes.length > MAX_BODY_BYTES) throw new RangeError('Request body exceeds 32 MiB.')
    bodyBase64 = encodeBase64(bytes)
    const contentType = serialized.headers.get('content-type')
    if (contentType && !requestHeaders.has('content-type')) requestHeaders.set('content-type', contentType)
  }
  if (signal?.aborted) throw abortError(signal)
  const headerObject: Record<string, string> = {}
  requestHeaders.forEach((value, key) => { headerObject[key] = value })
  const requestId = crypto.randomUUID()

  return new Promise<Response>((resolve, reject) => {
    let listener: PluginListenerHandle | undefined
    let started = false
    let ended = false
    let failed = false
    let responded = false
    let receivedBytes = 0
    let nativeCancelled = false
    let controller: ReadableStreamDefaultController<Uint8Array>
    const removeListener = (handle: PluginListenerHandle) => {
      try { void Promise.resolve(handle.remove()).catch(() => {}) } catch { /* Cleanup must keep settling the request. */ }
    }
    const cleanup = () => {
      signal?.removeEventListener('abort', abort)
      if (listener) removeListener(listener)
      listener = undefined
    }
    const cancelNative = () => {
      if (!started || nativeCancelled) return
      nativeCancelled = true
      try { void plugin.cancelRequest({ requestId }).catch(() => {}) } catch { /* Caller cancellation has already settled. */ }
    }
    const fail = (error: unknown) => {
      if (failed) return
      if (ended) {
        if (!responded) { failed = true; reject(error); cancelNative() }
        return
      }
      failed = true
      ended = true
      controller.error(error)
      reject(error)
      cleanup()
      cancelNative()
    }
    const abort = () => fail(abortError(signal))
    const stream = new ReadableStream<Uint8Array>({
      start(value) { controller = value },
      cancel() {
        if (ended) return
        ended = true
        cleanup()
        cancelNative()
      },
    }, { highWaterMark: 0, size: (chunk) => chunk.byteLength })
    const onData = (event: HttpDataEvent) => {
      if (event.requestId !== requestId || ended || !started) return
      try {
        if (event.error) { fail(new Error(event.error)); return }
        if (event.base64) {
          const bytes = decodeBase64(event.base64)
          receivedBytes += bytes.length
          if (receivedBytes > MAX_BODY_BYTES) throw new RangeError('Response exceeds 32 MiB.')
          controller.enqueue(bytes)
        }
        if (event.done) {
          ended = true
          controller.close()
          cleanup()
        }
      } catch (error) { fail(error) }
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const start = async () => {
      if (ended) return
      const handle = await plugin.addListener('httpData', onData)
      if (ended) { removeListener(handle); return }
      listener = handle
      started = true
      const result = await plugin.request({ requestId, url, method, headers: headerObject, bodyBase64 })
      if (failed) return
      const noBody = method === 'HEAD' || [204, 205, 304].includes(result.status)
      const response = new Response(noBody ? null : stream, { status: result.status, headers: result.headers })
      if (noBody && !ended) {
        ended = true
        controller.close()
        cleanup()
      }
      responded = true
      resolve(response)
    }
    void start().catch(fail)
  })
}
