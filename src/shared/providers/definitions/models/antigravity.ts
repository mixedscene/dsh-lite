import type { LanguageModelUsage, ModelMessage } from 'ai'
import type { CallChatCompletionOptions, ChatStreamOptions, ModelInterface, ModelStreamPart } from '../../../models/types'
import type { Message, MessageContentParts, ProviderModelInfo, StreamTextResult } from '../../../types'
import { AntigravityClient } from '../../antigravity/client'
import { AntigravityMetadataSchema, type AntigravityChatOptions, type AntigravityChatResult, type AntigravityHistoryMessage, type AntigravityUpdate } from '../../antigravity/types'

/** Auxiliary prompts flatten history, so mixed-account transcripts must fail closed. */
export function antigravityOwnerFromMessages(
  messages: readonly { antigravity?: unknown; providerOptions?: { antigravity?: unknown } }[],
  snapshot?: { accountId: string; project?: string }
) {
  let owner = snapshot
  for (const message of messages) {
    const parsed = AntigravityMetadataSchema.safeParse(message.antigravity ?? message.providerOptions?.antigravity)
    if (!parsed.success) continue
    const { accountId, project } = parsed.data
    if (owner && (owner.accountId !== accountId || (owner.project !== undefined && owner.project !== project))) {
      throw new Error('Cannot send a transcript containing multiple Google accounts to Antigravity')
    }
    owner = { accountId, project }
  }
  return owner
}

/** Resolve against the native active account before dispatch; never silently rebind a session. */
export async function resolveAntigravityAccount(owner?: { accountId: string; project?: string }, signal?: AbortSignal) {
  const { antigravityNative, createNativeAntigravityTransport } = await import('../../antigravity/native')
  signal?.throwIfAborted()
  const accounts = await antigravityNative.listAccounts()
  signal?.throwIfAborted()
  const account = accounts.accounts.find((entry) => entry.id === accounts.activeAccountId)
  if (!account) throw new Error('Sign in to Google before using Antigravity')
  if (owner && owner.accountId !== account.id) throw new Error('This chat belongs to another Google account. Switch back to that account or start a new chat.')
  if (account.reauthRequired) throw new Error('Google authorization expired. Sign in again.')
  if (owner?.project && account.project && owner.project !== account.project) throw new Error('This chat belongs to another Antigravity project. Start a new chat.')
  return { account, client: new AntigravityClient(createNativeAntigravityTransport()) }
}

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
  async listModels(): Promise<ProviderModelInfo[]> {
    const { account, client } = await resolveAntigravityAccount()
    const discovery = await client.discoverModels(account.id)
    const { antigravityNative } = await import('../../antigravity/native')
    await antigravityNative.updateAccountCache({ accountId: account.id, project: discovery.project, modelCache: discovery.models })
    return discovery.models
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
      return { role: message.role, contentParts, antigravity: parsed.success ? parsed.data : undefined }
    })
  }
  private async execute(messages: ModelMessage[], options: CallChatCompletionOptions, onUpdate?: (update: AntigravityUpdate) => void) {
    const history = this.history(messages)
    if (!options.sessionId) throw new Error('Antigravity requires a stable Chatbox session id')
    const { account, client } = await resolveAntigravityAccount(options.antigravity, options.signal)
    const project = options.antigravity?.project ?? account.project ?? (await client.discoverModels(account.id, options.signal)).project
    // Discovery can outlive an account switch. Revalidate the immutable snapshot.
    await resolveAntigravityAccount({ accountId: account.id, project }, options.signal)
    return client.chat({ accountId: account.id, project, modelId: this.modelId, sessionId: options.sessionId,
      messages: history, signal: options.signal, onUpdate, temperature: this.options.temperature,
      topP: this.options.topP, maxOutputTokens: this.options.maxOutputTokens })
  }
  async chat(messages: ModelMessage[], options: CallChatCompletionOptions): Promise<StreamTextResult & AntigravityUpdate> {
    // Naming, summaries and capability probes own a fresh protocol session.
    // Their input is a quoted transcript, never a synthetic signed conversation.
    const history = this.history(messages)
    const owner = antigravityOwnerFromMessages(history.map((message) => ({ ...message, id: '' })), options.antigravity)
    const transcript = history.filter((message) => message.role !== 'system').map((message) => {
      const text = message.contentParts.map((part) => 'text' in part ? part.text : '').join('')
      return `${message.role}: ${text}`
    }).join('\n\n')
    const prompt: ModelMessage[] = [
      ...messages.filter((message) => message.role === 'system'),
      { role: 'user', content: transcript },
    ]
    const result = await this.execute(prompt, {
      ...options,
      antigravity: owner,
      sessionId: `aux-${options.sessionId ?? 'probe'}-${crypto.randomUUID()}`,
    }, (update) => options.onResultChange?.(update))
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
    const task = (async () => {
      await options.onRequestResolved?.({ modelMessages: messages, tools: {}, stream: true, callSettings: {
        temperature: this.options.temperature, topP: this.options.topP, maxOutputTokens: this.options.maxOutputTokens,
      } })
      return this.execute(messages, { ...options, signal }, (update) => { queue.push(update); wake?.() })
    })()
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
        yield { type: 'antigravity-metadata', antigravity: update.antigravity }
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
