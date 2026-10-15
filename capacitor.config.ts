import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'org.chatbox.antigravity',
  appName: 'Chatbox Antigravity',
  webDir: 'release/app/dist/renderer',
  server: { androidScheme: 'https', hostname: 'localhost' },
  android: {
    allowMixedContent: false,
    adjustMarginsForEdgeToEdge: 'auto',
    webContentsDebuggingEnabled: false,
    includePlugins: [
      '@capacitor/app',
      '@capacitor/browser',
      '@capacitor/app-launcher',
      '@capacitor/device',
      '@capacitor/filesystem',
      '@capacitor/haptics',
      '@capacitor/share',
      '@capacitor/toast',
      'capacitor-plugin-safe-area',
      '@capacitor/keyboard',
      '@capacitor-community/sqlite',
      '@capacitor/splash-screen',
      'capacitor-stream-http',
    ],
  },
  plugins: { CapacitorHttp: { enabled: false }, SplashScreen: { launchShowDuration: 0 } },
}
export default config
