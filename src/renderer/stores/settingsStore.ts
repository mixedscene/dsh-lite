import { featureFlags } from '@/utils/feature-flags'
import { getServiceIndependentSettingsPatch } from './serviceIndependentSettings'
import {
  type SettingsStoreState,
  selectLanguage,
  selectMcpSettings,
  selectTheme,
  useSettingsStore as useSharedSettingsStore,
} from '@chatbox/react/stores'
import type { DocumentParserConfig } from '@shared/types/settings'
import { getLogger } from '@/lib/utils'
import platform from '@/platform'
import { settingsService, settingsStore } from '@/settings-runtime'
import { mergeProviderSettings, type ProviderSettingsUpdate } from './providerSettings'

const log = getLogger('settings-store')

export { settingsService, settingsStore }

/**
 * Returns the same host-specific parser default used by Settings migrations.
 */
export function getPlatformDefaultDocumentParser(): DocumentParserConfig {
  return { type: platform.isDesktopLike ? 'local' : 'none' }
}

let initSettingsStorePromise: Promise<SettingsStoreState> | null = null

export function initSettingsStore() {
  if (!initSettingsStorePromise) {
    initSettingsStorePromise = settingsStore
      .getState()
      .hydrate()
      .then(() => {
        if (!featureFlags.chatboxAI) {
          const patch = getServiceIndependentSettingsPatch(
            settingsStore.getState().getSettings(),
            getPlatformDefaultDocumentParser()
          )
          if (Object.keys(patch).length > 0) settingsStore.getState().setSettings(patch)
          settingsStore.subscribe((state) => {
            const importedPatch = getServiceIndependentSettingsPatch(state.getSettings(), getPlatformDefaultDocumentParser())
            if (Object.keys(importedPatch).length > 0) state.setSettings(importedPatch)
          })
        }
        const state = settingsStore.getState()
        const providers = state.providers
        const providersCount =
          providers && typeof providers === 'object' && !Array.isArray(providers) ? Object.keys(providers).length : 0
        if (providersCount === 0) {
          log.info('[CONFIG_DEBUG] onFinishHydration: providersCount=0')
        }
        return state
      })
  }
  return initSettingsStorePromise
}

export function useSettingsStore<U>(selector: (state: SettingsStoreState) => U): U {
  return useSharedSettingsStore(settingsStore, selector)
}

export const useLanguage = () => useSettingsStore(selectLanguage)
export const useTheme = () => useSettingsStore(selectTheme)
export const useMcpSettings = () => useSettingsStore(selectMcpSettings)

export function useProviderSettings(providerId: string) {
  const providers = useSettingsStore((state) => state.providers)
  const providerSettings = providers?.[providerId]

  const setProviderSettings = (value: ProviderSettingsUpdate) => {
    settingsStore.setState((currentSettings) => mergeProviderSettings(currentSettings, providerId, value))
  }

  return {
    providerSettings,
    setProviderSettings,
  }
}
