import { registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import type { AntigravityTransport } from './types'

export interface AntigravityAccount {
  id: string; email: string; name: string; picture?: string; project?: string; modelCache?: unknown; updatedAt: number; reauthRequired: boolean
}
export interface AntigravityHttpChunk { requestId: string; accountId: string; chunk?: string; done?: boolean; error?: string }
export interface AntigravityNativePlugin {
  listAccounts(): Promise<{ accounts: AntigravityAccount[]; activeAccountId?: string; oauthConfigured: boolean; storageError?: string; oauthPending?: boolean; oauthError?: string }>
  addAccount(options?: { timeoutMs?: number }): Promise<{ account: AntigravityAccount; activeAccountId: string }>
  switchAccount(options: { accountId: string }): Promise<{ account: AntigravityAccount }>
  removeAccount(options: { accountId: string }): Promise<void>
  updateAccountCache(options: { accountId: string; project?: string; modelCache?: unknown }): Promise<void>
  importSkill(): Promise<{ name: string; content: string }>
  cancelOAuth(): Promise<void>
  request(options: { requestId: string; accountId: string; url: string; method?: 'POST'; headers?: Record<string, string>; body?: string; stream?: boolean }): Promise<{ requestId: string; status: number; headers: Record<string, string>; body?: string }>
  cancelRequest(options: { requestId: string }): Promise<void>
  addListener(eventName: 'httpChunk', listener: (event: AntigravityHttpChunk) => void): Promise<PluginListenerHandle>
  addListener(eventName: 'accountsChanged', listener: (event: { activeAccountId?: string; oauthPending?: boolean; oauthError?: string }) => void): Promise<PluginListenerHandle>
}
export const antigravityNative = registerPlugin<AntigravityNativePlugin>('Antigravity')

export type AntigravityNativeHttpPlugin = Pick<AntigravityNativePlugin, 'request' | 'cancelRequest'> & {
  addListener(eventName: 'httpChunk', listener: (event: AntigravityHttpChunk) => void): Promise<PluginListenerHandle>
}

/** Credentials remain native. Register before request: chunks may precede headers. */
export function createNativeAntigravityTransport(plugin: AntigravityNativeHttpPlugin = antigravityNative): AntigravityTransport {
  return { async request(options) {
    options.signal?.throwIfAborted()
    const requestId = crypto.randomUUID()
    let handle: PluginListenerHandle | undefined
    let stopped = false
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const encoder = new TextEncoder()
    const cancel = () => { void plugin.cancelRequest({ requestId }).catch(() => {}) }
    const cleanup = () => { options.signal?.removeEventListener('abort', abort); void handle?.remove(); handle = undefined }
    const abort = () => {
      if (stopped) return
      stopped = true
      controller?.error(options.signal?.reason ?? new DOMException('Aborted', 'AbortError'))
      cancel(); cleanup()
    }
    const stream = options.stream ? new ReadableStream<Uint8Array>({
      start(value) { controller = value }, cancel() { stopped = true; cancel(); cleanup() },
    }) : undefined
    if (stream) {
      handle = await plugin.addListener('httpChunk', (event) => {
        if (event.requestId !== requestId || event.accountId !== options.accountId || stopped) return
        if (event.error) { stopped = true; controller?.error(new Error(event.error)); cleanup() }
        else {
          if (event.chunk) controller?.enqueue(encoder.encode(event.chunk))
          if (event.done) { stopped = true; controller?.close(); cleanup() }
        }
      })
      if (stopped) { void handle.remove(); handle = undefined }
    }
    if (!stopped) options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    try {
      options.signal?.throwIfAborted()
      const result = await plugin.request({ requestId, accountId: options.accountId, url: options.url, method: 'POST',
        headers: {
          'Content-Type': 'application/json', Accept: options.stream ? 'text/event-stream' : 'application/json',
          // The gateway documents both as required and gates newer models on the client
          // version inside User-Agent (an older version answers 404). The native layer
          // only forwards these allow-listed request headers.
          'User-Agent': 'antigravity/2.9.1 android/arm64',
          'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
        },
        body: options.body, stream: options.stream })
      options.signal?.throwIfAborted()
      if (!stream || result.status < 200 || result.status >= 300) {
        stopped = true; cleanup(); if (stream) cancel()
        return new Response(result.body ?? '', { status: result.status, headers: result.headers })
      }
      return new Response(stream, { status: result.status, headers: result.headers })
    } catch (error) { stopped = true; cleanup(); cancel(); throw error }
  } }
}
