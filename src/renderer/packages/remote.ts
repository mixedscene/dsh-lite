import { SystemProviders } from '@shared/defaults'
import { ModelProviderEnum } from '@shared/types'
import { z } from 'zod'
import type { ClaimedAgentModeReward } from '@/packages/agent-mode-reward'
import platform from '@/platform'
import { apiRequest } from '@/utils/request'
import type {
  ChatboxAILicenseDetail,
  ChatboxAIPlanType,
  Config,
  CopilotDetail,
  ModelProvider,
  ProviderModelInfo,
  RemoteConfig,
  SessionRagConfig,
  Settings,
} from '../../shared/types'
import { getProviderModelsFromRegistry } from './model-registry/enrich'

const SERVICE_UNAVAILABLE = 'This service is unavailable. Configure a model provider in Settings.'
function unavailable(): never {
  throw new Error(SERVICE_UNAVAILABLE)
}

// Compatibility values for disabled UI that still renders links. No service origin.

export function getAPIOrigin(): string {
  return 'about:blank'
}

export function getChatboxOrigin(): string {
  return 'about:blank'
}

export function buildChatboxUrl(path: string): string {
  return `about:blank#${encodeURIComponent(path)}`
}

export async function checkNeedUpdate(version: string, os: string, config: Config, settings: Settings): Promise<boolean> {
  return false
}

export async function listCopilotTags(lang: string): Promise<string[]> {
  return []
}

export async function listCopilotsByCursor(
  lang: string,
  filters?: { limit?: number; cursor?: string; tag?: string; search?: string }
): Promise<{ data: CopilotDetail[]; next_cursor: string | null }> {
  return { data: [], next_cursor: null }
}

export async function recordCopilotUsage(params: {
  id: string
  action: 'create_session' | 'create_thread' | 'create_message' | 'use_copilot'
}): Promise<void> {}

export async function recordCopilotShare(detail: CopilotDetail): Promise<void> {}

export async function getPremiumPrice(): Promise<{ price: number; discount: number; discountLabel: string }> {
  return unavailable()
}

export async function getRemoteConfig(config: keyof RemoteConfig): Promise<RemoteConfig> {
  return { setting_chatboxai_first: false, current_version: await platform.getVersion(), product_ids: [] }
}

export async function getSessionRagConfig(params?: { licenseKey?: string }): Promise<SessionRagConfig> {
  return {
    models: { embedding: '', rerank: '' },
    capabilities: { session_attachment_embedding: false, session_attachment_rerank: false },
  }
}

export function invalidateSessionRagConfigCache(licenseKey?: string): void {}

export interface DialogConfig {
  markdown: string
  buttons: { label: string; url: string }[]
}

export async function getDialogConfig(params: { uuid: string; language: string; version: string }): Promise<DialogConfig | null> {
  return null
}

export async function getLicenseDetail(params: { licenseKey: string }): Promise<ChatboxAILicenseDetail | null> {
  return null
}

export interface LicenseDetailError {
  code: string
  detail: string
  status: number
  title: string
}

export interface LicenseDetailResponse {
  data: ChatboxAILicenseDetail | null
  error?: LicenseDetailError
}

export async function getLicenseDetailRealtime(params: { licenseKey: string }): Promise<LicenseDetailResponse> {
  return { data: null }
}

export async function generateUploadUrl(params: { licenseKey: string; filename: string }): Promise<{ url: string; filename: string }> {
  return unavailable()
}

export async function createUserFile<T extends boolean>(params: {
  licenseKey: string
  filename: string
  filetype: string
  returnContent: T
}): Promise<{ uuid: string; content: T extends true ? string : undefined }> {
  return unavailable()
}

export async function uploadAndCreateUserFile(licenseKey: string, file: File): Promise<string> {
  return unavailable()
}

export async function parseUserLinkPro(params: {
  licenseKey: string
  url: string
  abortSignal?: AbortSignal
}): Promise<{ key: string; title: string; storageKey: string }> {
  return unavailable()
}

// Shared by local attachments and third party web tools. Preserve native transport
// for mobile/desktop and fetch only the requested webpage, without a hosted parser.

