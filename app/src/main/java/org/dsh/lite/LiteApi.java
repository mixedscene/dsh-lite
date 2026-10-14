package org.dsh.lite;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.CancellationException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

public final class LiteApi {
    private static final String BASE = "https://cloudcode-pa.googleapis.com/v1internal:";
    private static final String STREAM = "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse";
    private final AccountStore store;
    private static final ThreadLocal<NetworkWatch> NETWORK = new ThreadLocal<>();
    private static final class NetworkWatch {
        final AtomicBoolean cancel, done = new AtomicBoolean();
        final AtomicReference<HttpURLConnection> active = new AtomicReference<>();
        NetworkWatch(AtomicBoolean cancel) { this.cancel = cancel; }
    }
    public interface Listener { void onText(String delta); void onThought(String delta); }
    public LiteApi(AccountStore store) { this.store = store; }
    static final class HttpFailure extends Exception {
        final int status;
        HttpFailure(int status) { super("Google service returned HTTP " + status + "." + (status == 403 ? " Verify Antigravity access and required consent in the official application." : "")); this.status = status; }
    }
    private static HttpURLConnection open(String url, String method, String token) throws Exception {
        URL u = new URL(url); if (!"https".equals(u.getProtocol())) throw new Exception("HTTPS is required.");
        HttpURLConnection c = (HttpURLConnection)u.openConnection(); c.setConnectTimeout(15000); c.setReadTimeout(45000);
        c.setInstanceFollowRedirects(false); c.setRequestMethod(method); c.setRequestProperty("Accept", "application/json");
        if (token != null) c.setRequestProperty("Authorization", "Bearer " + token);
        NetworkWatch watch = NETWORK.get();
        if (watch != null) {
            cancelled(watch.cancel); watch.active.set(c);
            if (watch.cancel.get()) { c.disconnect(); throw new CancellationException("Generation cancelled."); }
        }
        return c;
    }
    private static void send(HttpURLConnection c, byte[] body, String contentType) throws Exception {
        c.setDoOutput(true); c.setRequestProperty("Content-Type", contentType); c.setFixedLengthStreamingMode(body.length);
        try (OutputStream out = c.getOutputStream()) { out.write(body); }
    }
    private static void check(HttpURLConnection c) throws Exception {
        int status = c.getResponseCode(); if (status < 200 || status >= 300) {
            InputStream error = c.getErrorStream(); if (error != null) error.close(); throw new HttpFailure(status);
        }
    }
    private static JSONObject readJson(HttpURLConnection c) throws Exception {
        check(c);
        try (InputStream in = c.getInputStream(); ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
            byte[] b = new byte[8192]; int n; while ((n = in.read(b)) != -1) { if (bytes.size() + n > 4 * 1024 * 1024) throw new Exception("Google response exceeded the size limit."); bytes.write(b, 0, n); }
            try { return new JSONObject(bytes.toString("UTF-8")); } catch (Exception e) { throw new Exception("Google returned an invalid JSON response."); }
        }
    }
    static JSONObject tokenRequest(String form) throws Exception {
        HttpURLConnection c = open("https://oauth2.googleapis.com/token", "POST", null);
        try { send(c, form.getBytes(StandardCharsets.UTF_8), "application/x-www-form-urlencoded"); return readJson(c); } finally { c.disconnect(); }
    }
    static String enc(String value) throws Exception { return URLEncoder.encode(value, "UTF-8"); }
    static JSONObject profile(String token) throws Exception {
        HttpURLConnection c = open("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", "GET", token);
        try { JSONObject p = readJson(c); if (p.optString("id").isEmpty() || p.optString("email").isEmpty()) throw new Exception("Google profile did not include a stable account ID and email."); return p; } finally { c.disconnect(); }
    }
    private void refresh(AccountStore.Account a) throws Exception {
        synchronized (store) {
            if (a.refreshToken == null || a.refreshToken.isEmpty()) throw new Exception("This account needs to sign in again; no refresh token is available.");
            JSONObject t = tokenRequest("grant_type=refresh_token&refresh_token=" + enc(a.refreshToken) + "&client_id=" + enc(OAuthConfig.CLIENT_ID) + "&client_secret=" + enc(OAuthConfig.CLIENT_SECRET));
            String token = t.optString("access_token"); if (token.isEmpty()) throw new Exception("Google refresh returned no access token.");
            JSONObject p = profile(token); if (!a.id.equals(p.getString("id"))) throw new Exception("Refresh identity mismatch. Sign in again to the same account.");
            long seconds = t.optLong("expires_in", 0); if (seconds <= 0 || seconds > 86400) throw new Exception("Google returned an invalid token lifetime.");
            // Persist only after identity verification; never switch accounts during refresh.
            boolean exists = false; for (AccountStore.Account current : store.list()) if (a.id.equals(current.id)) exists = true;
            if (!exists) throw new Exception("Account was removed while refreshing.");
            a.accessToken = token; a.email = p.getString("email"); a.expiryMillis = System.currentTimeMillis() + seconds * 1000;
            if (!t.optString("refresh_token").isEmpty()) a.refreshToken = t.getString("refresh_token"); store.upsert(a);
        }
    }
    private void ensureToken(AccountStore.Account a) throws Exception {
        if (a == null || a.id == null || a.id.isEmpty()) throw new Exception("Select an account first.");
        if (a.accessToken == null || a.accessToken.isEmpty() || a.expiryMillis < System.currentTimeMillis() + 60000) refresh(a);
    }
    private JSONObject post(AccountStore.Account a, String endpoint, JSONObject body) throws Exception {
        ensureToken(a);
        for (int attempt = 0; attempt < 2; attempt++) {
            HttpURLConnection c = open(endpoint, "POST", a.accessToken);
            try { send(c, body.toString().getBytes(StandardCharsets.UTF_8), "application/json"); return readJson(c); }
            catch (HttpFailure e) { if (e.status != 401 || attempt != 0) throw e; refresh(a); }
            finally { c.disconnect(); }
        }
        throw new Exception("Authorization failed. Sign in again.");
    }
    private static JSONObject metadata() throws Exception { return new JSONObject().put("ideType", "ANTIGRAVITY").put("pluginType", "GEMINI"); }
    public List<String> discover(AccountStore.Account a) throws Exception {
        JSONObject loaded = post(a, BASE + "loadCodeAssist", new JSONObject().put("metadata", metadata()));
        Object raw = loaded.opt("cloudaicompanionProject"); String project = raw instanceof String ? (String)raw : raw instanceof JSONObject ? ((JSONObject)raw).optString("id") : "";
        if (project.isEmpty()) throw new Exception("This account has no Antigravity project. Complete onboarding and required privacy consent in the official Antigravity app, then sign in again. Lite does not enroll accounts or accept consent automatically.");
        a.project = project;
        JSONObject result = post(a, BASE + "fetchAvailableModels", new JSONObject().put("project", project).put("metadata", metadata()));
        JSONObject models = result.optJSONObject("models");
        if (models == null) throw new Exception("Model discovery returned no model map.");
        List<String> keys = new ArrayList<>(); Iterator<String> it = models.keys();
        while (it.hasNext()) { String key = it.next(); if (!key.isEmpty()) keys.add(key); }
        if (keys.isEmpty()) throw new Exception("No models are available for this account.");
        java.util.Collections.sort(keys); return keys;
    }
    private static void cancelled(AtomicBoolean cancel) { if (cancel.get() || Thread.currentThread().isInterrupted()) throw new CancellationException("Generation cancelled."); }
    public JSONObject chat(AccountStore.Account a, String model, JSONArray contents, String systemPrompt, AtomicBoolean cancel, Listener listener) throws Exception {
        if (cancel == null || contents == null || model == null || model.isEmpty()) throw new IllegalArgumentException("Model, conversation and cancellation flag are required.");
        NetworkWatch watch = new NetworkWatch(cancel); NETWORK.set(watch);
        Thread watcher = new Thread(() -> {
            while (!watch.done.get()) {
                if (cancel.get()) { HttpURLConnection c = watch.active.get(); if (c != null) c.disconnect(); return; }
                try { Thread.sleep(50); } catch (InterruptedException e) { return; }
            }
        }, "lite-cancel"); watcher.setDaemon(true); watcher.start();
        try { return chatInternal(a, model, contents, systemPrompt, cancel, listener); }
        catch (Exception e) { cancelled(cancel); throw e; }
        finally {
            watch.done.set(true); watcher.interrupt(); NETWORK.remove();
            HttpURLConnection c = watch.active.getAndSet(null); if (c != null) c.disconnect();
        }
    }
    private JSONObject chatInternal(AccountStore.Account a, String model, JSONArray contents, String systemPrompt, AtomicBoolean cancel, Listener listener) throws Exception {
        cancelled(cancel); ensureToken(a); cancelled(cancel);
        if (a.project == null || a.project.isEmpty()) throw new Exception("Discover models to load this account's Antigravity project first.");
        boolean claude = model.toLowerCase(Locale.ROOT).contains("claude");
        JSONObject thinking = new JSONObject().put("includeThoughts", true);
        if (claude) thinking.put("thinkingBudget", 1024); else if (model.toLowerCase(Locale.ROOT).matches(".*gemini[-_]?3.*")) thinking.put("thinkingLevel", "LOW");
        JSONObject generation = new JSONObject().put("thinkingConfig", thinking); if (claude) generation.put("maxOutputTokens", 4096);
        JSONObject request = new JSONObject().put("sessionId", store.sessionId(a.id, model)).put("contents", contents).put("generationConfig", generation);
        if (systemPrompt != null && !systemPrompt.isEmpty()) request.put("systemInstruction", new JSONObject().put("parts", new JSONArray().put(new JSONObject().put("text", systemPrompt))));
        JSONObject body = new JSONObject().put("project", a.project).put("model", model).put("requestType", "agent")
                .put("userAgent", "antigravity").put("requestId", UUID.randomUUID().toString()).put("request", request);
            for (int attempt = 0; attempt < 2; attempt++) {
                cancelled(cancel); HttpURLConnection c = open(STREAM, "POST", a.accessToken);
                try {
                    c.setRequestProperty("Accept", "text/event-stream"); send(c, body.toString().getBytes(StandardCharsets.UTF_8), "application/json"); check(c); cancelled(cancel);
                    Collector collector = new Collector(claude, listener); boolean finished = false;
                    try (BufferedReader reader = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8))) {
                        StringBuilder event = new StringBuilder(); String line;
                        while ((line = reader.readLine()) != null) {
                            cancelled(cancel);
                            if (line.isEmpty()) { if (event.length() > 0) { String data = event.toString(); event.setLength(0); if ("[DONE]".equals(data)) { finished = true; break; } finished |= collector.accept(data); } }
                            else if (line.startsWith("data:")) { if (event.length() > 0) event.append('\n'); String data = line.substring(5); if (data.startsWith(" ")) data = data.substring(1); event.append(data); if (event.length() > 4 * 1024 * 1024) throw new Exception("Streaming event exceeded size limit."); }
                        }
                        if (event.length() > 0) { if ("[DONE]".equals(event.toString())) finished = true; else finished |= collector.accept(event.toString()); }
                    }
                    cancelled(cancel); if (!finished) throw new Exception("Generation ended before a completion marker. Retry the turn.");
                    return collector.result();
                } catch (HttpFailure e) { if (e.status != 401 || attempt != 0) throw e; cancelled(cancel); refresh(a); }
                catch (Exception e) { cancelled(cancel); throw e; }
                finally { c.disconnect(); }
            }
            throw new Exception("Authorization failed. Sign in again.");
    }
    /** Preserve Gemini signed parts verbatim; assemble Claude thought fragments before replay. */
    private static final class Collector {
        final boolean claude; final Listener listener; final JSONArray parts = new JSONArray();
        StringBuilder thought = new StringBuilder(), visible = new StringBuilder(); String signature = ""; long size;
        Collector(boolean claude, Listener listener) { this.claude = claude; this.listener = listener; }
        boolean accept(String data) throws Exception {
            size += data.length(); if (size > 16 * 1024 * 1024) throw new Exception("Generation exceeded the size limit.");
            JSONObject outer;
            try { outer = new JSONObject(data); } catch (Exception e) { throw new Exception("Invalid streaming JSON response."); }
            if (outer.has("error")) throw new Exception("Google rejected generation. Check model access and conversation compatibility.");
            JSONObject response = outer.optJSONObject("response"); if (response == null) response = outer;
            if (response.has("error")) throw new Exception("Google rejected generation.");
            JSONArray candidates = response.optJSONArray("candidates");
            if (candidates == null || candidates.length() == 0) {
                if (response.has("promptFeedback")) throw new Exception("Google blocked this prompt.");
                if (response.has("usageMetadata")) return false; // Final billing-only SSE event.
                throw new Exception("Streaming response contained no candidate.");
            }
            JSONObject candidate = candidates.getJSONObject(0); JSONObject content = candidate.optJSONObject("content");
            if (content != null) {
                JSONArray incoming = content.optJSONArray("parts"); if (incoming == null) throw new Exception("Streaming content has no parts.");
                for (int i = 0; i < incoming.length(); i++) {
                    JSONObject part = incoming.getJSONObject(i); String text = part.optString("text", ""); boolean isThought = part.optBoolean("thought", false);
                    String sig = part.optString("thoughtSignature", "");
                    if (listener != null && !text.isEmpty()) { if (isThought) listener.onThought(text); else listener.onText(text); }
                    if (!claude) { if (!text.isEmpty() || !sig.isEmpty() || part.has("inlineData")) parts.put(new JSONObject(part.toString())); continue; }
                    if (isThought) {
                        flushVisible(); if (!signature.isEmpty() && !text.isEmpty()) flushThought(); thought.append(text);
                        if (!sig.isEmpty()) signature += sig;
                    } else if (!sig.isEmpty() && text.isEmpty()) {
                        signature += sig; // Claude often signs all preceding thinking in a standalone part.
                    } else if (!text.isEmpty()) { flushThought(); visible.append(text); }
                    else if (part.has("functionCall")) throw new Exception("This app does not execute model tool calls.");
                }
            }
            String reason = candidate.optString("finishReason", "");
            if (!reason.isEmpty() && !"STOP".equals(reason) && !"MAX_TOKENS".equals(reason)) throw new Exception("Generation could not complete (" + safeReason(reason) + ").");
            return !reason.isEmpty();
        }
        static String safeReason(String reason) { return reason.matches("[A-Z_]{1,40}") ? reason : "MODEL_ERROR"; }
        void flushVisible() throws Exception { if (visible.length() > 0) { parts.put(new JSONObject().put("text", visible.toString())); visible.setLength(0); } }
        void flushThought() throws Exception {
            if (thought.length() > 0 && signature.isEmpty()) throw new Exception("Claude returned unsigned thinking; retry the turn before continuing this conversation.");
            if (thought.length() > 0 && !signature.isEmpty()) parts.put(new JSONObject().put("thought", true).put("text", thought.toString()).put("thoughtSignature", signature));
            else if (!signature.isEmpty()) throw new Exception("Claude returned a thinking signature without thinking text.");
            thought.setLength(0); signature = "";
        }
        JSONObject result() throws Exception {
            if (claude) { flushThought(); flushVisible(); }
            if (parts.length() == 0) throw new Exception("Model returned no usable content.");
            return new JSONObject().put("role", "model").put("parts", parts);
        }
    }
}
