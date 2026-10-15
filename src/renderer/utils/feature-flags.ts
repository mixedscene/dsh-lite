import platform from '@/platform'

export const featureFlags = {
  // This fork uses user-configured providers; retain legacy types for imported data.
  chatboxAI: false,
  mcp: platform.isDesktopLike,
  knowledgeBase: platform.isDesktopLike,
  skills: platform.isDesktopLike,
  agentMode: platform.isDesktopLike,
}
