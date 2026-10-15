import { describe, expect, it } from 'vitest'
import { AntigravityClient, AntigravityServiceError } from './client'
import { buildHistory, replayParts, scopedSessionId } from './protocol'
import { readSSE } from './sse'
import type { AntigravityHistoryMessage, AntigravityPart, AntigravityTransport, AntigravityUpdate } from './types'

const user = (text: string): AntigravityHistoryMessage => ({ role: 'user', contentParts: [{ type: 'text', text }] })
const scope = { accountId: 'account-A', project: 'project-A', modelId: 'gemini-3-pro', sessionId: 'chat-1' }
const event = (parts: AntigravityPart[] = [], finishReason?: string) => `data: ${JSON.stringify({ response: { candidates: [{ content: { parts }, ...(finishReason ? { finishReason } : {}) }] } })}\r\n\r\n`
const response = (text: string): Response => {
  const bytes = new TextEncoder().encode(text)
  return new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close() } }), { headers: { 'Content-Type': 'text/event-stream' } })
}
function fixture(streams: string[]) {
  const requests: Record<string, unknown>[] = []
  const accounts: string[] = []
  const transport: AntigravityTransport = { async request(options) {
    requests.push(JSON.parse(options.body)); accounts.push(options.accountId)
    const next = streams.shift()
    if (next === undefined) throw new Error('Unexpected extra request')
    return response(next)
  } }
  return { client: new AntigravityClient(transport), requests, accounts }
}
const contents = (request: Record<string, unknown>) => (request.request as { contents: { role: string; parts: AntigravityPart[] }[] }).contents

describe('SSE framing', () => {
  it('decodes split UTF-8, CRLF, comments, event fields and multiline data', async () => {
    const events = []
    for await (const value of readSSE(response(': ping\r\nevent: message\r\ndata: {\r\ndata: "text":"青竹🌿"}\r\n\r\ndata: [DONE]\r\n\r\n').body!)) events.push(value)
    expect(events).toEqual([{ event: 'message', data: '{\n"text":"青竹🌿"}' }, { event: undefined, data: '[DONE]' }])
    expect(JSON.parse(events[0].data)).toEqual({ text: '青竹🌿' })
  })
  it('handles CR-only boundaries and final event without blank line', async () => {
    const events = []
    for await (const value of readSSE(response('data: one\r\rdata: two').body!)) events.push(value.data)
    expect(events).toEqual(['one', 'two'])
  })
  it('cancels a pending read', async () => {
    const controller = new AbortController()
    let cancelled = false
    const iterator = readSSE(new ReadableStream<Uint8Array>({ cancel() { cancelled = true } }), controller.signal)
    const pending = iterator.next()
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancelled).toBe(true)
  })
})

