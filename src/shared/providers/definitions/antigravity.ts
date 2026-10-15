import { ModelProviderType } from '../../types'
import { defineProvider } from '../registry'
import Antigravity from './models/antigravity'

export const antigravityProvider = defineProvider({
  id: 'antigravity', name: 'Google Antigravity', type: ModelProviderType.Gemini, platforms: ['mobile'],
  description: 'Google account chat with native credential storage and account model discovery.',
  modelListSource: 'provider-only', defaultSettings: { models: [] },
  createModel: ({ model, settings }) => new Antigravity({ model, temperature: settings.temperature, topP: settings.topP, maxOutputTokens: settings.maxTokens }),
  getDisplayName: (modelId, settings) => `Antigravity (${settings?.models?.find((model) => model.modelId === modelId)?.nickname || modelId})`,
})
