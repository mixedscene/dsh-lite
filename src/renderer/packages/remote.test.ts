import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activateLicense,
  buildChatboxUrl,
  checkNeedUpdate,
  createUserFile,
  getAPIOrigin,
  getChatboxAIModelList,
  getChatboxOrigin,
  getChatboxWebSearchRequestOptions,
  getDialogConfig,
  getLicenseDetail,
  getLicenseDetailRealtime,
  getModelManifest,
  getProviderModelsInfo,
  getRemoteConfig,
  getSessionRagConfig,
  getWebAuthToken,
  listCopilotTags,
  listCopilotsByCursor,
  listLicensesByUser,
  parseUserLinkFree,
  parseUserLinkPro,
  pollTaskUntilComplete,
  recordCopilotUsage,
  refreshAccessToken,
  reportContent,
  requestLoginTicketId,
  submitImageGeneration,
  validateLicense,
} from './remote'

const { registryModels, request, platform, savedSettings } = vi.hoisted(() => ({
  registryModels: vi.fn<(provider: string) => unknown[]>(),
  request: vi.fn(),
  platform: { type: 'web', getVersion: vi.fn(async () => 'local-version') },
  savedSettings: {
    licenseKey: 'old-license',
    providers: {
      'custom-relay': {
        apiKey: 'relay-key',
        models: [
          { modelId: 'relay-chat', nickname: 'Relay Chat', apiStyle: 'openai-responses' },
          { modelId: 'relay-image', nickname: 'Relay Image', type: 'image', apiStyle: 'openai' },
        ],
      },
    },
    customProviders: [{ id: 'custom-relay', name: 'My Relay' }],
  },
}))

vi.mock('./model-registry/enrich', () => ({ getProviderModelsFromRegistry: registryModels }))
vi.mock('@/utils/request', () => ({ apiRequest: { get: request } }))
vi.mock('@/platform', () => ({ default: platform }))
vi.mock('@/stores/settingsStore', () => ({ settingsStore: { getState: () => savedSettings } }))
vi.mock('@shared/defaults', () => ({
  SystemProviders: () => [
    {
      id: 'openai', name: 'OpenAI',
      defaultSettings: { models: [{ modelId: 'default-chat', nickname: 'Default Chat', apiStyle: 'openai' }] },
    },
    { id: 'gemini', name: 'Gemini', defaultSettings: {} },
  ],
}))

beforeEach(() => {
  vi.clearAllMocks()
  registryModels.mockReturnValue([])
  platform.type = 'web'
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('Unexpected network request'))))
})

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled()
  vi.unstubAllGlobals()
})

describe('offline model manifests', () => {
  it('merges registry models and provider defaults and filters incompatible entries', async () => {
    registryModels.mockReturnValue([
      { modelId: 'registry-chat', nickname: 'Registry Chat', apiStyle: 'openai-responses', capabilities: ['vision', 'audio', 'tool_use'] },
      { modelId: 'registry-image', type: 'image', apiStyle: 'openai' },
      { modelId: 'default-chat', nickname: 'Registry Default', apiStyle: 'openai' },
      { modelId: 'future', apiStyle: 'unsupported' },
    ])

    const result = await getModelManifest({ aiProvider: 'openai' })

    expect(result.groupName).toBe('OpenAI')
    expect(result.models.map((model) => model.modelId)).toEqual(['registry-chat', 'registry-image', 'default-chat'])
    expect(result.models.find((model) => model.modelId === 'default-chat')?.modelName).toBe('Default Chat')
    expect(result.models.find((model) => model.modelId === 'registry-chat')?.capabilities).toEqual(['vision', 'tool_use'])
    expect(result.imageModels.map((model) => model.modelId)).toEqual(expect.arrayContaining(['gpt-image-1', 'dall-e-3', 'registry-image']))
    expect(result.imageModels.every((model) => model.type === 'image')).toBe(true)
    expect(request).not.toHaveBeenCalled()
  })

  it('preserves saved custom relay models, protocols, images and credentials', async () => {
    const before = JSON.stringify(savedSettings)
    const result = await getModelManifest({ aiProvider: 'custom-relay' })

    expect(result.groupName).toBe('My Relay')
    expect(result.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ modelId: 'relay-chat', modelName: 'Relay Chat', apiStyle: 'openai-responses' }),
    ]))
    expect(result.imageModels).toEqual([expect.objectContaining({ modelId: 'relay-image', type: 'image' })])
    expect(JSON.stringify(savedSettings)).toBe(before)
    expect(request).not.toHaveBeenCalled()
  })

  it('keeps Gemini image fallbacks and supports unknown third party providers offline', async () => {
    const gemini = await getModelManifest({ aiProvider: 'gemini' })
    expect(gemini.imageModels.map((model) => model.modelId)).toContain('gemini-2.5-flash-image')
    expect(await getModelManifest({ aiProvider: 'another-relay' })).toEqual({
      groupName: 'another-relay', models: [], imageModels: [],
    })
  })

  it('returns empty official catalogs without reading local provider data', async () => {
    expect(await getModelManifest({ aiProvider: 'chatbox-ai' })).toMatchObject({ models: [], imageModels: [] })
    expect(await getChatboxAIModelList({})).toMatchObject({ groups: [], models: {}, imageModels: [] })
    expect(registryModels).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })
})

