import type { MessageContentParts } from '../../types'
import type { AntigravityChatOptions, AntigravityMetadata, AntigravityPart } from './types'

export function scopedSessionId(scope: Pick<AntigravityChatOptions, 'accountId' | 'project' | 'modelId' | 'sessionId'>): string {
  // Length prefixes make the tuple unambiguous without collisions or persisted mutable maps.
  return `chatbox:${[scope.accountId, scope.project, scope.modelId, scope.sessionId].map((value) => `${value.length}:${value}`).join('')}`
}
export function isClaude(modelId: string): boolean { return /claude/i.test(modelId) }
export function containsToolCall(part: AntigravityPart): boolean {
  return ['functionCall', 'functionResponse', 'toolCall', 'toolUse', 'function_call', 'tool_use'].some((key) => key in part)
}
export function replayParts(raw: readonly AntigravityPart[], modelId: string): AntigravityPart[] {
  if (!isClaude(modelId)) return raw.map((part) => structuredClone(part))
  const result: AntigravityPart[] = []
  for (const source of raw) {
    const part = structuredClone(source)
    if (containsToolCall(part)) throw new Error('Antigravity returned a tool call; tools are disabled')
    const text = typeof part.text === 'string' ? part.text : ''
    const previous = result.at(-1)
    if (!text) {
      if (typeof part.thoughtSignature === 'string') {
        if (!previous || previous.thought !== true || typeof previous.text !== 'string' || !previous.text) {
          throw new Error('Claude returned a signature without its logical thought block')
        }
        if (previous.thoughtSignature && previous.thoughtSignature !== part.thoughtSignature) {
          throw new Error('Claude returned conflicting signatures for a thought block')
        }
        previous.thoughtSignature = part.thoughtSignature
      } else if (Object.keys(part).some((key) => key !== 'text' && key !== 'thought')) {
        result.push(part)
      }
      continue
    }
    const mergeable = Object.keys(part).every((key) => ['text', 'thought', 'thoughtSignature'].includes(key)) &&
      previous && Object.keys(previous).every((key) => ['text', 'thought', 'thoughtSignature'].includes(key)) &&
      (previous.thought === true) === (part.thought === true) && !previous.thoughtSignature
    if (mergeable) {
      previous.text = String(previous.text ?? '') + text
      if (part.thoughtSignature !== undefined) previous.thoughtSignature = part.thoughtSignature
    } else result.push(part)
  }
  return result
}
export function visibleParts(raw: readonly AntigravityPart[]): MessageContentParts {
  const parts: MessageContentParts = []
  for (const part of raw) {
    if (typeof part.text !== 'string' || !part.text) continue
    const type = part.thought === true ? 'reasoning' : 'text'
    const previous = parts.at(-1)
    if (previous?.type === type) previous.text += part.text
    else parts.push({ type, text: part.text })
  }
  return parts
}
export function buildHistory(options: AntigravityChatOptions): { role: 'user' | 'model'; parts: AntigravityPart[] }[] {
  let lastUser = -1
  options.messages.forEach((message, index) => { if (message.role === 'user') lastUser = index })
  if (lastUser < 0) throw new Error('Antigravity requires a user message')
  const contents: { role: 'user' | 'model'; parts: AntigravityPart[] }[] = []
  let pending: AntigravityPart[] | undefined
  const expectedSession = scopedSessionId(options)
  for (let index = 0; index <= lastUser; index++) {
    const message = options.messages[index]
    if (message.role === 'user') {
      if (message.contentParts.some((part) => part.type !== 'text')) throw new Error('Antigravity supports text chat only')
      pending = message.contentParts.flatMap((part) => part.type === 'text' && !part.protocolOnly ? [{ text: part.text }] : [])
      if (index === lastUser) {
        if (!pending.some((part) => typeof part.text === 'string' && part.text.trim())) throw new Error('Antigravity requires nonempty user text')
        contents.push({ role: 'user', parts: pending })
      }
    } else if (message.role === 'assistant' && pending) {
      const metadata = message.antigravity
      const matches = metadata?.version === 1 && metadata.accountId === options.accountId && metadata.project === options.project &&
        metadata.modelId === options.modelId && metadata.sessionId === expectedSession
      if (matches && metadata.complete && metadata.status === 'completed' && metadata.finishReason === 'STOP') {
        if (metadata.parts.some(containsToolCall)) throw new Error('Tool calls cannot be replayed in Antigravity chat')
        contents.push({ role: 'user', parts: pending }, { role: 'model', parts: structuredClone(metadata.parts) })
      } else if (metadata && !matches) {
        // Keep no context from a different account/model/session, including its user turns.
        contents.length = 0
      }
      pending = undefined
    }
  }
  return contents
}
export function createMetadata(options: AntigravityChatOptions): AntigravityMetadata {
  return { version: 1, accountId: options.accountId, project: options.project, modelId: options.modelId,
    sessionId: scopedSessionId(options), parts: [], complete: false, status: 'streaming' }
}
