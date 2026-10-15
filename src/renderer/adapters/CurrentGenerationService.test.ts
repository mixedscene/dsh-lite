import type { GenerationPreparationRequest } from '@chatbox/core/generation'
import Antigravity from '@shared/providers/definitions/models/antigravity'
import type { Config, Session, Settings } from '@shared/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareAntigravityGeneration } from './AntigravityGenerationPreparation'

const native = vi.hoisted(() => ({ active: 'A', project: 'project-A' as string | undefined, request: vi.fn() }))
vi.mock('@shared/providers/antigravity/native', () => ({
  antigravityNative: { listAccounts: async () => ({ activeAccountId: native.active, accounts: [
    { id: 'A', project: native.project, reauthRequired: false }, { id: 'B', project: 'project-B', reauthRequired: false },
  ] }) },
  createNativeAntigravityTransport: () => ({ request: native.request }),
}))

function preparation(session: Session): GenerationPreparationRequest<null> {
  return {
    session, settings: { provider: 'antigravity', modelId: 'claude-test' }, globalSettings: {} as Settings, config: {} as Config,
    messages: session.messages, targetMessageIndex: session.messages.length - 1,
    model: new Antigravity({ model: { modelId: 'claude-test' } }), modelContext: null,
    attachments: { read: async () => null }, webBrowsing: true, agentModeValue: 'off', agentModeLocked: false,
    agentModeSupported: false, signal: new AbortController().signal, preserveLastPromptMessageToolCalls: false,
    lockAgentMode: () => {},
  }
}
function session(): Session { return {
  id: 'local-session', name: 'Test', type: 'chat', messages: [
    { id: 's', role: 'system', contentParts: [{ type: 'text', text: 'Original system prompt' }] },
    { id: 'u', role: 'user', contentParts: [{ type: 'text', text: 'Hello' }] },
    { id: 'a', role: 'assistant', contentParts: [] },
  ],
} }

describe('original Antigravity generation preparation', () => {
  beforeEach(() => { native.active = 'A'; native.project = 'project-A'; native.request.mockReset() })
  it('binds a native account once and preserves original system/user messages without tools', async () => {
    const chat = session(), bind = vi.fn(async (owner: NonNullable<Session['antigravity']>) => { chat.antigravity = owner })
    const prepared = await prepareAntigravityGeneration(preparation(chat), bind)
    expect(bind).toHaveBeenCalledWith({ accountId: 'A', project: 'project-A' })
    expect(prepared.coreMessages).toEqual([
      { role: 'system', content: 'Original system prompt' }, { role: 'user', content: 'Hello' },
    ])
    expect(prepared.tools).toEqual({})
    expect(prepared.chatOptions).toMatchObject({ sessionId: chat.id, antigravity: { accountId: 'A', project: 'project-A' } })
    expect(native.request).not.toHaveBeenCalled()
  })
  it('does not rebind an existing chat when native active account changes', async () => {
    const chat = session(); chat.antigravity = { accountId: 'A', project: 'project-A' }; native.active = 'B'
    const bind = vi.fn()
    await expect(prepareAntigravityGeneration(preparation(chat), bind)).rejects.toThrow('belongs to another Google account')
    expect(bind).not.toHaveBeenCalled(); expect(native.request).not.toHaveBeenCalled()
  })
  it('rechecks the active account after discovery before persisting an owner', async () => {
    native.project = undefined
    native.request.mockImplementation(async ({ url }: { url: string }) => {
      if (url.endsWith('loadCodeAssist')) return Response.json({ cloudaicompanionProject: 'project-A' })
      native.active = 'B'
      return Response.json({ models: { 'claude-test': { displayName: 'Claude' } } })
    })
    const bind = vi.fn()
    await expect(prepareAntigravityGeneration(preparation(session()), bind)).rejects.toThrow('belongs to another Google account')
    expect(bind).not.toHaveBeenCalled()
    expect(native.request.mock.calls.every(([request]) => !request.stream)).toBe(true)
  })
})
