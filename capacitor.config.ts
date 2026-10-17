import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'org.chatbox.antigravity',
  appName: 'Antigravity',
  webDir: 'release/app/dist/renderer',
  server: { androidScheme: 'https', hostname: 'localhost' },
  android: {
    allowMixedContent: false,
    // Capacitor's edge-to-edge handler only reserves the system bars and consumes the
    // window insets, so the IME never reaches the WebView and the input box stays hidden
    // behind the keyboard on Android 15+. MainActivity installs an equivalent handler
    // that also accounts for the IME.
    adjustMarginsForEdgeToEdge: 'disable',
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
