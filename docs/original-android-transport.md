# Original renderer Android transport

The original renderer uses its existing custom OpenAI provider settings for both Chat Completions and Responses. On Android, `handleMobileRequest` delegates all requests to `HttpTransport`, including model discovery, JSON results, streaming responses, and multipart bodies. It does not infer the protocol from the URL or rewrite SSE frames.

## Native contract

- `HttpTransport.request` takes a JavaScript-generated `requestId`, exact URL, method, explicit headers, and optional base64 body. The promise resolves with actual upstream status and headers as soon as headers arrive.
- A listener is installed before the native request starts. `httpData` events carry the request ID and raw base64 bytes, a final `done`, or a transport `error`. Raw bytes preserve UTF-8 boundaries and all SSE fields for the existing SDK parser.
- HTTP errors (including 401, 429, and 5xx) remain ordinary responses with their original JSON/text body and headers. Network failures reject before headers or error the response body after headers.
- AbortSignal cancellation and response reader cancellation disconnect the native connection and remove JavaScript listeners. Requests are never retried or replayed by this transport.
- User-configured HTTP and HTTPS URLs, custom path prefixes, and query strings are accepted. Embedded URL credentials, fragments, unsupported methods, header injection, and caller overrides of connection-managed headers are rejected.
- Redirects are returned to the caller without following them. Configure the final relay endpoint to avoid sending an explicitly configured API key to another origin.

## Credential separation

The generic transport has no account store, Google access token, or refresh-token access. Only the provider's explicit request headers carry API credentials. Existing `AntigravityPlugin`, `NativeHttp`, OAuth service, credential storage, Google host/method allowlist, and signing configuration are preserved. Permitting explicit HTTP for LAN/localhost relays does not loosen that Google-only native allowlist.

Android permits cleartext at the application layer for explicitly configured HTTP relays; the WebView still uses a local HTTPS origin with mixed content disabled. HTTP provides no TLS protection for the endpoint's configured key or traffic.

## Original native features

Android includes the twelve supported installed plugins used by the original renderer: App, Browser, AppLauncher, Device, Filesystem, Haptics, Share, Toast, SafeArea, Keyboard, community SQLite, and SplashScreen. The separate app-local transport replaces the Android role of `capacitor-stream-http`; the legacy stream wrapper remains for iOS.

`DocumentSaver` restores the original export fallback through Android's system create-document picker. Sources are restricted to existing canonical files inside the app cache, including URI and absolute-path forms. The app declares its nonexported FileProvider for Share and version-limited legacy storage permissions. No account-store files are exportable through DocumentSaver.

Capacitor's `adjustMarginsForEdgeToEdge: auto` consumes system-bar/cutout insets and applies native WebView margins on enforced Android 15+ edge-to-edge windows. Do not additionally initialize the iOS CSS SafeArea adapter on Android, which would add duplicate insets.

## Limits and verification

Requests are buffered for the Capacitor bridge and limited to 32 MiB. Unread JavaScript response data is bounded to 32 MiB; normal streaming readers consume chunks continuously. Native execution has four worker slots, at most 32 pending/running requests, a 30-second connect timeout, and a 120-second read-idle timeout. Native events do not provide end-to-end reader backpressure. Upload streaming and transparent redirect following are not implemented.

CI should run the existing Vitest suites plus `src/renderer/native/http-transport.test.ts` and `src/renderer/utils/mobile-request.test.ts`, and Android `:app:testDebugUnitTest` (including `RelayHttpTest`, `DocumentSaverTest`, and existing `NativeBoundaryTest`). Regressions cover actual status/error headers and JSON, Unicode/SSE byte fidelity, early events, concurrent stream isolation, cancellation races, multipart serialization, HTTP LAN/loopback, redirects, cache export confinement, and preserved Google HTTPS restrictions.

No local dependency downloads or builds were performed for this change. Cloud compilation/tests and an installed-device check remain necessary, including Google login reuse, custom Chat Completions and Responses streams, cancellation, file save/share, Android 15 system bars, rotation, and keyboard resizing. Use a temporary local relay with test-only credentials for protocol checks.
