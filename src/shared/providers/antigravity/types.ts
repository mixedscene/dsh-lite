import { z } from 'zod'
import type { MessageContentParts, ProviderModelInfo } from '../../types'

export const AntigravityPartSchema = z.record(z.string(), z.unknown())
export type AntigravityPart = z.infer<typeof AntigravityPartSchema>
export const AntigravityMetadataSchema = z.object({
  version: z.literal(1), accountId: z.string(), project: z.string(), modelId: z.string(), sessionId: z.string(),
  parts: z.array(AntigravityPartSchema), complete: z.boolean(),
  status: z.enum(['streaming', 'completed', 'cancelled', 'failed']), finishReason: z.string().optional(),
})
export type AntigravityMetadata = z.infer<typeof AntigravityMetadataSchema>
export const AntigravitySessionSchema = z.object({ accountId: z.string(), project: z.string().optional(), skillIds: z.array(z.string()).optional() })
export interface AntigravityHistoryMessage { role: string; contentParts: MessageContentParts; antigravity?: AntigravityMetadata }
export interface AntigravityUpdate { contentParts: MessageContentParts; antigravity: AntigravityMetadata }
export interface AntigravityChatOptions {
  accountId: string
  project: string
  modelId: string
  sessionId: string
  messages: readonly AntigravityHistoryMessage[]
  systemInstruction?: string
  signal?: AbortSignal
  maxOutputTokens?: number
  temperature?: number
  topP?: number
  onUpdate?: (update: AntigravityUpdate) => void
}
export interface AntigravityChatResult extends AntigravityUpdate {
  finishReason: string
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
}
export interface AntigravityTransport {
  request(options: { accountId: string; url: string; body: string; stream?: boolean; signal?: AbortSignal }): Promise<Response>
}
export interface AntigravityDiscovery { project: string; models: ProviderModelInfo[] }
