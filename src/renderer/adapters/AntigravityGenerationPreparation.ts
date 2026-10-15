import type { GenerationPreparationRequest, PreparedGeneration } from '@chatbox/core/generation'
import { resolveAntigravityAccount } from '@shared/providers/definitions/models/antigravity'
import { convertToModelMessages } from '@shared/services/model-message-converter'
import type { Session } from '@shared/types'

/** Keep protocol turns whole: the ordinary agent harness rewrites/merges tool history. */
export async function prepareAntigravityGeneration<T>(
  request: GenerationPreparationRequest<T>,
  bindOwner: (owner: NonNullable<Session['antigravity']>) => Promise<void>
): Promise<PreparedGeneration> {
  const promptMessages = request.messages.slice(0, request.targetMessageIndex)
  // Older persisted transcripts may have message ownership but no session binding yet.
  const saved = [...promptMessages].reverse().find((message) => message.antigravity)?.antigravity
  const owner = request.session.antigravity ?? (saved ? { accountId: saved.accountId, project: saved.project } : undefined)
  const { account, client } = await resolveAntigravityAccount(owner, request.signal)
  const project = owner?.project ?? account.project ?? (await client.discoverModels(account.id, request.signal)).project
  request.signal.throwIfAborted()
  await resolveAntigravityAccount({ accountId: account.id, project }, request.signal)
  await bindOwner({ ...request.session.antigravity, accountId: account.id, project })
  request.signal.throwIfAborted()
  if (promptMessages.some((message) => message.role === 'user' && (
    message.files?.length || message.links?.length || message.contentParts.some((part) => part.type !== 'text')
  ))) throw new Error('Antigravity supports text chat only')
  const coreMessages = await convertToModelMessages(promptMessages, async () => null, {
    modelSupportVision: false,
    preserveAntigravity: true,
  })
  return {
    promptMessages,
    coreMessages,
    tools: {},
    chatOptions: { sessionId: request.session.id, signal: request.signal, antigravity: { accountId: account.id, project }, maxSteps: 1 },
    infoParts: [],
    fallbackToolCallPart: undefined,
  }
}
