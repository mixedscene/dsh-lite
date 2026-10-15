# Chatbox Antigravity Android build

The Android host is Capacitor 7, application ID `org.chatbox.antigravity`, minimum Android 8/API 26, target/compile API 35. It loads the lite Chatbox renderer from `release/app/dist/renderer`. The APK contains the renderer and communicates with Google directly through its native plugin; no LAN chat server is required.

## Source baseline

Based on the GPLv3 public Chatbox source at commit `0ac6385ae1ff5bf778777826da3c5edcd55b61b8`. The cloud branch contains a complete source snapshot with the original license and copyright notices; unrelated history in the existing private repository is preserved.

## Cloud build

`.github/workflows/android.yml` runs on the private repository's `chatbox-antigravity` branch or by manual dispatch. The workflow uses Node 22, pnpm 10, JDK 21, Gradle 8.11.1, and Android SDK 35. Install locked JavaScript dependencies with scripts disabled, then run:

```sh
pnpm exec vitest run src/shared/providers/antigravity src/renderer/lite
pnpm exec tsc --project tsconfig.lite.json --noEmit
pnpm run mobile:build:lite
pnpm exec cap sync android
bash android/gradlew -p android testDebugUnitTest assembleDebug assembleRelease lintRelease
```

`mobile:build:lite` sets `CHATBOX_LITE=1`, `CHATBOX_BUILD_TARGET=mobile_app`, and `CHATBOX_BUILD_PLATFORM=android`. Capacitor sync creates its normal generated Gradle project references and copies web assets; generated web assets and Cordova plugin projects are ignored. The workflow uploads debug/release APKs, a Git bundle of the source, native unit reports and Android lint reports. Neither a connected device nor installation is part of the build.

Provide these existing repository secrets:

| GitHub secret | Use |
| --- | --- |
| `AGY_CLIENT_ID` | Maps to Gradle `ANTIGRAVITY_OAUTH_CLIENT_ID` |
| `AGY_CLIENT_SECRET` | Maps to Gradle `ANTIGRAVITY_OAUTH_CLIENT_SECRET` |
| `APK_KEYSTORE_BASE64` | Base64 encoding of the persistent signing keystore |
| `APK_KEYSTORE_PASSWORD` | Keystore password |
| `APK_KEY_ALIAS` | Persistent signing alias |
| `APK_KEY_PASSWORD` | Signing key password |

The runner decodes the signing keystore into its private temporary directory and sets `APK_KEYSTORE_PATH`. With these variables both debug and release artifacts use the persistent key. Release fails when signing configuration or OAuth client ID is missing; no release key is generated. `ANDROID_VERSION_CODE` and `ANDROID_VERSION_NAME` are supplied from the workflow run number. APK signatures are verified and certificate fingerprints printed after building.

OAuth values are embedded into native BuildConfig at build time. A distributed app cannot protect an embedded OAuth client secret as a server secret. Use the intended client configuration and do not put user access/refresh tokens in the build or repository. The supported callback is exactly `http://localhost:51121/oauth-callback`; OAuth configuration must permit that loopback callback. Current builds take the previously authorized baseline client settings from private GitHub secrets, without copying any prototype account tokens.

## Native bridge contract

Register `registerPlugin('Antigravity')` through `@capacitor/core`. The native plugin provides:

```ts
interface Account {
  id: string // stable Google userinfo ID, never email as primary key
  email: string
  name: string
  picture?: string
  project?: string
  modelCache?: unknown
  updatedAt: number
  reauthRequired: boolean
}
interface AntigravityPlugin {
  listAccounts(): Promise<{
    accounts: Account[]; activeAccountId?: string; oauthConfigured: boolean
    storageError?: string; oauthError?: string; oauthPending?: boolean
  }>
  addAccount(options?: { timeoutMs?: number }): Promise<{ account: Account; activeAccountId: string }>
  cancelOAuth(): Promise<void>
  switchAccount(options: { accountId: string }): Promise<{ account: Account }>
  removeAccount(options: { accountId: string }): Promise<void>
  updateAccountCache(options: { accountId: string; project?: string; modelCache?: unknown }): Promise<void>
  request(options: {
    requestId: string; accountId: string; url: string; method?: 'POST'
    headers?: Record<string, string>; body?: string; stream?: boolean
  }): Promise<{ requestId: string; status: number; headers: Record<string, string>; body?: string }>
  cancelRequest(options: { requestId: string }): Promise<void>
  importSkill(): Promise<{ name: string; content: string }>
  addListener('accountsChanged', listener: (accounts: { accounts: Account[]; activeAccountId?: string; oauthConfigured?: boolean; oauthError?: string; oauthPending?: boolean; storageError?: string }) => void): Promise<{ remove(): Promise<void> }>
  addListener('httpChunk', listener: (event: {
    requestId: string; accountId: string; chunk?: string; done?: boolean; error?: string
  }) => void): Promise<{ remove(): Promise<void> }>
}
```

