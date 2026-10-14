import type { LanguageModelUsage, ModelMessage } from 'ai'
import type { CallChatCompletionOptions, ChatStreamOptions, ModelInterface, ModelStreamPart } from '../../../models/types'
import type { MessageContentParts, ProviderModelInfo, StreamTextResult } from '../../../types'
import { AntigravityClient } from '../../antigravity/client'
import { AntigravityMetadataSchema, type AntigravityChatOptions, type AntigravityChatResult, type AntigravityHistoryMessage, type AntigravityUpdate } from '../../antigravity/types'

interface Options { model: ProviderModelInfo; temperature?: number; topP?: number; maxOutputTokens?: number }
const sdkUsage = (usage?: AntigravityChatResult['usage']): LanguageModelUsage => ({
  inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens, totalTokens: usage?.totalTokens,
  inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
  outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
})

/** Direct protocol provider. No AI SDK prompt conversion or tool execution takes place. */
export default class Antigravity implements ModelInterface {
  readonly name = 'Antigravity'
  readonly modelId: string
  constructor(public readonly options: Options) { this.modelId = options.model.modelId }
  isSupportVision() { return false }
  isSupportToolUse() { return false }
  isSupportSystemMessage() { return true }
  normalizeCompletedResponse(parts: MessageContentParts) { return parts }
  async paint(): Promise<string[]> { throw new Error('Antigravity supports text chat only') }
  private async nativeContext() {
    const { antigravityNative, createNativeAntigravityTransport } = await import('../../antigravity/native')
    const accounts = await antigravityNative.listAccounts()
    const account = accounts.accounts.find((entry) => entry.id === accounts.activeAccountId)
    if (!account) throw new Error('Sign in to Google before using Antigravity')
    if (account.reauthRequired) throw new Error('Google authorization expired. Sign in again.')
    return { account, client: new AntigravityClient(createNativeAntigravityTransport()) }
  }
  async listModels(): Promise<ProviderModelInfo[]> {
    const { account, client } = await this.nativeContext()
    return (await client.discoverModels(account.id)).models
  }
  async chatWithHistory(options: AntigravityChatOptions): Promise<AntigravityChatResult> {
    const { createNativeAntigravityTransport } = await import('../../antigravity/native')
    return new AntigravityClient(createNativeAntigravityTransport()).chat(options)
  }
  private history(messages: ModelMessage[]): AntigravityHistoryMessage[] {
    return messages.map((message) => {
      if (message.role === 'tool') throw new Error('Tools are disabled for Antigravity')
      const contentParts: MessageContentParts = []
      if (typeof message.content === 'string') contentParts.push({ type: 'text', text: message.content })
      else for (const part of message.content) {
        if (part.type === 'text' || part.type === 'reasoning') contentParts.push({ type: part.type, text: part.text })
        else throw new Error('Antigravity supports text chat only')
      }
      const parsed = AntigravityMetadataSchema.safeParse(message.providerOptions?.antigravity)
      if (message.role === 'assistant' && !parsed.success) throw new Error('Antigravity history requires original protocol parts; use AntigravityClient with saved Message.antigravity metadata')
      return { role: message.role, contentParts, antigravity: parsed.success ? parsed.data : undefined }
    })
  }
  private async execute(messages: ModelMessage[], options: CallChatCompletionOptions, onUpdate?: (update: AntigravityUpdate) => void) {
    const history = this.history(messages)
    if (!options.sessionId) throw new Error('Antigravity requires a stable Chatbox session id')
    const { account, client } = await this.nativeContext()
    const project = account.project ?? (await client.discoverModels(account.id, options.signal)).project
    return client.chat({ accountId: account.id, project, modelId: this.modelId, sessionId: options.sessionId,
      messages: history, signal: options.signal, onUpdate, temperature: this.options.temperature,
      topP: this.options.topP, maxOutputTokens: this.options.maxOutputTokens })
  }
  async chat(messages: ModelMessage[], options: CallChatCompletionOptions): Promise<StreamTextResult & AntigravityUpdate> {
    const result = await this.execute(messages, options, (update) => options.onResultChange?.(update))
    return { ...result, usage: sdkUsage(result.usage) }
  }
  async *chatStream(messages: ModelMessage[], options: ChatStreamOptions): AsyncGenerator<ModelStreamPart> {
    const controller = new AbortController()
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal
    const queue: AntigravityUpdate[] = []
    let wake: (() => void) | undefined
    let settled = false
    let failure: unknown
    let result: AntigravityChatResult | undefined
    const task = this.execute(messages, { ...options, signal }, (update) => { queue.push(update); wake?.() })
      .then((value) => { result = value }, (error: unknown) => { failure = error })
      .finally(() => { settled = true; wake?.() })
    const lengths: number[] = []
    const started = new Set<number>()
    const types: ('text' | 'reasoning')[] = []
    try {
      yield { type: 'start' }
      while (!settled || queue.length) {
        if (!queue.length) { await new Promise<void>((resolve) => { wake = resolve }); wake = undefined; continue }
        const update = queue.shift()!
        for (let index = 0; index < update.contentParts.length; index++) {
          const part = update.contentParts[index]
          if (part.type !== 'text' && part.type !== 'reasoning') continue
          const id = `antigravity-${index}`
          if (!started.has(index)) { started.add(index); types[index] = part.type; yield { type: part.type === 'text' ? 'text-start' : 'reasoning-start', id } }
          const text = part.text.slice(lengths[index] ?? 0)
          lengths[index] = part.text.length
          if (text) yield { type: part.type === 'text' ? 'text-delta' : 'reasoning-delta', id, text }
        }
      }
      if (failure) throw failure
      for (const index of started) yield { type: types[index] === 'text' ? 'text-end' : 'reasoning-end', id: `antigravity-${index}` }
      yield { type: 'finish', finishReason: 'stop', rawFinishReason: result?.finishReason, totalUsage: sdkUsage(result?.usage) }
    } finally { controller.abort(); await task }
  }
}
