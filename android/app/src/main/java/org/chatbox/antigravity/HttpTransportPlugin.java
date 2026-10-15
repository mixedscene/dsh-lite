package org.chatbox.antigravity;

import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/** Caller-supplied credentials only. Never delegates to AntigravityPlugin or AccountStore. */
@CapacitorPlugin(name = "HttpTransport")
public final class HttpTransportPlugin extends Plugin {
    private final ExecutorService workers = Executors.newFixedThreadPool(4);
    private final ConcurrentHashMap<String, Request> requests = new ConcurrentHashMap<>();
    private boolean destroyed;

    @PluginMethod public void request(PluginCall call) {
        try {
            String id = call.getString("requestId"), url = call.getString("url"), method = call.getString("method", "GET");
            if (id == null || id.isEmpty() || id.length() > 128) throw new IllegalArgumentException("Invalid requestId.");
            if (url == null) throw new IllegalArgumentException("URL is required.");
            String encoded = call.getString("bodyBase64");
            if (encoded != null && encoded.length() > ((RelayHttp.MAX_BODY_BYTES + 2L) / 3) * 4)
                throw new IllegalArgumentException("Request body exceeds 32 MiB.");
            byte[] body = encoded == null ? null : Base64.decode(encoded, Base64.DEFAULT);
            JSObject rawHeaders = call.getObject("headers", new JSObject());
            Map<String, String> headers = new LinkedHashMap<>();
            Iterator<String> keys = rawHeaders.keys();
            while (keys.hasNext()) { String key = keys.next(); headers.put(key, rawHeaders.getString(key)); }
            Request request = new Request(id, call, url, method, headers, body);
            synchronized (requests) {
                if (destroyed) throw new IllegalStateException("HTTP transport is unavailable.");
                if (requests.size() >= 32) throw new IllegalStateException("Too many HTTP requests. Cancel pending requests and retry.");
                if (requests.putIfAbsent(id, request) != null) throw new IllegalArgumentException("requestId is already in use.");
                workers.execute(() -> { try { request.http.run(); } finally { requests.remove(id, request); } });
            }
        } catch (Exception error) { call.reject(message(error)); }
    }
    @PluginMethod public void cancelRequest(PluginCall call) {
        String id = call.getString("requestId");
        Request request = id == null ? null : requests.get(id);
        if (request != null) request.cancel();
        call.resolve();
    }
    private static String message(Exception error) {
        return error instanceof IllegalArgumentException || error instanceof IllegalStateException
            ? error.getMessage() : "Native HTTP request failed. Check the connection and endpoint.";
    }
    private final class Request implements RelayHttp.Listener {
        final String id;
        final PluginCall call;
        final RelayHttp http;
        final AtomicBoolean settled = new AtomicBoolean(), ended = new AtomicBoolean();
        Request(String id, PluginCall call, String url, String method, Map<String, String> headers, byte[] body) throws Exception {
            this.id = id; this.call = call; this.http = new RelayHttp(url, method, headers, body, this);
        }
        @Override public void headers(int status, Map<String, String> headers) {
            JSObject responseHeaders = new JSObject();
            for (Map.Entry<String, String> header : headers.entrySet()) responseHeaders.put(header.getKey(), header.getValue());
            if (settled.compareAndSet(false, true)) call.resolve(new JSObject().put("status", status).put("headers", responseHeaders));
        }
        @Override public void chunk(byte[] bytes) {
            if (!ended.get()) notifyListeners("httpData", new JSObject().put("requestId", id).put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP)));
        }
        @Override public void end() {
            if (ended.compareAndSet(false, true)) notifyListeners("httpData", new JSObject().put("requestId", id).put("done", true));
        }
        @Override public void error(Exception error) {
            if (settled.compareAndSet(false, true)) { ended.set(true); call.reject(message(error)); }
            else if (ended.compareAndSet(false, true)) notifyListeners("httpData", new JSObject().put("requestId", id).put("error", message(error)));
        }
        void cancel() { error(new IllegalStateException("Request cancelled.")); http.cancel(); }
    }
    @Override protected void handleOnDestroy() {
        synchronized (requests) { destroyed = true; for (Request request : requests.values()) request.cancel(); }
        workers.shutdownNow();
        super.handleOnDestroy();
    }
}
