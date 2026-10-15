import { featureFlags } from '@/utils/feature-flags'
import platform from '@/platform'
import { ApiError, BaseError, NetworkError } from '../../shared/models/errors'
import { isLocalHost } from '../../shared/utils/network_utils'
import { desktopDirectRequestFromWindow } from './desktop-direct-request'
import { handleMobileRequest } from './mobile-request'

interface RequestOptions {
  method: string
  headers?: RequestInit['headers']
  body?: RequestInit['body']
  signal?: AbortSignal
  retry?: number
  useProxy?: boolean
}

async function retryRequest<T>(fn: () => Promise<T>, retry: number, url: string): Promise<T> {
  let requestError: BaseError | null = null

  for (let i = 0; i <= retry; i++) {
    try {
      return await fn()
    } catch (e) {
      // ApiError represents an upstream response and AbortError is an explicit
      // caller cancellation; neither belongs in the network retry path.
      if (e instanceof ApiError || (e instanceof Error && e.name === 'AbortError')) {
        throw e
      }
      let origin = 'unknown'
      try {
        origin = new URL(url, typeof window !== 'undefined' ? window.location.origin : 'http://localhost').origin
      } catch {}
      requestError = e instanceof BaseError ? e : new NetworkError((e as Error).message, origin)

      if (i < retry) {
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }
  }

  throw requestError || new Error('Unknown error')
}

function buildHeaders(options: RequestOptions, url: string): Headers {
  const headers = new Headers(options.headers)
  headers.set('Content-Type', 'application/json')

  if (featureFlags.chatboxAI && options.useProxy && !isLocalHost(url) && platform.type !== 'mobile' && platform.type !== 'desktop') {
    headers.set('CHATBOX-TARGET-URI', url)
    headers.set('CHATBOX-PLATFORM', platform.type)
  }

  return headers
}

/**
 * The app is served from the WebView's https origin, so an insecure endpoint can never be
 * reached by fetch: the mixed-content policy blocks the request outright and the endpoint
 * usually answers no preflight either. Such endpoints (self-hosted relays, local servers)
 * go through the native transport, which is not subject to either restriction.
 */
function needsNativeTransport(url: string): boolean {
  return /^http:\/\//i.test(url)
}

async function doRequest(url: string, options: RequestOptions): Promise<Response> {
  const { signal, retry = 3, useProxy = false, body, method } = options
  let requestUrl = url
  const headers = buildHeaders(options, url)

  if (featureFlags.chatboxAI && useProxy && !isLocalHost(url) && platform.type !== 'mobile' && platform.type !== 'desktop') {
    const version = await platform.getVersion()
    headers.set('CHATBOX-VERSION', version || 'unknown')
    requestUrl = 'https://cors-proxy.chatboxai.app/proxy-api/completions'
  }

  const makeRequest = async () => {
    let res: Response
    if (platform.type === 'mobile' && (useProxy || needsNativeTransport(requestUrl))) {
      res = await handleMobileRequest(requestUrl, method, headers, body, signal)
    } else if (platform.type === 'desktop' && useProxy && !isLocalHost(url)) {
      res = await desktopDirectRequestFromWindow(requestUrl, method, headers, body, signal)
    } else {
      res = await fetch(requestUrl, { method, headers, body, signal })
    }

    if (!res.ok) {
      const err = await res.text().catch(() => null)
      throw new ApiError(`Status Code ${res.status}`, err ?? undefined, res.status)
    }
    return res
  }

  return retryRequest(makeRequest, retry, requestUrl)
}

export const apiRequest = {
  async post(
    url: string,
    headers: Record<string, string>,
    body: RequestInit['body'],
    options?: Partial<RequestOptions>
  ) {
    return doRequest(url, { ...options, method: 'POST', headers, body })
  },

  async get(url: string, headers: Record<string, string>, options?: Partial<RequestOptions>) {
    return doRequest(url, { ...options, method: 'GET', headers })
  },
}

export async function fetchWithProxy(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return doRequest(input.toString(), {
    method: init?.method || 'GET',
    headers: init?.headers,
    body: init?.body,
    signal: init?.signal || undefined,
    useProxy: true,
  })
}
