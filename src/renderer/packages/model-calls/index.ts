import type { CallChatCompletionOptions, ModelInterface } from '@shared/models/types'
import { antigravityOwnerFromMessages } from '@shared/providers/definitions/models/antigravity'
import type { Message } from '@shared/types'
import { convertToModelMessages } from './message-utils'

export async function generateText(
  model: ModelInterface,
  messages: Message[],
  options: CallChatCompletionOptions = {}
) {
  const antigravity = model.name === 'Antigravity'
  const owner = antigravity ? (options.antigravity ?? antigravityOwnerFromMessages(messages)) : undefined
  return model.chat(await convertToModelMessages(messages, {
    modelSupportVision: model.isSupportVision(),
    ...(antigravity ? { preserveAntigravity: true } : {}),
  }), antigravity ? { ...options, antigravity: owner } : options)
}
