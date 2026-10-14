export interface ServerSentEvent { event?: string; data: string }

/** SSE framing is independent of network reads and UTF-8 code point boundaries. */
export async function* readSSE(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<ServerSentEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let buffer = ''
  let data: string[] = []
  let event: string | undefined
  let eventSize = 0
  let skipLF = false
  const abort = () => { void reader.cancel(signal?.reason).catch(() => {}) }
  signal?.addEventListener('abort', abort, { once: true })
  const line = (value: string): ServerSentEvent | undefined => {
    if (value === '') {
      const result = data.length ? { event, data: data.join('\n') } : undefined
      data = []; event = undefined; eventSize = 0
      return result
    }
    if (value.startsWith(':')) return
    const separator = value.indexOf(':')
    const field = separator === -1 ? value : value.slice(0, separator)
    const content = separator === -1 ? '' : value.slice(separator + 1).replace(/^ /, '')
    if (field === 'data') {
      eventSize += content.length
      if (eventSize > 8 * 1024 * 1024) throw new Error('Antigravity SSE event exceeds the size limit')
      data.push(content)
    } else if (field === 'event') event = content
    return undefined
  }
  try {
    signal?.throwIfAborted()
    while (true) {
      const chunk = await reader.read()
      signal?.throwIfAborted()
      buffer += decoder.decode(chunk.value, { stream: !chunk.done })
      let start = 0
      for (let i = 0; i < buffer.length; i++) {
        if (skipLF) { skipLF = false; if (buffer[i] === '\n') { start = i + 1; continue } }
        if (buffer[i] !== '\r' && buffer[i] !== '\n') continue
        const result = line(buffer.slice(start, i))
        skipLF = buffer[i] === '\r'
        start = i + 1
        if (result) yield result
      }
      buffer = buffer.slice(start)
      if (buffer.length > 8 * 1024 * 1024) throw new Error('Antigravity SSE line exceeds the size limit')
      if (chunk.done) break
    }
    // Accept a final fully formed data event even when the server omits its blank line.
    if (buffer) { const result = line(buffer); if (result) yield result }
    const final = line('')
    if (final) yield final
  } finally {
    signal?.removeEventListener('abort', abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
