import type { DocumentParserConfig, Settings } from '@shared/types/settings'

/** Preserve imported credentials/history while disabling unavailable service selections. */
export function getServiceIndependentSettingsPatch(
  settings: Settings,
  documentParserDefault: DocumentParserConfig
): Partial<Settings> {
  const patch: Partial<Settings> = {}
  for (const key of [
    'defaultChatModel',
    'threadNamingModel',
    'searchTermConstructionModel',
    'ocrModel',
    'defaultEmbeddingModel',
    'defaultRerankModel',
  ] as const) {
    if (settings[key]?.provider === 'chatbox-ai') patch[key] = undefined
  }
  const extension = settings.extension
  if (extension.webSearch.provider === 'build-in' || !extension.documentParser || extension.documentParser.type === 'chatbox-ai') {
    patch.extension = {
      ...extension,
      webSearch: {
        ...extension.webSearch,
        provider: extension.webSearch.provider === 'build-in' ? 'bing' : extension.webSearch.provider,
      },
      documentParser: !extension.documentParser || extension.documentParser.type === 'chatbox-ai'
        ? { ...extension.documentParser, ...documentParserDefault }
        : extension.documentParser,
    }
  }
  if (settings.mcp.enabledBuiltinServers.length) {
    patch.mcp = { ...settings.mcp, enabledBuiltinServers: [] }
  }
  if (settings.favoritedModels?.some((model) => model.provider === 'chatbox-ai')) {
    patch.favoritedModels = settings.favoritedModels.filter((model) => model.provider !== 'chatbox-ai')
  }
  return patch
}