describe('disabled service compatibility', () => {
  it('returns local defaults without requests or modifying old data', async () => {
    const before = JSON.stringify(savedSettings)
    expect(await checkNeedUpdate('1', 'web', { uuid: 'old-device' }, {} as Parameters<typeof checkNeedUpdate>[3])).toBe(false)
    expect(await getRemoteConfig('current_version')).toEqual({
      setting_chatboxai_first: false, current_version: 'local-version', product_ids: [],
    })
    expect(await getSessionRagConfig()).toEqual({
      models: { embedding: '', rerank: '' },
      capabilities: { session_attachment_embedding: false, session_attachment_rerank: false },
    })
    expect(await getDialogConfig({ uuid: 'old-device', language: 'en', version: '1' })).toBeNull()
    expect(await getLicenseDetail({ licenseKey: 'old-license' })).toBeNull()
    expect(await getLicenseDetailRealtime({ licenseKey: 'old-license' })).toEqual({ data: null })
    expect(await listLicensesByUser()).toEqual([])
    expect(await listCopilotTags('en')).toEqual([])
    expect(await listCopilotsByCursor('en')).toEqual({ data: [], next_cursor: null })
    expect(await getProviderModelsInfo({ modelIds: ['relay-chat'] })).toEqual({})
    await recordCopilotUsage({ id: 'copilot', action: 'use_copilot' })
    await reportContent({ id: 'message', type: 'chat', details: 'text' })
    expect(JSON.stringify(savedSettings)).toBe(before)
    expect(request).not.toHaveBeenCalled()
  })

  it('rejects official operations before making any requests', async () => {
    const operations = [
      () => activateLicense({ licenseKey: 'old-license', instanceName: 'device' }),
      () => validateLicense({ licenseKey: 'old-license', instanceId: 'old-instance' }),
      () => requestLoginTicketId(),
      () => refreshAccessToken({ refreshToken: 'old-token' }),
      () => getWebAuthToken(),
      () => getChatboxWebSearchRequestOptions(),
      () => parseUserLinkPro({ licenseKey: 'old-license', url: 'https://example.test' }),
      () => createUserFile({ licenseKey: 'old-license', filename: 'file.txt', filetype: 'text/plain', returnContent: true }),
      () => submitImageGeneration({ model: 'image', prompt: 'test', response_format: 'b64_json' }, 'old-license'),
      () => pollTaskUntilComplete('old-task', 'old-license'),
    ]
    for (const operation of operations) {
      await expect(operation()).rejects.toThrow('This service is unavailable.')
    }
    expect(request).not.toHaveBeenCalled()
    expect(savedSettings.licenseKey).toBe('old-license')
  })

  it('keeps links render-safe and inert, including absolute URL input', () => {
    expect(getAPIOrigin()).toBe('about:blank')
    expect(getChatboxOrigin()).toBe('about:blank')
    for (const path of ['/redirect_app/homepage', 'https://example.test/path']) {
      expect(new URL(buildChatboxUrl(path)).protocol).toBe('about:')
    }
  })
})

describe('third party webpage parsing', () => {
  it.each(['web', 'mobile', 'desktop'])('keeps the requested target and native transport for %s', async (type) => {
    platform.type = type
    request.mockResolvedValue(new Response('Page text', { headers: { 'Content-Type': 'text/plain' } }))

    expect(await parseUserLinkFree({ url: 'http://relay.test/page' })).toEqual({
      title: 'http://relay.test/page', text: 'Page text',
    })
    expect(request).toHaveBeenCalledWith(
      'http://relay.test/page',
      { Accept: 'text/html, text/plain' },
      { useProxy: type !== 'web' }
    )
  })

  it('extracts page title and text while removing executable and embedded content', async () => {
    const remove = vi.fn()
    const querySelectorAll = vi.fn(() => [{ remove }])
    const parseFromString = vi.fn(() => ({
      title: 'Page title', body: { textContent: '  Page text  ' }, querySelectorAll,
    }))
    vi.stubGlobal('DOMParser', class {
      parseFromString = parseFromString
    })
    request.mockResolvedValue(new Response('<html>page</html>', {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }))

    expect(await parseUserLinkFree({ url: 'https://example.test/page' })).toEqual({
      title: 'Page title', text: 'Page text',
    })
    expect(parseFromString).toHaveBeenCalledWith('<html>page</html>', 'text/html')
    expect(querySelectorAll).toHaveBeenCalledWith('script, style, noscript, iframe')
    expect(remove).toHaveBeenCalledOnce()
  })

  it('rejects unsupported URL schemes without requesting them', async () => {
    await expect(parseUserLinkFree({ url: 'file:///secret' })).rejects.toThrow('Unsupported webpage URL')
    expect(request).not.toHaveBeenCalled()
  })

  it('propagates webpage request failures for caller fallbacks', async () => {
    request.mockRejectedValue(new Error('Page unavailable'))
    await expect(parseUserLinkFree({ url: 'https://example.test/page' })).rejects.toThrow('Page unavailable')
  })
})
