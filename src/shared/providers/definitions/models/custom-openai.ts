import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { extractReasoningMiddleware, wrapLanguageModel } from 'ai'
import AbstractAISDKModel from '../../../models/abstract-ai-sdk'
import { fetchRemoteModels, getOpenAICompatibleProviderOptionsKey } from '../../../models/openai-compatible'
import type { CallChatCompletionOptions } from '../../../models/types'
import { createFetchWithProxy } from '../../../models/utils/fetch-proxy'
import { createOpenAIChatCompletionSseFetch } from '../../../models/utils/openai-chat-sse-termination'
import type { ProviderModelInfo } from '../../../types'
import type { ModelDependencies } from '../../../types/adapters'
import { normalizeOpenAIApiHostAndPath } from '../../../utils/llm_utils'
import { pickOpenAICompatibleReasoningOptions } from '../../../utils/reasoning-control'

interface Options {
  apiKey: string
  apiHost: string
  apiPath: string
  model: ProviderModelInfo
  temperature?: number
  topP?: number
  maxOutputTokens?: number
  stream?: boolean
  useProxy?: boolean
  extraHeaders?: Record<string, string>
}

type FetchFunction = typeof globalThis.fetch

export default class CustomOpenAI extends AbstractAISDKModel {
  public name = 'Custom OpenAI'

  constructor(
    public options: Options,
    dependencies: ModelDependencies
  ) {
    super(options, dependencies)
    const { apiHost, apiPath } = normalizeOpenAIApiHostAndPath(options)
    this.options = { ...options, apiHost, apiPath }
  }

  protected getCallSettings(options: CallChatCompletionOptions) {
    const openAICompatibleOptions = pickOpenAICompatibleReasoningOptions(
      this.options.model.modelId,
      options.providerOptions
    )
    return {
      temperature: this.options.temperature,
      topP: this.options.topP,
      maxOutputTokens: this.options.maxOutputTokens,
      stream: this.options.stream,
      providerOptions: openAICompatibleOptions
        ? {
            openaiCompatible: openAICompatibleOptions,
            [getOpenAICompatibleProviderOptionsKey(this.name)]: openAICompatibleOptions,
          }
        : undefined,
    }
  }

  static isSupportTextEmbedding() {
    return true
  }

  protected getRequestHeaders(): Record<string, string> | undefined {
    if (this.options.extraHeaders && Object.keys(this.options.extraHeaders).length > 0) {
      return this.options.extraHeaders
    }
    if (this.options.apiHost.includes('openrouter.ai')) {
      return {
        'HTTP-Referer': 'https://chatboxai.app',
        'X-Title': 'Chatbox AI',
      }
    }
    if (this.options.apiHost.includes('aihubmix.com')) {
      return {
        'APP-Code': 'VAFU9221',
      }
    }
    return undefined
  }

  protected getProvider(_options: CallChatCompletionOptions, fetchFunction?: FetchFunction) {
    return createOpenAICompatible({
      name: this.name,
      apiKey: this.options.apiKey,
      baseURL: this.options.apiHost,
      fetch: fetchFunction,
      headers: this.getRequestHeaders(),
    })
  }

  protected getChatModel(options: CallChatCompletionOptions) {
    const { apiHost, apiPath } = this.options
    const fetch = createOpenAIChatCompletionSseFetch(async (_input, init) =>
      createFetchWithProxy(this.options.useProxy, this.dependencies)(`${apiHost}${apiPath}`, init)
    )
    const provider = this.getProvider(options, fetch)
    return wrapLanguageModel({
      model: provider.languageModel(this.options.model.modelId),
      middleware: extractReasoningMiddleware({ tagName: 'think' }),
    })
  }

  public listModels() {
    return fetchRemoteModels(
      {
        apiHost: this.options.apiHost,
        apiKey: this.options.apiKey,
        useProxy: this.options.useProxy,
        extraHeaders: this.options.extraHeaders,
      },
      this.dependencies
    )
  }

  protected getImageModel() {
    // Custom OpenAI providers typically don't support image generation
    return null
  }
}