export async function parseUserLinkFree(params: { url: string }): Promise<{ title: string; text: string }> {
  const target = new URL(params.url)
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Unsupported webpage URL')
  const response = await apiRequest.get(
    target.toString(),
    { Accept: 'text/html, text/plain' },
    { useProxy: platform.type === 'mobile' || platform.type === 'desktop' }
  )
  const content = await response.text()
  if (response.headers.get('content-type')?.includes('text/html')) {
    const document = new DOMParser().parseFromString(content, 'text/html')
    document.querySelectorAll('script, style, noscript, iframe').forEach((node) => node.remove())
    return { title: document.title || params.url, text: document.body?.textContent?.trim() || '' }
  }
  return { title: params.url, text: content }
}

export async function getChatboxWebSearchRequestOptions(): Promise<{
  chatboxApiOrigin: string
  fetchFn: typeof fetch
  headers: Record<string, string>
}> {
  return unavailable()
}

export async function activateLicense(params: { licenseKey: string; instanceName: string }): Promise<{
  valid: boolean
  instanceId: string
  error: string
}> {
  return unavailable()
}

export async function deactivateLicense(params: { licenseKey: string; instanceId: string }): Promise<void> {
  return unavailable()
}

export async function validateLicense(params: { licenseKey: string; instanceId: string }): Promise<{ valid: boolean }> {
  // Unavailability must not invalidate or delete a stored license.
  return unavailable()
}

const RemoteModelInfoSchema = z.object({
  modelId: z.string(),
  modelName: z.string(),
  labels: z.array(z.string()).optional(),
  type: z.enum(['chat', 'embedding', 'rerank', 'image']).optional(),
  apiStyle: z.enum(['google', 'openai', 'openai-responses', 'anthropic']).optional(),
  contextWindow: z.number().optional(),
  capabilities: z.array(z.enum(['vision', 'tool_use', 'reasoning'])).optional(),
})

export type RemoteModelInfo = z.infer<typeof RemoteModelInfoSchema>

export async function getModelManifest(params: { aiProvider: ModelProvider; licenseKey?: string; language?: string }) {
  if (params.aiProvider === ModelProviderEnum.ChatboxAI) {
    return { groupName: '', models: [] as RemoteModelInfo[], imageModels: [] as RemoteModelInfo[] }
  }
  // Lazy access avoids a platform/settings initialization cycle.
  const { settingsStore } = await import('@/stores/settingsStore')
  const settings = settingsStore.getState()
  const provider = SystemProviders().find((item) => item.id === params.aiProvider)
    || settings.customProviders?.find((item) => item.id === params.aiProvider)
  const localModels = new Map<string, ProviderModelInfo>()
  for (const model of [
    ...getProviderModelsFromRegistry(params.aiProvider),
    ...(provider?.defaultSettings?.models || []),
    ...(settings.providers?.[params.aiProvider]?.models || []),
  ]) {
    localModels.set(model.modelId, { ...localModels.get(model.modelId), ...model })
  }
  const models: RemoteModelInfo[] = [...localModels.values()].flatMap((model) => {
    const result = RemoteModelInfoSchema.safeParse({
      modelId: model.modelId,
      modelName: model.nickname || model.modelId,
      labels: model.labels,
      type: model.type,
      apiStyle: model.apiStyle,
      contextWindow: model.contextWindow,
      capabilities: model.capabilities?.filter(
        (capability) => capability === 'vision' || capability === 'reasoning' || capability === 'tool_use'
      ),
    })
    return result.success ? [result.data] : []
  })
  // Keep image creation available without the proprietary catalog endpoint.
  const imageIds = params.aiProvider === ModelProviderEnum.OpenAI
    ? ['gpt-image-1', 'gpt-image-1.5', 'gpt-image-2', 'dall-e-3']
    : params.aiProvider === ModelProviderEnum.Gemini
      ? ['gemini-2.5-flash-image', 'gemini-3-pro-image-preview', 'gemini-3.1-flash-image-preview']
      : []
  const imageModels = new Map<string, RemoteModelInfo>(
    imageIds.map((modelId) => [modelId, { modelId, modelName: modelId, type: 'image' }])
  )
  for (const model of models) {
    if (model.type === 'image') imageModels.set(model.modelId, model)
  }
  return { groupName: provider?.name || params.aiProvider, models, imageModels: [...imageModels.values()] }
}

