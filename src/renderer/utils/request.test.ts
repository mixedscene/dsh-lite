import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  platform: { type: 'desktop', getVersion: vi.fn(async () => '1.0.0') },
  desktopDirectRequest: vi.fn(),
  mobileRequest: vi.fn(),
}))

vi.mock('@/platform', () => ({ default: mocks.platform }))
vi.mock('./desktop-direct-request', () => ({ desktopDirectRequestFromWindow: mocks.desktopDirectRequest }))
vi.mock('./mobile-request', () => ({ handleMobileRequest: mocks.mobileRequest }))

import { apiRequest } from './request'

describe('provider API request routing', () => {
  afterEach(() => {
    mocks.platform.type = 'desktop'
    mocks.platform.getVersion.mockClear()
    mocks.desktopDirectRequest.mockReset()
    mocks.mobileRequest.mockReset()
    vi.unstubAllGlobals()
  })

  it('uses the main-process direct transport for remote desktop targets when compatibility is enabled', async () => {
    const response = new Response('ok')
    mocks.desktopDirectRequest.mockResolvedValue(response)
    const rendererFetch = vi.fn()
    vi.stubGlobal('fetch', rendererFetch)

    await expect(
      apiRequest.post('https://provider.example/v1/chat', { authorization: 'Bearer secret' }, '{"stream":true}', {
        useProxy: true,
        retry: 0,
      })
    ).resolves.toBe(response)

    expect(mocks.desktopDirectRequest).toHaveBeenCalledWith(
      'https://provider.example/v1/chat',
      'POST',
      expect.any(Headers),
      '{"stream":true}',
      undefined
    )
    const headers = mocks.desktopDirectRequest.mock.calls[0][2] as Headers
    expect(headers.get('CHATBOX-TARGET-URI')).toBeNull()
    expect(rendererFetch).not.toHaveBeenCalled()
  })

  it('keeps local desktop targets in the renderer', async () => {
    const response = new Response('ok')
    const rendererFetch = vi.fn().mockResolvedValue(response)
    vi.stubGlobal('fetch', rendererFetch)

    await expect(apiRequest.get('http://127.0.0.1:11434/api/tags', {}, { useProxy: true, retry: 0 })).resolves.toBe(
      response
    )

    expect(rendererFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/api/tags',
      expect.objectContaining({ method: 'GET' })
    )
    expect(mocks.desktopDirectRequest).not.toHaveBeenCalled()
  })

  it('preserves the ApiError contract for failed desktop direct responses', async () => {
    mocks.desktopDirectRequest.mockResolvedValue(new Response('upstream unavailable', { status: 503 }))

    const request = apiRequest.get('https://provider.example/v1/models', {}, { useProxy: true, retry: 0 })

    await expect(request).rejects.toMatchObject({
      message: 'API Error: Status Code 503',
      responseBody: 'upstream unavailable',
      statusCode: 503,
    })
  })

  it('preserves AbortError without retrying a cancelled desktop direct request', async () => {
    const abortError = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
    mocks.desktopDirectRequest.mockRejectedValue(abortError)

    const request = apiRequest.get('https://provider.example/v1/models', {}, { useProxy: true, retry: 3 })

    await expect(request).rejects.toBe(abortError)
    expect(mocks.desktopDirectRequest).toHaveBeenCalledTimes(1)
  })

  it('directly fetches remote web targets when the proprietary relay is disabled', async () => {
    mocks.platform.type = 'web'
    const response = new Response('ok')
    const rendererFetch = vi.fn().mockResolvedValue(response)
    vi.stubGlobal('fetch', rendererFetch)

    await apiRequest.get('https://provider.example/v1/models', {}, { useProxy: true, retry: 0 })

    expect(rendererFetch).toHaveBeenCalledWith(
      'https://provider.example/v1/models',
      expect.objectContaining({ method: 'GET' })
    )
    const headers = rendererFetch.mock.calls[0][1].headers as Headers
    expect(headers.get('CHATBOX-TARGET-URI')).toBeNull()
    expect(mocks.desktopDirectRequest).not.toHaveBeenCalled()
  })

  it('routes insecure mobile targets through the native transport without the compatibility toggle', async () => {
    mocks.platform.type = 'mobile'
    const response = new Response('ok')
    mocks.mobileRequest.mockResolvedValue(response)
    const rendererFetch = vi.fn()
    vi.stubGlobal('fetch', rendererFetch)

    await expect(apiRequest.get('http://relay.example:8222/v1/models', {}, { retry: 0 })).resolves.toBe(response)

    expect(mocks.mobileRequest).toHaveBeenCalledWith(
      'http://relay.example:8222/v1/models',
      'GET',
      expect.any(Headers),
      undefined,
      undefined
    )
    expect(rendererFetch).not.toHaveBeenCalled()
  })

  it('keeps secure mobile targets in the WebView unless compatibility is enabled', async () => {
    mocks.platform.type = 'mobile'
    const response = new Response('ok')
    const rendererFetch = vi.fn().mockResolvedValue(response)
    mocks.mobileRequest.mockResolvedValue(response)
    vi.stubGlobal('fetch', rendererFetch)

    await apiRequest.get('https://api.example.com/v1/models', {}, { retry: 0 })

    expect(rendererFetch).toHaveBeenCalledWith(
      'https://api.example.com/v1/models',
      expect.objectContaining({ method: 'GET' })
    )
    expect(mocks.mobileRequest).not.toHaveBeenCalled()
  })
})
