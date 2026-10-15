export const WEB_SEARCH_PROVIDERS = [
  { value: 'bing', label: 'Bing Search' },
  { value: 'tavily', label: 'Tavily' },
  { value: 'bocha', label: 'BoCha' },
  { value: 'querit', label: 'Querit' },
  { value: 'searxng', label: 'SearXNG' },
] as const

// Keep the legacy value readable for old settings; the proprietary option is not exposed in the UI.
export type WebSearchProviderValue = (typeof WEB_SEARCH_PROVIDERS)[number]['value'] | 'build-in'
