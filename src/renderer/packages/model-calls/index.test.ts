import type { ModelInterface } from '@shared/models/types'
import type { Message } from '@shared/types'
import { describe, expect, it, vi } from 'vitest'
import { generateText } from './index'

const convertToModelMessagesMock = vi.fn()

vi.mock('./message-utils', () => ({
  convertToModelMessages: (...args: unknown[]) => convertToModelMessagesMock(...args),
}))

describe('generateText', () => {
  it('passes modelSupportVision option into convertToModelMessages', async () => {
    const messages: Message[] = [{ id: 'u1', role: 'user', contentParts: [{ type: 'text', text: 'hello' }] }]
    convertToModelMessagesMock.mockResolvedValue([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }])

    const chatMock = vi.fn().mockResolvedValue({ contentParts: [{ type: 'text', text: 'ok' }] })
    const model = {
      isSupportVision: () => false,
      chat: chatMock,
    } as unknown as ModelInterface

    await generateText(model, messages, { sessionId: 'session-1' })

    expect(convertToModelMessagesMock).toHaveBeenCalledWith(messages, { modelSupportVision: false })
    expect(chatMock).toHaveBeenCalledWith(expect.any(Array), { sessionId: 'session-1' })
  })
})


describe('Antigravity auxiliary account snapshots', () => {
  const metadata = {
    version: 1 as const, accountId: 'account-A', project: 'project-A', modelId: 'claude-test', sessionId: 'scoped',
    parts: [{ text: 'Private reply', thoughtSignature: 'signature' }], complete: true, status: 'completed' as const, finishReason: 'STOP',
  }
  it('passes stored ownership and raw metadata conversion to independent auxiliary calls', async () => {
    const messages: Message[] = [{ id: 'a1', role: 'assistant', contentParts: [{ type: 'text', text: 'Private reply' }], antigravity: metadata }]
    convertToModelMessagesMock.mockResolvedValue([{ role: 'assistant', content: 'Private reply' }])
    const chat = vi.fn().mockResolvedValue({ contentParts: [] })
    const model = { name: 'Antigravity', isSupportVision: () => false, chat } as unknown as ModelInterface
    await generateText(model, messages)
    expect(convertToModelMessagesMock).toHaveBeenLastCalledWith(messages, { modelSupportVision: false, preserveAntigravity: true })
    expect(chat).toHaveBeenLastCalledWith(expect.any(Array), { antigravity: { accountId: 'account-A', project: 'project-A' } })
  })
  it('rejects a mixed-account transcript before conversion or HTTP dispatch', async () => {
    const chat = vi.fn()
    const model = { name: 'Antigravity', isSupportVision: () => false, chat } as unknown as ModelInterface
    await expect(generateText(model, [
      { id: 'a1', role: 'assistant', contentParts: [], antigravity: metadata },
      { id: 'a2', role: 'assistant', contentParts: [], antigravity: { ...metadata, accountId: 'account-B' } },
    ])).rejects.toThrow('multiple Google accounts')
    expect(chat).not.toHaveBeenCalled()
  })
})
