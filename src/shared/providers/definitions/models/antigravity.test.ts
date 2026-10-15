import type { ModelMessage } from 'ai'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { scopedSessionId } from '../../antigravity/protocol'
import type { AntigravityTransport } from '../../antigravity/types'
import Antigravity from './antigravity'

const native = vi.hoisted(() => ({ active: 'A', request: vi.fn<AntigravityTransport['request']>(), update: vi.fn() }))
vi.mock('../../antigravity/native', () => ({
  antigravityNative: {
    listAccounts: async () => ({ activeAccountId: native.active, accounts: [
      { id: 'A', project: 'project-A', reauthRequired: false }, { id: 'B', project: 'project-B', reauthRequired: false },
    ] }),
    updateAccountCache: native.update,
  },
  createNativeAntigravityTransport: () => ({ request: native.request }),
}))

const model = () => new Antigravity({ model: { modelId: 'claude-test' } })
const metadata = {
  version: 1 as const, accountId: 'A', project: 'project-A', modelId: 'claude-test',
  sessionId: scopedSessionId({ accountId: 'A', project: 'project-A', modelId: 'claude-test', sessionId: 'local' }),
  parts: [{ text: 'Account A private answer', thoughtSignature: 'signed-A' }],
  complete: true, status: 'completed' as const, finishReason: 'STOP',
}
const transcript = (): ModelMessage[] => [
  { role: 'assistant', content: 'Account A private answer', providerOptions: { antigravity: metadata } },
  { role: 'user', content: 'Summarize the transcript' },
]

describe('Antigravity original provider adapter', () => {
  beforeEach(() => { native.active = 'A'; native.request.mockReset(); native.update.mockReset() })
  it('refreshes the native account project and model cache for original registry model discovery', async () => {
    native.request.mockImplementation(async (request) => request.url.endsWith('loadCodeAssist')
      ? Response.json({ cloudaicompanionProject: 'discovered-project' })
      : Response.json({ models: { 'claude-test': { displayName: 'Claude test' } } }))
    const models = await model().listModels()
    expect(models).toEqual(expect.arrayContaining([expect.objectContaining({ modelId: 'claude-test' })]))
    expect(native.update).toHaveBeenCalledWith({ accountId: 'A', project: 'discovered-project', modelCache: models })
    expect(native.request.mock.calls.every(([request]) => request.accountId === 'A')).toBe(true)
  })
  it('rejects an auxiliary transcript owned by another account before dispatch', async () => {
    native.active = 'B'
    await expect(model().chat(transcript(), {})).rejects.toThrow('belongs to another Google account')
    expect(native.request).not.toHaveBeenCalled()
  })
  it('quotes auxiliary history into an independent protocol session with the same account snapshot', async () => {
    native.request.mockResolvedValue(new Response(`data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'A summary' }] }, finishReason: 'STOP' }] } })}\n\n`))
    await model().chat(transcript(), { sessionId: 'local', antigravity: { accountId: 'A', project: 'project-A' } })
    const request = native.request.mock.calls[0][0]
    const body = JSON.parse(request.body!)
    expect(request.accountId).toBe('A')
    expect(body.request.sessionId).not.toBe(metadata.sessionId)
    expect(JSON.stringify(body.request.contents)).toContain('Account A private answer')
    expect(JSON.stringify(body.request.contents)).not.toContain('signed-A')
    expect(body.request.contents).toHaveLength(1)
    expect(body.request.contents[0].role).toBe('user')
  })
})
