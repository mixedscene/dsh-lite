import platform from '@/platform'

// This module sits inside Platform's own import graph
// (platform -> desktop_platform -> web_platform_utils -> packages/remote -> feature-flags),
// so reading the live `platform` binding while this module evaluates would throw
// "Cannot access 'platform' before initialization". The host-capability flags are
// therefore getters: they resolve the binding on first read, once Platform is ready.
export const featureFlags = {
  // This fork uses user-configured providers; retain legacy types for imported data.
  chatboxAI: false,
  get mcp() {
    return platform.isDesktopLike
  },
  get knowledgeBase() {
    return platform.isDesktopLike
  },
  get skills() {
    return platform.isDesktopLike
  },
  get agentMode() {
    return platform.isDesktopLike
  },
}
