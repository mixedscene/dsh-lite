import { describe, expect, it } from 'vitest'
import {
  aggregateAntigravityModels,
  antigravityBaseModelId,
  antigravityModelIds,
  antigravityReasoningLevel,
  selectAntigravityTierModelId,
} from './tier-utils'
import type { ProviderModelInfo } from '../../types'

const model = (modelId: string, nickname?: string): ProviderModelInfo => ({
  modelId,
  nickname,
  capabilities: ['reasoning'],
})

const catalog: ProviderModelInfo[] = [
  model('gemini-3.6-flash-low', 'Gemini 3.6 Flash (Low)'),
  model('gemini-3.6-flash-medium', 'Gemini 3.6 Flash (Medium)'),
  model('gemini-3.6-flash-high', 'Gemini 3.6 Flash (High)'),
  model('gemini-3.7-flash-high', 'Gemini 3.7 Flash (High)'),
  model('gemini-3.8-flash-low', 'Gemini 3.8 Flash (Low)'),
  model('gemini-3.8-flash-medium', 'Gemini 3.8 Flash (Medium)'),
  model('gemini-3.8-flash-high', 'Gemini 3.8 Flash (High)'),
  model('gemini-3.8-flash-tiered', 'gemini-3.8-flash-tiered'),
  model('claude-sonnet-4-6', 'Claude Sonnet 4.6'),
]

describe('Antigravity model tier aggregation', () => {
  it('maps every tier id onto its family id', () => {
    expect(antigravityBaseModelId('gemini-3.8-flash-high')).toBe('gemini-3.8-flash')
    expect(antigravityBaseModelId('gemini-3.8-flash-tiered')).toBe('gemini-3.8-flash')
    expect(antigravityBaseModelId('claude-sonnet-4-6')).toBe('claude-sonnet-4-6')
  })

  it('collapses each family into one picker entry', () => {
    const aggregated = aggregateAntigravityModels(catalog)

    expect(aggregated.map((entry) => entry.modelId)).toEqual([
      'gemini-3.6-flash',
      'gemini-3.7-flash',
      'gemini-3.8-flash',
      'claude-sonnet-4-6',
    ])
    // Tier labels are dropped from the family nickname so the picker reads like upstream.
    expect(aggregated[0].nickname).toBe('Gemini 3.6 Flash')
    expect(aggregated[2].nickname).toBe('Gemini 3.8 Flash')
    expect(aggregated[3].nickname).toBe('Claude Sonnet 4.6')
    expect(aggregated[0].capabilities).toEqual(['reasoning'])
  })

  it('keeps a catalog entry that already uses the family id', () => {
    const aggregated = aggregateAntigravityModels([
      model('gemini-3.9-flash', 'Gemini 3.9 Flash'),
      model('gemini-3.9-flash-high', 'Gemini 3.9 Flash (High)'),
    ])

    expect(aggregated).toHaveLength(1)
    expect(aggregated[0].modelId).toBe('gemini-3.9-flash')
    expect(aggregated[0].nickname).toBe('Gemini 3.9 Flash')
  })

  it('reads model ids from the persisted account cache defensively', () => {
    expect(antigravityModelIds([{ modelId: 'a' }, { modelId: 'b' }, { nickname: 'c' }, null, 'd'])).toEqual(['a', 'b'])
    expect(antigravityModelIds(undefined)).toEqual([])
    expect(antigravityModelIds({ models: [] })).toEqual([])
  })
})

describe('Antigravity reasoning level selection', () => {
  const ids = catalog.map((entry) => entry.modelId)

  it('resolves the requested level onto a published tier id', () => {
    expect(selectAntigravityTierModelId('gemini-3.8-flash', 'low', ids)).toEqual({
      modelId: 'gemini-3.8-flash-low',
      thinkingLevel: 'low',
      includeThoughts: true,
    })
    expect(selectAntigravityTierModelId('gemini-3.8-flash', 'high', ids)).toEqual({
      modelId: 'gemini-3.8-flash-high',
      thinkingLevel: 'high',
      includeThoughts: true,
    })
  })

  it('carries the level in the body for a level the family only publishes as tiered', () => {
    expect(selectAntigravityTierModelId('gemini-3.8-flash', 'minimal', ids)).toEqual({
      modelId: 'gemini-3.8-flash-tiered',
      thinkingLevel: 'minimal',
      includeThoughts: true,
    })
  })

  it('turns reasoning off by hiding thoughts on the cheapest published tier', () => {
    expect(selectAntigravityTierModelId('gemini-3.8-flash', 'off', ids)).toEqual({
      modelId: 'gemini-3.8-flash-low',
      thinkingLevel: 'low',
      includeThoughts: false,
    })
  })

  it('degrades to the closest tier the family publishes', () => {
    // 3.7 only publishes "high"; a medium request must still resolve to a real id.
    expect(selectAntigravityTierModelId('gemini-3.7-flash', 'medium', ids)?.modelId).toBe('gemini-3.7-flash-high')
  })

  it('keeps a pinned id when no level was chosen', () => {
    expect(selectAntigravityTierModelId('gemini-3.6-flash-medium', undefined, ids)).toBeNull()
    expect(selectAntigravityTierModelId('gemini-3.6-flash-medium', 'high', ids)?.modelId).toBe('gemini-3.6-flash-high')
  })

  it('resolves an aggregated family id when no level was chosen', () => {
    // The picker only offers the family id, so it must still land on a published tier.
    expect(selectAntigravityTierModelId('gemini-3.8-flash', undefined, ids)).toEqual({
      modelId: 'gemini-3.8-flash-low',
      thinkingLevel: 'low',
      includeThoughts: true,
    })
  })

  it('sends the bare id when the family publishes no tier of its own', () => {
    expect(selectAntigravityTierModelId('gemini-3.9-flash', 'high', ['gemini-3.9-flash'])).toEqual({
      modelId: 'gemini-3.9-flash',
      thinkingLevel: 'high',
      includeThoughts: true,
    })
  })

  it('reports an unknown family instead of inventing an id', () => {
    expect(selectAntigravityTierModelId('gemini-9-flash', 'high', ids)).toBeNull()
  })

  it('derives the level from the reasoning control provider options', () => {
    expect(
      antigravityReasoningLevel({ google: { thinkingConfig: { thinkingLevel: 'high', includeThoughts: true } } })
    ).toBe('high')
    expect(
      antigravityReasoningLevel({ google: { thinkingConfig: { thinkingLevel: 'high', includeThoughts: false } } })
    ).toBe('off')
    // Thoughts requested without a level: the app left the level at its default, so nothing maps.
    expect(antigravityReasoningLevel({ google: { thinkingConfig: { includeThoughts: true } } })).toBeUndefined()
    expect(antigravityReasoningLevel(undefined)).toBeUndefined()
  })
})
