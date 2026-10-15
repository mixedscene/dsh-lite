import type { ProviderModelInfo, ProviderOptions } from '../../types'

/**
 * Antigravity publishes one catalog entry per reasoning tier
 * ("gemini-3.8-flash-low", "-medium", "-high", "-tiered"). Listing every entry repeats the
 * same model four times in the picker, so tiers are collapsed into a single family entry
 * here and the requested level is resolved back onto a published tier id when the request
 * is built. The app already owns the reasoning control, so no capability is lost.
 */
const TIER_SUFFIXES = ['minimal', 'low', 'medium', 'high'] as const

/** Marks a family whose tier travels in the request body instead of the model id. */
const TIERED_SUFFIX = 'tiered'

export type AntigravityReasoningLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high'

/** Least to most reasoning; "off" resolves to the cheapest published tier with thoughts hidden. */
const LEVEL_ORDER: readonly Exclude<AntigravityReasoningLevel, 'off'>[] = ['minimal', 'low', 'medium', 'high']

const TIER_SUFFIX_PATTERN = new RegExp(`-(${TIER_SUFFIXES.join('|')})$`)
const TIERED_SUFFIX_PATTERN = new RegExp(`-${TIERED_SUFFIX}$`)

export interface AntigravityTierSelection {
  modelId: string
  thinkingLevel: Exclude<AntigravityReasoningLevel, 'off'>
  includeThoughts: boolean
}

/** Maps a tier id back onto its family id ("gemini-3.8-flash-high" -> "gemini-3.8-flash"). */
export function antigravityBaseModelId(modelId: string): string {
  if (TIERED_SUFFIX_PATTERN.test(modelId)) return modelId.slice(0, -TIERED_SUFFIX.length - 1)
  const match = TIER_SUFFIX_PATTERN.exec(modelId)
  return match ? modelId.slice(0, -match[0].length) : modelId
}

/** "Gemini 3.8 Flash (High)" -> "Gemini 3.8 Flash"; tiered entries reuse the raw id and are dropped. */
function familyNickname(nickname: string | undefined, modelId: string): string | undefined {
  if (!nickname || nickname === modelId) return undefined
  const stripped = nickname.replace(/\s*\((?:\w+)\)\s*$/, '').trim()
  return stripped || undefined
}

/** Collapses tier entries into one model per family, keeping the metadata each sibling knows. */
export function aggregateAntigravityModels(models: ProviderModelInfo[]): ProviderModelInfo[] {
  const aggregated: ProviderModelInfo[] = []
  const indexByFamily = new Map<string, number>()

  for (const model of models) {
    if (!model?.modelId) continue
    const familyId = antigravityBaseModelId(model.modelId)
    const existingIndex = indexByFamily.get(familyId)

    if (existingIndex === undefined) {
      indexByFamily.set(familyId, aggregated.length)
      aggregated.push({ ...model, modelId: familyId, nickname: familyNickname(model.nickname, model.modelId) })
      continue
    }

    const existing = aggregated[existingIndex]
    aggregated[existingIndex] = {
      ...existing,
      nickname: existing.nickname ?? familyNickname(model.nickname, model.modelId),
      capabilities: existing.capabilities?.length ? existing.capabilities : model.capabilities,
      contextWindow: existing.contextWindow ?? model.contextWindow,
      maxOutput: existing.maxOutput ?? model.maxOutput,
      labels: existing.labels?.length ? existing.labels : model.labels,
    }
  }

  return aggregated
}

/** Reads the discovered model ids out of the account's persisted discovery cache. */
export function antigravityModelIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const ids: string[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const modelId = (entry as { modelId?: unknown }).modelId
    if (typeof modelId === 'string' && modelId) ids.push(modelId)
  }
  return ids
}

/** Reads the reasoning level the app's reasoning control stored for this model. */
export function antigravityReasoningLevel(
  providerOptions: ProviderOptions | undefined
): AntigravityReasoningLevel | undefined {
  const thinkingConfig = providerOptions?.google?.thinkingConfig
  if (!thinkingConfig) return undefined
  if (thinkingConfig.includeThoughts === false) return 'off'
  const level = thinkingConfig.thinkingLevel
  if (level === 'minimal' || level === 'low' || level === 'medium' || level === 'high') return level
  return undefined
}

function nearestPublishedLevel(
  level: Exclude<AntigravityReasoningLevel, 'off'>,
  published: Exclude<AntigravityReasoningLevel, 'off'>[]
): Exclude<AntigravityReasoningLevel, 'off'> {
  const target = LEVEL_ORDER.indexOf(level)
  return published.reduce((best, candidate) =>
    Math.abs(LEVEL_ORDER.indexOf(candidate) - target) < Math.abs(LEVEL_ORDER.indexOf(best) - target) ? candidate : best
  )
}

/**
 * Resolves one reasoning level onto an id the family actually publishes, so an aggregated
 * family never sends an id the backend does not know. A chat pinned to a concrete tier keeps
 * it when no level was chosen, while a family id with no level resolves onto the cheapest
 * published tier. Returns null only when the family is unknown to the catalog.
 */
export function selectAntigravityTierModelId(
  modelId: string,
  level: AntigravityReasoningLevel | undefined,
  availableModelIds: readonly string[]
): AntigravityTierSelection | null {
  const familyId = antigravityBaseModelId(modelId)
  const familyIds = availableModelIds.filter((id) => antigravityBaseModelId(id) === familyId)
  if (familyIds.length === 0) return null

  const published = TIER_SUFFIXES.filter((suffix) => familyIds.includes(`${familyId}-${suffix}`))
  const tieredId = familyIds.find((id) => id === `${familyId}-${TIERED_SUFFIX}`)
  const hasTierIds = published.length > 0 || tieredId !== undefined

  const pick = (wanted: Exclude<AntigravityReasoningLevel, 'off'>): AntigravityTierSelection => {
    if (familyIds.includes(`${familyId}-${wanted}`)) {
      return { modelId: `${familyId}-${wanted}`, thinkingLevel: wanted, includeThoughts: true }
    }
    // A tiered family carries the level in the request body only.
    if (tieredId) return { modelId: tieredId, thinkingLevel: wanted, includeThoughts: true }
    // The family publishes no tier at all, so the bare id is the only id to send.
    if (!hasTierIds) return { modelId: familyId, thinkingLevel: wanted, includeThoughts: true }
    const fallback = nearestPublishedLevel(wanted, published)
    return { modelId: `${familyId}-${fallback}`, thinkingLevel: fallback, includeThoughts: true }
  }

  // No level chosen: keep a pinned tier id, but never send an aggregated family id upstream.
  if (!level) {
    if (modelId !== familyId || !hasTierIds) return null
    return pick(published.includes('low') ? 'low' : (published[0] ?? 'low'))
  }

  if (level === 'off') {
    const cheapest = published.includes('minimal') ? 'minimal' : published.includes('low') ? 'low' : published[0]
    if (!cheapest) return { modelId: tieredId ?? modelId, thinkingLevel: 'low', includeThoughts: false }
    return {
      modelId: familyIds.includes(`${familyId}-${cheapest}`) ? `${familyId}-${cheapest}` : (tieredId ?? modelId),
      thinkingLevel: cheapest,
      includeThoughts: false,
    }
  }

  return pick(level)
}