describe('protocol replay fixtures', () => {
  const invalidClaudeBlocks: [string, AntigravityPart[]][] = [
    ['unsigned thought', [{ thought: true, text: 'thinking' }, { text: 'answer' }]],
    ['empty thought signature', [{ thought: true, text: 'thinking', thoughtSignature: '' }, { text: 'answer' }]],
    ['unsigned later thought', [{ thought: true, text: 'first', thoughtSignature: 'sig-first' }, { text: 'answer' }, { thought: true, text: 'second' }]],
    ['nonthought signature', [{ thought: true, text: 'thinking', thoughtSignature: 'sig-thought' }, { text: 'answer', thoughtSignature: 'sig-on-text' }]],
  ]
  it.each(invalidClaudeBlocks)('rejects completed Claude %s while preserving Gemini raw parts', (_name: string, raw: AntigravityPart[]) => {
    expect(() => replayParts(raw, 'claude-sonnet-thinking')).toThrow(/signature/)
    expect(replayParts(raw, 'gemini-3-pro')).toEqual(raw)
  })
  it.each(invalidClaudeBlocks)('never completes STOP with Claude %s', async (_name: string, raw: AntigravityPart[]) => {
    const { client } = fixture([raw.map((part) => event([part])).join('') + event([], 'STOP')])
    const updates: AntigravityUpdate[] = []
    await expect(client.chat({ ...scope, modelId: 'claude-sonnet-thinking', messages: [user('hello')], onUpdate: (update) => updates.push(update) })).rejects.toThrow(/signature/)
    expect(updates.at(-1)!.antigravity).toMatchObject({ complete: false, status: 'failed', finishReason: 'STOP', parts: raw })
    expect(updates.every((update) => !update.antigravity.complete)).toBe(true)
  })
  it('keeps thoughts provisional until a later signature chunk and valid finish', async () => {
    const raw = [{ thought: true, text: 'thinking' }, { thoughtSignature: 'late-signature' }, { text: 'answer' }]
    const { client } = fixture([raw.map((part) => event([part])).join('') + event([], 'STOP')])
    const updates: AntigravityUpdate[] = []
    const result = await client.chat({ ...scope, modelId: 'claude-sonnet-thinking', messages: [user('hello')], onUpdate: (update) => updates.push(update) })
    expect(updates[0].antigravity).toMatchObject({ complete: false, status: 'streaming', parts: [raw[0]] })
    expect(updates.slice(0, -1).every((update) => !update.antigravity.complete)).toBe(true)
    expect(result.antigravity).toMatchObject({ complete: true, status: 'completed', parts: [{ thought: true, text: 'thinking', thoughtSignature: 'late-signature' }, { text: 'answer' }] })
  })
  it('replays Gemini three rounds after restart with every raw signature-only part intact', async () => {
    const signed: AntigravityPart[] = [{ text: '思考', thought: true }, { thoughtSignature: 'opaque-A/==', thought: true }, { text: '青竹741' }, { thoughtSignature: 'opaque-B/==' }]
    const { client, requests } = fixture([signed.map((part) => event([part])).join('') + event([], 'STOP'), event([{ text: '青竹741' }, { thoughtSignature: 'second/==' }], 'STOP'), event([{ text: '青竹852' }], 'STOP')])
    const first = await client.chat({ ...scope, messages: [user('记住青竹741')] })
    expect(first.antigravity.parts).toEqual(signed)
    const messages: AntigravityHistoryMessage[] = JSON.parse(JSON.stringify([user('记住青竹741'), { role: 'assistant', ...first }, user('复述')]))
    const second = await client.chat({ ...scope, messages })
    messages.push({ role: 'assistant', ...second }, user('将741变成852'))
    await client.chat({ ...scope, messages })
    expect(contents(requests[1])).toHaveLength(3)
    expect(contents(requests[2])).toHaveLength(5)
    expect(contents(requests[2])[1].parts).toEqual(signed)
    expect(contents(requests[2])[3].parts[1]).toEqual({ thoughtSignature: 'second/==' })
    expect(JSON.stringify(requests)).not.toMatch(/"tools"|functionDeclarations/)
    expect((requests[0].request as { sessionId: string }).sessionId).toBe(scopedSessionId(scope))
  })
  it('coalesces ordered Claude thought/text blocks with their own signatures across three rounds', async () => {
    const raw = [{ text: '', thought: true }, { text: '先', thought: true }, { text: '想', thought: true }, { thoughtSignature: 'sig-one' }, { text: '' }, { text: '答' }, { text: '案' }, { text: '再想', thought: true }, { thoughtSignature: 'sig-two' }, { text: '松果26' }]
    const expected = [{ text: '先想', thought: true, thoughtSignature: 'sig-one' }, { text: '答案' }, { text: '再想', thought: true, thoughtSignature: 'sig-two' }, { text: '松果26' }]
    const { client, requests } = fixture([raw.map((part) => event([part])).join('') + event([], 'STOP'), event([{ text: '再', thought: true }]) + event([{ text: '想', thought: true }, { thoughtSignature: 'sig-three' }, { text: '松果26' }], 'STOP'), event([{ text: '松果52' }], 'STOP')])
    const claude = { ...scope, modelId: 'claude-sonnet-thinking' }
    const first = await client.chat({ ...claude, messages: [user('记住松果26')] })
    expect(first.antigravity.parts).toEqual(expected)
    expect(first.contentParts.map((part) => part.type)).toEqual(['reasoning', 'text', 'reasoning', 'text'])
    const messages: AntigravityHistoryMessage[] = JSON.parse(JSON.stringify([user('记住松果26'), { role: 'assistant', ...first }, user('复述')]))
    const second = await client.chat({ ...claude, messages })
    messages.push({ role: 'assistant', ...second }, user('翻倍'))
    await client.chat({ ...claude, messages })
    expect(contents(requests[1])[1].parts).toEqual(expected)
    expect(contents(requests[2])[3].parts).toEqual([{ text: '再想', thought: true, thoughtSignature: 'sig-three' }, { text: '松果26' }])
    expect((requests[0].request as { generationConfig: unknown }).generationConfig).toEqual({ maxOutputTokens: 4096, thinkingConfig: { includeThoughts: true, thinkingBudget: 1024 } })
  })
  it('never uses Claude coalescing for Gemini signature-only parts', () => {
    const raw = [{ thoughtSignature: 'alone' }, { text: '' }]
    expect(replayParts(raw, 'gemini-3-pro')).toEqual(raw)
    expect(() => replayParts(raw, 'claude-sonnet')).toThrow('signature without')
  })
  it('isolates A→B→A and model/project/session changes', async () => {
    const { client, requests, accounts } = fixture(Array.from({ length: 6 }, () => event([{ text: 'answer', thoughtSignature: 'signed-A' }], 'STOP')))
    const first = await client.chat({ ...scope, messages: [user('private A')] })
    const messages = [user('private A'), { role: 'assistant', ...first }, user('next')]
    for (const changed of [{ accountId: 'account-B' }, { modelId: 'gemini-3-flash' }, { project: 'other-project' }, { sessionId: 'other-chat' }]) {
      await client.chat({ ...scope, ...changed, messages })
      expect(contents(requests.at(-1)!)).toEqual([{ role: 'user', parts: [{ text: 'next' }] }])
      expect(JSON.stringify(requests.at(-1))).not.toContain('signed-A')
      expect(JSON.stringify(requests.at(-1))).not.toContain('private A')
    }
    await client.chat({ ...scope, messages })
    expect(contents(requests.at(-1)!)).toHaveLength(3)
    expect(accounts).toEqual(['account-A', 'account-B', 'account-A', 'account-A', 'account-A', 'account-A'])
  })
  it('regeneration excludes the old answer', async () => {
    const { client, requests } = fixture([event([{ text: 'old answer' }], 'STOP'), event([{ text: 'new answer' }], 'STOP')])
    const first = await client.chat({ ...scope, messages: [user('question')] })
    await client.chat({ ...scope, messages: [user('question'), { role: 'assistant', ...first }] })
    expect(contents(requests[1])).toEqual([{ role: 'user', parts: [{ text: 'question' }] }])
  })
  it('drops incomplete user/assistant pairs when continuing', async () => {
    const { client, requests } = fixture([event([{ text: 'partial' }]), event([{ text: 'next answer' }], 'STOP')])
    let partial: AntigravityUpdate | undefined
    await expect(client.chat({ ...scope, messages: [user('failed prompt')], onUpdate: (value) => { partial = value } })).rejects.toThrow('without a finish')
    expect(partial!.antigravity).toMatchObject({ complete: false, status: 'failed' })
    await client.chat({ ...scope, messages: [user('failed prompt'), { role: 'assistant', ...partial! }, user('new prompt')] })
    expect(contents(requests[1])).toEqual([{ role: 'user', parts: [{ text: 'new prompt' }] }])
  })
  it('has collision-free tuple encoding', () => {
    expect(scopedSessionId({ ...scope, accountId: 'ab', project: 'c' })).not.toBe(scopedSessionId({ ...scope, accountId: 'a', project: 'bc' }))
  })
})