type ChatboxAIModelInfo = RemoteModelInfo & {
  costLevel: string
  description: string
  access: { available: boolean }
  pricing?: {
    tokensPerComputePoint: number
    officialInput: number
    officialOutput: number
    tieredPricing: Array<{
      max_input_tokens: number
      max_output_tokens: number
      price_input: number
      price_output: number
    }>
  }
}

export type ChatboxAIModelList = {
  provider: { id: string; name: string }
  license: { plan: string }
  groups: Array<{ id: string; modelIds: string[]; featuredModelIds?: string[] }>
  models: Record<string, ChatboxAIModelInfo>
  imageModels: RemoteModelInfo[]
  links?: { modelPricing?: string; upgrade?: string }
  [key: string]: unknown
}

export async function getChatboxAIModelList(params: { licenseKey?: string; language?: string }): Promise<ChatboxAIModelList> {
  return {
    provider: { id: ModelProviderEnum.ChatboxAI, name: '' },
    license: { plan: 'unknown' },
    groups: [],
    models: {},
    imageModels: [],
  }
}

export async function reportContent(params: { id: string; type: string; details: string }): Promise<void> {}

export async function getProviderModelsInfo(params: { modelIds: string[] }): Promise<Record<string, ProviderModelInfo | null>> {
  return {}
}

export async function requestLoginTicketId(): Promise<string> {
  return unavailable()
}

export async function sendEmailLoginCode(params: { email: string; lang?: string }): Promise<string> {
  return unavailable()
}

type AuthTokens = { accessToken: string; refreshToken: string }

export async function loginOrSignupWithEmailCode(params: { email: string; code: string }): Promise<AuthTokens> {
  return unavailable()
}

export async function getWebAuthToken(): Promise<string> {
  return unavailable()
}

export async function checkLoginStatus(ticketId: string): Promise<{
  status: 'pending' | 'success' | 'rejected'
  accessToken: string | null
  refreshToken: string | null
}> {
  return { status: 'rejected', accessToken: null, refreshToken: null }
}

export async function refreshAccessToken(params: { refreshToken: string }): Promise<AuthTokens> {
  return unavailable()
}

export async function getUserProfile(): Promise<{ email: string; id: string; created_at: string }> {
  return unavailable()
}

export async function issueVibedropKey(): Promise<{ vdKey: string; tier: string }> {
  return unavailable()
}

export interface UserLicense {
  id: number
  key: string
  status: string
  platform: string
  product_name: string
  plan?: ChatboxAIPlanType
  payment_type: string
  image_usage: number
  unified_token_usage: number
  unified_token_limit: number
  unified_token_usage_details: Array<{
    type: string
    token_usage: number
    token_limit: number
  }>
  image_limit: number
  next_token_refresh_at: string
  expires_at: string
  created_at: string
  recurring_canceled: boolean
  quota_packs: unknown[]
}

export async function listLicensesByUser(): Promise<UserLicense[]> {
  return []
}

export async function claimFreeAgentModeReward(licenseKey: string): Promise<ClaimedAgentModeReward> {
  return unavailable()
}

export interface ImageCompletionRequest {
  model: string
  prompt: string
  response_format: 'b64_json'
  style?: string
  aspect_ratio?: string
  quantity?: number
  images?: Array<{ image_url: string }>
}

export type ImageGenerationItem = {
  uuid: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  created_at: string
  image_url?: string
  thumbnail_url?: string
  generated_at?: string
  error_code?: string
  error_message?: string
}

export type ImageGenerationTaskResponse = {
  items: ImageGenerationItem[]
  is_finished: boolean
  task_id: string
}

export async function submitImageGeneration(
  params: ImageCompletionRequest,
  licenseKey: string
): Promise<ImageGenerationTaskResponse> {
  return unavailable()
}

export async function pollImageTask(
  taskId: string,
  licenseKey: string,
  signal?: AbortSignal
): Promise<ImageGenerationTaskResponse> {
  return unavailable()
}

export const IMAGE_GENERATION_POLL_INTERVAL_MS = 2000

export async function pollTaskUntilComplete(
  taskId: string,
  licenseKey: string,
  options?: { signal?: AbortSignal; onPoll?: (response: ImageGenerationTaskResponse) => void }
): Promise<ImageGenerationTaskResponse> {
  if (options?.signal?.aborted) throw new DOMException('Polling aborted', 'AbortError')
  return unavailable()
}
