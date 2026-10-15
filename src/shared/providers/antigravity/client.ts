import type { ProviderModelInfo } from '../../types'
import { buildHistory, containsToolCall, createMetadata, isClaude, replayParts, visibleParts } from './protocol'
import { readSSE } from './sse'
import type { AntigravityChatOptions, AntigravityChatResult, AntigravityDiscovery, AntigravityPart, AntigravityTransport } from './types'

export const ANTIGRAVITY_DISCOVERY_HOST = 'https://cloudcode-pa.googleapis.com'
const ANTIGRAVITY_STREAM_PATH = '/v1internal:streamGenerateContent?alt=sse'
/**
 * Generation runs on the host that served the model catalog first: a catalog fetched
 * from one host can name a model the other host does not know, which surfaces as a
 * bare 404 "Requested entity was not found". The daily host stays as a fallback for
 * accounts whose tier is only served there.
 */
export const ANTIGRAVITY_STREAM_URLS = [`${ANTIGRAVITY_DISCOVERY_HOST}${ANTIGRAVITY_STREAM_PATH}`, `https://daily-cloudcode-pa.googleapis.com${ANTIGRAVITY_STREAM_PATH}`]
export const ANTIGRAVITY_STREAM_URL = ANTIGRAVITY_STREAM_URLS[0]
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const numeric = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined
export class AntigravityServiceError extends Error {
  constructor(public status: number, public retryAfter?: string | null, detail?: string, context?: string) {
    super([status === 401 ? 'Google authorization expired. Sign in again.' : status === 403 ? 'This Google account does not have permission to use the requested Antigravity service or model.' : status === 429 ? 'Antigravity rate limit reached. Wait before trying again.' : status === 400 ? 'Antigravity rejected the protocol or model parameters (400).' : `Antigravity request failed (${status}).`, detail, context ? `[${context}]` : ''].filter(Boolean).join(' '))
    this.name = 'AntigravityServiceError'
  }
}
async function failureDetail(response: Response): Promise<string> {
  try {
    const text = await response.text()
    return text.replace(/\s+/g, ' ').trim().slice(0, 300)
  } catch { return '' }
}
async function checked(response: Response, context?: string): Promise<Response> {
  if (!response.ok) {
    // The gateway explains failures in the body ("Requested entity was not found."); keep a
    // bounded copy so a bare status code can still be diagnosed from the UI.
    const detail = await failureDetail(response)
    throw new AntigravityServiceError(response.status, response.headers.get('retry-after'), detail, context)
  }
  return response
}
const contextOf = (url: string, extra?: string): string => [url.replace(/^https:\/\//, ''), extra].filter(Boolean).join(' · ')
export class AntigravityClient {
  constructor(private readonly transport: AntigravityTransport) {}

  async discoverModels(accountId: string, signal?: AbortSignal): Promise<AntigravityDiscovery> {
    const load = await checked(await this.transport.request({ accountId, signal,
      url: `${ANTIGRAVITY_DISCOVERY_HOST}/v1internal:loadCodeAssist`,
      body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY', pluginType: 'GEMINI' } }),
    }), 'v1internal:loadCodeAssist')
    const loaded = object(await load.json())
    signal?.throwIfAborted()
    const rawProject = loaded.cloudaicompanionProject
    const project = typeof rawProject === 'string' ? rawProject : object(rawProject).id
    if (typeof project !== 'string' || !project.trim()) throw new Error('This account has no Antigravity project. Check service eligibility and required consent in Google; the app cannot accept agreements automatically.')
    const response = await checked(await this.transport.request({ accountId, signal,
      url: `${ANTIGRAVITY_DISCOVERY_HOST}/v1internal:fetchAvailableModels`, body: JSON.stringify({ project }),
    }), 'v1internal:fetchAvailableModels')
    const catalog = object(await response.json())
    signal?.throwIfAborted()
    const rawModels = catalog.models
    if (!rawModels || typeof rawModels !== 'object') throw new Error('Antigravity returned no model catalog for this account')
    const entries = Array.isArray(rawModels) ? rawModels.map((model) => { const value = object(model); return [value.id ?? value.modelId ?? value.name, value] as const }) : Object.entries(rawModels)
    const models: ProviderModelInfo[] = []
    const seen = new Set<string>()
    for (const [id, value] of entries) {
      if (typeof id !== 'string' || !id || seen.has(id)) continue
      const model = object(value)
      seen.add(id)
      models.push({ modelId: id, nickname: typeof model.displayName === 'string' ? model.displayName : id,
        capabilities: /gemini|claude/i.test(id) ? ['reasoning'] : [],
        contextWindow: numeric(model.inputTokenLimit), maxOutput: numeric(model.outputTokenLimit),
      })
    }
    if (!models.length) throw new Error('No Antigravity models are available for this account')
    // The catalog keeps every concrete tier: the picker aggregates families for display, and the
    // account cache needs the tier ids so a request can be resolved back onto a published one.
    return { project, models }
  }

  async chat(options: AntigravityChatOptions): Promise<AntigravityChatResult> {
    options.signal?.throwIfAborted()
    if (![options.accountId, options.project, options.modelId, options.sessionId].every((value) => typeof value === 'string' && value.trim())) throw new Error('Antigravity requires account, project, model and session identifiers')
    const metadata = createMetadata(options)
    const raw: AntigravityPart[] = []
    let finishReason: string | undefined
    let usage: AntigravityChatResult['usage']
    const publish = () => options.onUpdate?.({ contentParts: visibleParts(raw), antigravity: structuredClone(metadata) })
    try {
      const contents = buildHistory(options)
      const maxOutputTokens = options.maxOutputTokens ?? 4096
      if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) throw new Error('Invalid Antigravity output token limit')
      const generationConfig: Record<string, unknown> = { maxOutputTokens }
      if (options.temperature !== undefined) generationConfig.temperature = options.temperature
      if (options.topP !== undefined) generationConfig.topP = options.topP
      if (isClaude(options.modelId) && maxOutputTokens > 1024) generationConfig.thinkingConfig = { includeThoughts: true, thinkingBudget: 1024 }
      // The picker aggregates Antigravity's per-tier catalog entries, so the caller decides the
      // level; the wire format keeps the enum case this endpoint already accepted.
      else if (/gemini-3/i.test(options.modelId)) generationConfig.thinkingConfig = { includeThoughts: options.includeThoughts ?? true, thinkingLevel: (options.thinkingLevel ?? 'low').toUpperCase() }
      else if (/gemini-2\.5/i.test(options.modelId) && maxOutputTokens > 1024) generationConfig.thinkingConfig = { includeThoughts: true, thinkingBudget: 1024 }
      const system = [options.systemInstruction, ...options.messages.filter((message) => message.role === 'system').map((message) => message.contentParts.filter((part) => part.type === 'text').map((part) => part.text).join('\n'))].filter(Boolean).join('\n\n')
      const streamBody = () => JSON.stringify({ project: options.project, model: options.modelId, requestType: 'agent', userAgent: 'antigravity', requestId: `agent-${crypto.randomUUID()}`,
        request: { sessionId: metadata.sessionId, contents, generationConfig, ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}) },
      })
      let response: Response | undefined
      let failure: unknown
      for (const url of ANTIGRAVITY_STREAM_URLS) {
        options.signal?.throwIfAborted()
        try {
          // A 404 means this host cannot resolve the entity the catalog named; the other host may.
          response = await checked(await this.transport.request({ accountId: options.accountId, signal: options.signal, stream: true, url, body: streamBody() }), contextOf(url, `model ${options.modelId}`))
          break
        } catch (error) {
          if (!(error instanceof AntigravityServiceError) || error.status !== 404) throw error
          failure = error
        }
      }
      if (!response) throw failure ?? new Error('Antigravity request failed')
      if (!response.body) throw new Error('Antigravity returned an empty stream')
      const contentType = response.headers.get('content-type')
      if (contentType && !contentType.toLowerCase().includes('text/event-stream')) {
        await response.body.cancel().catch(() => {})
        throw new Error('Antigravity returned an unexpected non-SSE response')
      }
      for await (const event of readSSE(response.body, options.signal)) {
        if (event.event === 'error') throw new Error('Antigravity reported a streaming error')
        if (event.data.trim() === '[DONE]') break
        let payload: unknown
        try { payload = JSON.parse(event.data) } catch { throw new Error('Antigravity returned malformed SSE JSON') }
        const envelope = object(payload)
        const data = object(envelope.response ?? envelope)
        if (envelope.error || data.error) throw new Error('Antigravity reported a service error in the stream')
        const candidates = data.candidates
        if (candidates !== undefined && !Array.isArray(candidates)) throw new Error('Antigravity returned invalid candidates')
        const candidate = object(Array.isArray(candidates) ? candidates[0] : undefined)
        const parts = object(candidate.content).parts
        if (parts !== undefined && !Array.isArray(parts)) throw new Error('Antigravity returned invalid content parts')
        if (Array.isArray(parts)) {
          if (finishReason && parts.length) throw new Error('Antigravity returned content after its finish reason')
          for (const part of parts) {
            if (!part || typeof part !== 'object' || Array.isArray(part)) throw new Error('Antigravity returned an invalid content part')
            const record = part as AntigravityPart
            if (containsToolCall(record)) throw new Error('Antigravity returned a tool call; tools are disabled')
            raw.push(structuredClone(record))
          }
        }
        if (typeof candidate.finishReason === 'string') {
          if (finishReason && finishReason !== candidate.finishReason) throw new Error('Antigravity returned conflicting finish reasons')
          finishReason = candidate.finishReason
        }
        if (data.usageMetadata) {
          const counts = object(data.usageMetadata)
          usage = { inputTokens: numeric(counts.promptTokenCount), outputTokens: numeric(counts.candidatesTokenCount), totalTokens: numeric(counts.totalTokenCount) }
        }
        // Partial raw parts are saved for display/recovery, never marked replayable.
        metadata.parts = structuredClone(raw)
        metadata.finishReason = finishReason
        publish()
      }
      options.signal?.throwIfAborted()
      if (finishReason !== 'STOP') throw new Error(finishReason ? `Antigravity reply is incomplete (${finishReason}).` : 'Antigravity stream ended without a finish reason')
      if (!visibleParts(raw).length) throw new Error('Antigravity returned no reply text')
      metadata.parts = replayParts(raw, options.modelId)
      metadata.complete = true
      metadata.status = 'completed'
      metadata.finishReason = finishReason
      publish()
      return { contentParts: visibleParts(raw), antigravity: structuredClone(metadata), finishReason, usage }
    } catch (error) {
      metadata.complete = false
      metadata.status = options.signal?.aborted ? 'cancelled' : 'failed'
      metadata.parts = structuredClone(raw)
      metadata.finishReason = finishReason
      publish()
      throw error
    }
  }
}