describe('completion/error boundaries', () => {
  it.each([
    ['missing finish', event([{ text: 'partial' }])],
    ['DONE without finish', event([{ text: 'partial' }]) + 'data: [DONE]\n\n'],
    ['token limit', event([{ text: 'partial' }], 'MAX_TOKENS')],
    ['tool call', event([{ functionCall: { name: 'read_file', args: {} } }], 'STOP')],
    ['malformed JSON', event([{ text: 'partial' }]) + 'data: {bad\n\n'],
    ['service error', 'data: {"error":{"code":403}}\n\n'],
    ['event error', 'event: error\ndata: failed\n\n'],
    ['content after finish', event([{ text: 'first' }], 'STOP') + event([{ text: 'late' }])],
  ])('never marks %s complete', async (_name: string, stream: string) => {
    const { client } = fixture([stream])
    const updates: AntigravityUpdate[] = []
    await expect(client.chat({ ...scope, messages: [user('hello')], onUpdate: (value) => updates.push(value) })).rejects.toThrow()
    expect(updates.at(-1)!.antigravity).toMatchObject({ complete: false, status: 'failed' })
    expect(updates.every((value) => !value.antigravity.complete)).toBe(true)
  })
  it('preserves visible partial text but no completed state on cancellation', async () => {
    const controller = new AbortController()
    const { client } = fixture([event([{ text: 'half' }]) + event([{ text: 'late' }], 'STOP')])
    const updates: AntigravityUpdate[] = []
    await expect(client.chat({ ...scope, messages: [user('hello')], signal: controller.signal, onUpdate: (value) => { updates.push(value); if (value.antigravity.status === 'streaming') controller.abort() } })).rejects.toMatchObject({ name: 'AbortError' })
    expect(updates.at(-1)!.antigravity).toMatchObject({ complete: false, status: 'cancelled' })
    expect(updates.at(-1)!.contentParts).toEqual([{ type: 'text', text: 'half' }])
  })
  it('fails on network failure even after STOP', async () => {
    let reads = 0
    let update: AntigravityUpdate | undefined
    const client = new AntigravityClient({ async request() { return new Response(new ReadableStream({ pull(controller) { if (!reads++) controller.enqueue(new TextEncoder().encode(event([{ text: 'text' }], 'STOP'))); else controller.error(new Error('connection lost')) } })) } })
    await expect(client.chat({ ...scope, messages: [user('hello')], onUpdate: (value) => { update = value } })).rejects.toThrow('connection lost')
    expect(update!.antigravity.complete).toBe(false)
  })
  it('exposes Retry-After and never retries 429', async () => {
    let count = 0
    const client = new AntigravityClient({ async request() { count++; return new Response('private error', { status: 429, headers: { 'Retry-After': '30' } }) } })
    const promise = client.chat({ ...scope, messages: [user('hello')] })
    await expect(promise).rejects.toBeInstanceOf(AntigravityServiceError)
    await expect(promise).rejects.toMatchObject({ status: 429, retryAfter: '30' })
    expect(count).toBe(1)
  })
  it('reports the host that serves the account when the fallback fails too', async () => {
    const client = new AntigravityClient({ async request(options) {
      return options.url.startsWith('https://daily') ? new Response('Requested entity was not found.', { status: 404 }) : new Response('rate limited', { status: 429 })
    } })
    const promise = client.chat({ ...scope, messages: [user('hello')] })
    await expect(promise).rejects.toMatchObject({ status: 404 })
    await expect(promise).rejects.toThrow(/The fallback host answered 429\./)
    await expect(promise).rejects.toThrow(/\[daily-cloudcode-pa\.googleapis\.com/)
  })
  it('sends a skill once in systemInstruction', async () => {
    const { client, requests } = fixture([event([{ text: 'ok' }], 'STOP')])
    await client.chat({ ...scope, messages: [user('hello')], systemInstruction: 'SKILL be concise' })
    expect(requests[0].request).toMatchObject({ systemInstruction: { parts: [{ text: 'SKILL be concise' }] } })
    expect(JSON.stringify(contents(requests[0]))).not.toContain('SKILL')
  })
})

describe('account-scoped discovery', () => {
  it.each(['discovered-project', { id: 'discovered-project' }])('handles string or object project and returned model ids', async (cloudaicompanionProject: string | { id: string }) => {
    const calls: { accountId: string; body: string }[] = []
    const client = new AntigravityClient({ async request(options) { calls.push(options); return Response.json(calls.length === 1 ? { cloudaicompanionProject } : { models: { 'new-model-99': { displayName: 'New Model', inputTokenLimit: 2000, outputTokenLimit: 1000 } } }) } })
    expect(await client.discoverModels('account-B')).toEqual({ project: 'discovered-project', models: [{ modelId: 'new-model-99', nickname: 'New Model', capabilities: [], contextWindow: 2000, maxOutput: 1000 }] })
    expect(calls.map((call) => call.accountId)).toEqual(['account-B', 'account-B'])
    expect(JSON.parse(calls[0].body)).toEqual({ metadata: { ideType: 'ANTIGRAVITY', pluginType: 'GEMINI' } })
    expect(JSON.parse(calls[1].body)).toEqual({ project: 'discovered-project' })
  })
  it('reads the catalog from the host that serves generation', async () => {
    const urls: string[] = []
    const client = new AntigravityClient({ async request(options) {
      urls.push(options.url)
      return options.url.includes('loadCodeAssist') ? Response.json({ cloudaicompanionProject: 'p' }) : Response.json({ models: { 'gemini-3.8-flash-high': { displayName: 'Gemini 3.8 Flash (High)' } } })
    } })
    expect((await client.discoverModels('account-B')).models.map((model) => model.modelId)).toEqual(['gemini-3.8-flash-high'])
    expect(urls).toEqual(['https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist', 'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels'])
  })
  it('falls back to the production catalog when the daily catalog is unavailable', async () => {
    const urls: string[] = []
    const client = new AntigravityClient({ async request(options) {
      urls.push(options.url)
      if (options.url.includes('loadCodeAssist')) return Response.json({ cloudaicompanionProject: 'p' })
      if (options.url.startsWith('https://daily')) return new Response('Requested entity was not found.', { status: 404 })
      return Response.json({ models: { 'gemini-3.9-flash-low': { displayName: 'Gemini 3.9 Flash (Low)' } } })
    } })
    expect((await client.discoverModels('account-B')).models.map((model) => model.modelId)).toEqual(['gemini-3.9-flash-low'])
    expect(urls).toHaveLength(3)
  })
  it('does not onboard or retry missing projects', async () => {
    let count = 0
    const client = new AntigravityClient({ async request() { count++; return Response.json({ allowedTiers: [] }) } })
    await expect(client.discoverModels('account-A')).rejects.toThrow('no Antigravity project')
    expect(count).toBe(1)
  })
  it('does not borrow signatures from untyped old messages', () => {
    expect(buildHistory({ ...scope, messages: [user('old'), { role: 'assistant', contentParts: [{ type: 'text', text: 'old untyped reply' }] }, user('current')] })).toEqual([{ role: 'user', parts: [{ text: 'current' }] }])
  })
})
