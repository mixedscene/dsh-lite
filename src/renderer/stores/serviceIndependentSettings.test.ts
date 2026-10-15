import type { Settings } from '@shared/types/settings'
import { describe, expect, it } from 'vitest'
import { getServiceIndependentSettingsPatch } from './serviceIndependentSettings'

const parserDefault = { type: 'none' } as const

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    extension: {
      webSearch: { provider: 'bing' },
      documentParser: { type: 'local' },
    },
    mcp: { enabledBuiltinServers: [] },
    ...overrides,
  } as Settings
}

describe('getServiceIndependentSettingsPatch', () => {
  it('preserves arbitrary third-party provider relay settings and selected models', () => {
    const provider = {
      apiKey: 'third-party-key',
      apiHost: 'https://relay.example.test/v1/custom',
      apiPath: '/responses',
      apiStyle: 'openai-responses',
      customHeaders: { 'X-Relay': 'keep-me' },
      models: [{ modelId: 'relay-model', nickname: 'Relay model' }],
    }
    const current = settings({
      providers: { 'custom-relay': provider },
      defaultChatModel: { provider: 'custom-relay', model: 'relay-model' },
      extension: {
        webSearch: { provider: 'tavily', tavilyApiKey: 'tavily-key' },
        documentParser: { type: 'local' },
      },
    })

    const patch = getServiceIndependentSettingsPatch(current, parserDefault)

    expect(patch.defaultChatModel).toBeUndefined()
    expect(patch.providers).toBeUndefined()
    expect(patch.extension).toBeUndefined()
    expect(current.providers?.['custom-relay']).toEqual(provider)
    expect(current.defaultChatModel).toEqual({ provider: 'custom-relay', model: 'relay-model' })
  })

  it('normalizes only removed proprietary selections and enabled built-in servers', () => {
    const current = settings({
      defaultChatModel: { provider: 'chatbox-ai', model: 'chatboxai-4' },
      extension: {
        webSearch: { provider: 'build-in' },
        documentParser: { type: 'chatbox-ai' },
      },
      mcp: { servers: [], enabledBuiltinServers: ['context7'] },
      favoritedModels: [
        { provider: 'chatbox-ai', model: 'chatboxai-4' },
        { provider: 'openai', model: 'gpt-4o-mini' },
      ],
    })

    expect(getServiceIndependentSettingsPatch(current, parserDefault)).toEqual({
      defaultChatModel: undefined,
      extension: {
        webSearch: { provider: 'bing' },
        documentParser: { type: 'none' },
      },
      mcp: { servers: [], enabledBuiltinServers: [] },
      favoritedModels: [{ provider: 'openai', model: 'gpt-4o-mini' }],
    })
  })
})
