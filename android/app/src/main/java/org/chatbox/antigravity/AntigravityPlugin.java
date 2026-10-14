package org.chatbox.antigravity;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.*;
import com.getcapacitor.annotation.*;
import org.json.*;
import java.io.*;
import java.net.*;
import java.nio.ByteBuffer;
import java.nio.charset.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

@CapacitorPlugin(name = "Antigravity")
public final class AntigravityPlugin extends Plugin {
    private final ExecutorService workers = Executors.newFixedThreadPool(2);
    private final ExecutorService network = Executors.newFixedThreadPool(4);
    private final ConcurrentHashMap<String, Object> refreshLocks = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Request> requests = new ConcurrentHashMap<>();
    private final Object requestLock = new Object();
    private final AtomicBoolean pickerBusy = new AtomicBoolean();
    private AccountStore store;
    private Runnable accountObserver;
    private final AtomicBoolean destroyed = new AtomicBoolean();
    private PluginCall oauthCall;
    private OAuthService.Result oauthResult;
    @Override public void load() {
        store = new AccountStore(getContext());
        accountObserver = () -> {
            if (destroyed.get()) return;
            executeAccountEvent();
        };
        OAuthService.observe(accountObserver);
    }
    private void executeAccountEvent() {
        workers.execute(() -> {
            if (destroyed.get()) return;
            try { notifyListeners("accountsChanged", JSObject.fromJSONObject(store.list(false)).put("oauthConfigured", !BuildConfig.OAUTH_CLIENT_ID.isEmpty()), true); }
            catch (Exception e) { notifyListeners("accountsChanged", new JSObject().put("storageError", error(e)), true); }
        });
    }
    private static String required(PluginCall call, String key) {
        String value = call.getString(key); if (value == null || value.isEmpty()) throw new IllegalArgumentException(key + " is required."); return value;
    }
    private interface Work { void run() throws Exception; }
    private void execute(PluginCall call, Work work) {
        workers.execute(() -> { try { work.run(); } catch (Exception e) { call.reject(error(e)); } });
    }
    private static String error(Exception e) {
        if (e instanceof IllegalArgumentException || e instanceof IllegalStateException || e instanceof NativeHttp.ReauthException) return e.getMessage();
        return "Native request failed. Check network access and try again.";
    }
    @PluginMethod public void listAccounts(PluginCall call) {
        execute(call, () -> {
            try { call.resolve(JSObject.fromJSONObject(store.list()).put("oauthConfigured", !BuildConfig.OAUTH_CLIENT_ID.isEmpty())); }
            catch (IllegalStateException e) { call.resolve(new JSObject().put("accounts", new JSArray()).put("storageError", e.getMessage()).put("oauthConfigured", !BuildConfig.OAUTH_CLIENT_ID.isEmpty())); }
        });
    }
    @PluginMethod public void addAccount(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                if (oauthCall != null) throw new IllegalStateException("Google sign-in is already in progress.");
                oauthCall = call;
                oauthResult = (account, failure) -> {
                    oauthCall = null; oauthResult = null;
                    if (failure != null) call.reject(failure);
                    else {
                        cancelAll();
                        call.resolve(new JSObject().put("account", account).put("activeAccountId", account.optString("id")));
                    }
                };
                OAuthService.begin(getContext(), call.getLong("timeoutMs", 170000L), oauthResult);
            } catch (Exception e) { oauthCall = null; oauthResult = null; call.reject(error(e)); }
        });
    }
    @PluginMethod public void cancelOAuth(PluginCall call) { OAuthService.cancel(); call.resolve(); }
    @PluginMethod public void switchAccount(PluginCall call) {
        execute(call, () -> { synchronized (requestLock) { JSONObject account = store.activate(required(call, "accountId")); cancelAll(); call.resolve(new JSObject().put("account", account)); } });
    }
    @PluginMethod public void removeAccount(PluginCall call) {
        execute(call, () -> { synchronized (requestLock) {
            String id = required(call, "accountId");
            for (Request request : requests.values()) if (id.equals(request.accountId)) request.cancel();
            store.remove(id); call.resolve();
        } });
    }
    @PluginMethod public void updateAccountCache(PluginCall call) {
        execute(call, () -> {
            Object models = call.getData().opt("modelCache");
            if (models != null && models.toString().getBytes(StandardCharsets.UTF_8).length > 2097152) throw new IllegalArgumentException("Model cache exceeds 2 MiB.");
            store.cache(required(call, "accountId"), call.getString("project"), models); call.resolve();
        });
    }
    private String token(String id, String rejectedToken) throws Exception {
        synchronized (refreshLocks.computeIfAbsent(id, ignored -> new Object())) {
            JSONObject account = store.get(id);
            if (account.optBoolean("reauthRequired")) throw new NativeHttp.ReauthException();
            String current = account.optString("accessToken");
            if (!current.isEmpty() && account.optLong("expiresAt") > System.currentTimeMillis() + 60000
                && (rejectedToken == null || !rejectedToken.equals(current))) return current;
            String refresh = account.optString("refreshToken");
            if (refresh.isEmpty()) { store.reauth(id); throw new NativeHttp.ReauthException(); }
            try {
                JSONObject updated = NativeHttp.token("grant_type=refresh_token&refresh_token=" + NativeHttp.enc(refresh)
                    + "&client_id=" + NativeHttp.enc(BuildConfig.OAUTH_CLIENT_ID) + "&client_secret=" + NativeHttp.enc(BuildConfig.OAUTH_CLIENT_SECRET));
                store.refreshed(id, updated); return store.get(id).getString("accessToken");
            } catch (NativeHttp.ReauthException e) { store.reauth(id); throw e; }
        }
    }
    static void allowed(String url, String method) throws Exception {
        URI uri = new URI(url);
        if (!"https".equals(uri.getScheme()) || uri.getUserInfo() != null || uri.getFragment() != null || (uri.getPort() != -1 && uri.getPort() != 443)) throw new IllegalArgumentException("Only approved Google HTTPS endpoints are allowed.");
        String host = uri.getHost(), path = uri.getRawPath(), query = uri.getRawQuery();
        boolean discovery = "cloudcode-pa.googleapis.com".equals(host) && ("/v1internal:loadCodeAssist".equals(path) || "/v1internal:fetchAvailableModels".equals(path)) && query == null;
        boolean generation = ("daily-cloudcode-pa.googleapis.com".equals(host) || "cloudcode-pa.googleapis.com".equals(host)) && "/v1internal:streamGenerateContent".equals(path) && "alt=sse".equals(query);
        if ((!discovery && !generation) || !"POST".equals(method)) throw new IllegalArgumentException("This Google endpoint or method is not allowed.");
    }
    static void noTools(Object value) throws Exception {
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value; Iterator<String> keys = object.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                if (Arrays.asList("tools", "toolConfig", "tool_config", "functionDeclarations", "function_declarations", "functionCall", "functionResponse").contains(key)) throw new IllegalArgumentException("This app supports conversation instructions only; model tools are disabled.");
                noTools(object.get(key));
            }
        } else if (value instanceof JSONArray) { JSONArray array = (JSONArray) value; for (int i = 0; i < array.length(); i++) noTools(array.get(i)); }
    }
    @PluginMethod public void request(PluginCall call) {
        try {
            String id = required(call, "requestId"), accountId = required(call, "accountId"), url = required(call, "url"), method = call.getString("method", "POST");
            if (id.length() > 128) throw new IllegalArgumentException("requestId is too long."); allowed(url, method);
            String body = call.getString("body", "{}");
            if (body.getBytes(StandardCharsets.UTF_8).length > 8388608) throw new IllegalArgumentException("Request body exceeds 8 MiB.");
            noTools(new JSONObject(body));
            Request request = new Request(id, accountId, call, url, body, call.getBoolean("stream", false), call.getObject("headers", new JSObject()));
            synchronized (requestLock) {
                store.get(accountId);
                if (requests.size() >= 32) throw new IllegalStateException("Too many requests are queued. Cancel pending requests and retry.");
                if (requests.putIfAbsent(id, request) != null) throw new IllegalArgumentException("requestId is already in use.");
                network.execute(request::run);
            }
        } catch (Exception e) { call.reject(error(e)); }
    }
    @PluginMethod public void cancelRequest(PluginCall call) {
        String id = call.getString("requestId"); Request request = id == null ? null : requests.get(id); if (request != null) request.cancel(); call.resolve();
    }
    private void cancelAll() { synchronized (requestLock) { for (Request request : requests.values()) request.cancel(); } }
    private final class Request {
        final String id, accountId, url, body; final PluginCall call; final boolean stream; final JSObject headers;
        final AtomicBoolean cancelled = new AtomicBoolean(), responseSettled = new AtomicBoolean(), streamEnded = new AtomicBoolean();
        volatile HttpURLConnection connection; volatile InputStream input; volatile boolean resolved;
        Request(String id, String accountId, PluginCall call, String url, String body, boolean stream, JSObject headers) {
            this.id = id; this.accountId = accountId; this.call = call; this.url = url; this.body = body; this.stream = stream; this.headers = headers;
        }
        void cancel() {
            cancelled.set(true);
            if (responseSettled.compareAndSet(false, true)) call.reject("Request cancelled.");
            else if (resolved && stream) emit(null, true, "Request cancelled.");
            HttpURLConnection active = connection; if (active != null) active.disconnect();
            InputStream source = input; if (source != null) try { source.close(); } catch (IOException ignored) { }
        }
        void check() throws IOException { if (cancelled.get()) throw new IOException("Request cancelled."); }
        void emit(String chunk, boolean done, String failure) {
            if (done && !streamEnded.compareAndSet(false, true)) return;
            if (!done && (streamEnded.get() || cancelled.get())) return;
            JSObject event = new JSObject().put("requestId", id).put("accountId", accountId);
            if (chunk != null) event.put("chunk", chunk); if (done) event.put("done", true); if (failure != null) event.put("error", failure);
            notifyListeners("httpChunk", event);
        }
        void run() {
            try {
                check(); String access = token(accountId, null); check();
                int status = 0;
                for (int attempt = 0; attempt < 2; attempt++) {
                    connection = NativeHttp.open(url); check(); connection.setRequestMethod("POST"); connection.setDoOutput(true);
                    connection.setRequestProperty("Content-Type", "application/json"); connection.setRequestProperty("Accept", stream ? "text/event-stream" : "application/json");
                    Iterator<String> keys = headers.keys();
                    while (keys.hasNext()) {
                        String key = keys.next(), value = headers.optString(key);
                        if (!Arrays.asList("content-type", "accept", "user-agent", "x-goog-api-client").contains(key.toLowerCase(Locale.ROOT))) throw new IllegalArgumentException("Header is not allowed: " + key);
                        if (value.length() > 512 || value.indexOf('\r') >= 0 || value.indexOf('\n') >= 0) throw new IllegalArgumentException("Invalid request header.");
                        connection.setRequestProperty(key, value);
                    }
                    connection.setRequestProperty("Authorization", "Bearer " + access);
                    byte[] bytes = body.getBytes(StandardCharsets.UTF_8); connection.setFixedLengthStreamingMode(bytes.length);
                    try (OutputStream output = connection.getOutputStream()) { check(); output.write(bytes); }
                    check(); status = connection.getResponseCode(); check();
                    if (status != 401 || attempt == 1) break;
                    connection.disconnect(); connection = null; access = token(accountId, access); check();
                }
                if (status == 401) store.reauth(accountId);
                JSObject responseHeaders = new JSObject();
                for (Map.Entry<String, List<String>> header : connection.getHeaderFields().entrySet())
                    if (header.getKey() != null) responseHeaders.put(header.getKey().toLowerCase(Locale.ROOT), String.join(", ", header.getValue()));
                JSObject result = new JSObject().put("requestId", id).put("status", status).put("headers", responseHeaders);
                input = status >= 400 ? connection.getErrorStream() : connection.getInputStream(); check();
                if (!stream || status < 200 || status >= 300) {
                    String text = NativeHttp.read(input, 4194304); check();
                    if (responseSettled.compareAndSet(false, true)) { resolved = true; call.resolve(result.put("body", text)); }
                    return;
                }
                if (!responseSettled.compareAndSet(false, true)) return;
                resolved = true; call.resolve(result);
                if (input != null) {
                    try (Reader reader = new InputStreamReader(input, StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT))) {
                        char[] buffer = new char[4096]; int count; long total = 0; String carry = "";
                        while ((count = reader.read(buffer)) != -1) {
                            check(); total += count * 2L; if (total > 16777216) throw new IllegalArgumentException("Stream exceeds 16 MiB.");
                            String chunk = carry + new String(buffer, 0, count); carry = "";
                            if (!chunk.isEmpty() && Character.isHighSurrogate(chunk.charAt(chunk.length() - 1))) {
                                carry = chunk.substring(chunk.length() - 1); chunk = chunk.substring(0, chunk.length() - 1);
                            }
                            if (!chunk.isEmpty()) emit(chunk, false, null);
                        }
                        if (!carry.isEmpty()) throw new IllegalArgumentException("Stream ended in an incomplete Unicode character.");
                    }
                }
                check(); emit(null, true, null);
            } catch (Exception e) {
                String failure = cancelled.get() ? "Request cancelled." : error(e);
                if (resolved) emit(null, true, failure); else if (responseSettled.compareAndSet(false, true)) call.reject(failure);
            } finally { if (connection != null) connection.disconnect(); requests.remove(id, this); }
        }
    }
    @PluginMethod public void importSkill(PluginCall call) {
        if (!pickerBusy.compareAndSet(false, true)) { call.reject("A Skill import is already in progress."); return; }
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
            .putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"text/markdown", "text/plain", "text/x-markdown", "application/octet-stream"});
        getActivity().runOnUiThread(() -> {
            try { startActivityForResult(call, intent, "skillSelected"); }
            catch (RuntimeException e) { pickerBusy.set(false); call.reject("No system file selector is available."); }
        });
    }
    @ActivityCallback private void skillSelected(PluginCall call, ActivityResult result) {
        pickerBusy.set(false); if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) { call.reject("Skill import cancelled."); return; }
        Uri uri = result.getData().getData();
        execute(call, () -> {
            String name = "SKILL.md";
            try (Cursor cursor = getContext().getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) name = cursor.getString(0);
            }
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            try (InputStream input = getContext().getContentResolver().openInputStream(uri)) {
                if (input == null) throw new IllegalArgumentException("Selected Skill could not be opened.");
                byte[] buffer = new byte[8192]; int count;
                while ((count = input.read(buffer)) != -1) { if (bytes.size() + count > 262144) throw new IllegalArgumentException("Skill must be at most 256 KiB."); bytes.write(buffer, 0, count); }
            }
            String content;
            try { content = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes.toByteArray())).toString(); }
            catch (CharacterCodingException e) { throw new IllegalArgumentException("Skill must be valid UTF-8 text."); }
            if (content.startsWith("\uFEFF")) content = content.substring(1);
            if (content.indexOf('\0') >= 0) throw new IllegalArgumentException("Skill contains binary data; select UTF-8 Markdown.");
            call.resolve(new JSObject().put("name", name).put("content", content));
        });
    }
    @Override protected void handleOnDestroy() {
        destroyed.set(true); if (accountObserver != null) OAuthService.unobserve(accountObserver);
        cancelAll(); if (oauthResult != null) OAuthService.detach(oauthResult);
        if (oauthCall != null) oauthCall.reject("App activity changed during sign-in. Return to account settings to check its result.");
        workers.shutdownNow(); network.shutdownNow(); super.handleOnDestroy();
    }
}
