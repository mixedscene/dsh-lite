import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'org.chatbox.antigravity',
  appName: 'Chatbox Antigravity',
  webDir: 'release/app/dist/renderer',
  server: { androidScheme: 'https', hostname: 'localhost' },
  android: {
    allowMixedContent: false,
    webContentsDebuggingEnabled: false,
    includePlugins: [
      '@capacitor/app',
      '@capacitor/browser',
      '@capacitor/keyboard',
      '@capacitor-community/sqlite',
      '@capacitor/splash-screen',
    ],
  },
  plugins: { CapacitorHttp: { enabled: false }, SplashScreen: { launchShowDuration: 0 } },
}
export default config