Register the `httpChunk` listener before calling a streaming request. A successful streaming request resolves as soon as status/headers are known, then emits decoded UTF-8 chunks and a terminal `done: true`. Chunks can arrive before the JavaScript promise continuation runs; the transport must buffer/enqueue them immediately. Chunk boundaries preserve Unicode surrogate pairs. On cancellation/error after headers, the terminal event has `done: true` and `error`; errors before headers reject the promise. Nonstreaming and non-2xx responses return a bounded body directly. Response headers use lowercase names. Callers choose unique request IDs and filter events by both request and account ID.

## OAuth and credential behavior

The user starts add-account while the app is visible. A short-lived foreground service keeps the loopback callback available while the system browser is foreground. It binds only `127.0.0.1:51121` and, where available, `[::1]:51121`; callback URLs still use `localhost`. The service terminates on success, denial, cancellation or timeout (10–170 seconds, default 170 seconds). Port conflict and missing browser produce actionable errors. PKCE uses a fresh verifier and SHA-256/S256 challenge, with a fresh random state consumed only once. Duplicate callback parameters are rejected. A process kill abandons that sign-in; the next account listing reports `oauthError`, and the user starts a fresh attempt. Activity recreation detaches the old callback while the service may finish and persist the account. Subscribe to `accountsChanged` and refresh account listing after returning to the foreground; `oauthPending` exposes an in-progress attempt. Missed OAuth failure messages persist until the next account listing.

Tokens are stored only in native app-private preferences, encrypted by an AES-256/GCM key generated in Android Keystore with unique cipher IVs and authenticated store version. Backup and device-transfer data extraction are disabled. Token fields are excluded from every account metadata response. An unreadable ciphertext or missing key reports `storageError`; it does not silently reset accounts. Account metadata, project and model cache remain isolated by stable account ID. Switching cancels pending native requests, and removing an account cancels its requests and deletes its local encrypted record. Account removal does not call Google's remote revoke endpoint.

Refreshes serialize per account. An omitted replacement refresh token retains the existing one. A 401 triggers at most one refresh/retry before streaming starts; it does not replay a partially received stream. Repeated 401 or `invalid_grant` marks that account for reauthorization. Network workers are separate from account-control workers so multiple streams do not block switching/removal. Native requests allow only exact Google loadCodeAssist/fetchAvailableModels and streamGenerateContent endpoints over HTTPS, with redirect following disabled. Bearer authorization is supplied natively; JavaScript cannot supply it. Body/cache/response/stream sizes are bounded.

## Skills

The system document picker imports a user-selected UTF-8 text/Markdown file of at most 256 KiB, validates decoding, strips an optional BOM and rejects binary NUL content. Only the filename and text return to JavaScript; there is no filesystem path, recursive directory access or persisted file grant. The renderer owns Skill preview, enable/disable and persistence. Skills supply conversation instructions. Native requests reject nested tool declarations and function calls/responses; the plugin offers no file or shell execution API.

## Validation limits

Native offline tests cover endpoint/method allowlisting, credential-exfiltration URL rejection, callback duplicate parameters, nested model-tool rejection and safe metadata projection. Cloud lint and compilation cover Android API and release packaging. Successful cloud builds do not prove a real Google authorization, model availability, account quota or Gemini/Claude generation; those require an authorized user sign-in and live service access. Device follow-up installed and launched release 0.1.13, imported a Markdown Skill through the system document picker, then upgraded to release 0.1.14 and verified the Skill persisted and drawer safe-area layout was corrected. The Google account chooser opened in the external browser. User account selection and consent are still required; no live model discovery, Gemini/Claude generation, A→B→A account switching or token refresh is claimed as verified. Android reported an activity cold launch of 401 ms after upgrading; this does not measure renderer-ready or first-message latency. Build 38660099594 passed 54 frontend/protocol tests, 5 native boundary tests, scoped TypeScript, release lint (0 errors, 17 warnings), APK assembly and signing checks.
