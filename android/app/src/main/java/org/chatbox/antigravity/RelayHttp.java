package org.chatbox.antigravity;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/** Explicitly configured HTTP(S) only. No account store or OAuth credential access. */
final class RelayHttp implements Runnable {
    interface ConnectionFactory { HttpURLConnection open(URL url) throws Exception; }
    interface Listener {
        void headers(int status, Map<String, String> headers);
        void chunk(byte[] bytes);
        void end();
        void error(Exception error);
    }
    static final int MAX_BODY_BYTES = 32 * 1024 * 1024;
    private final URL url;
    private final String method;
    private final Map<String, String> headers;
    private final byte[] body;
    private final Listener listener;
    private final ConnectionFactory factory;
    private final AtomicBoolean cancelled = new AtomicBoolean();
    private volatile HttpURLConnection connection;
    private volatile InputStream input;

    RelayHttp(String url, String method, Map<String, String> headers, byte[] body, Listener listener) throws Exception {
        this(url, method, headers, body, listener, target -> (HttpURLConnection) target.openConnection());
    }
    RelayHttp(String url, String method, Map<String, String> headers, byte[] body, Listener listener, ConnectionFactory factory) throws Exception {
        this.url = validateUrl(url);
        if (!Arrays.asList("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS").contains(method))
            throw new IllegalArgumentException("Unsupported HTTP method.");
        if (body != null && ("GET".equals(method) || "HEAD".equals(method)))
            throw new IllegalArgumentException("GET and HEAD cannot have a request body.");
        if (body != null && body.length > MAX_BODY_BYTES) throw new IllegalArgumentException("Request body exceeds 32 MiB.");
        this.headers = new LinkedHashMap<>();
        for (Map.Entry<String, String> entry : headers.entrySet()) {
            String key = entry.getKey(), value = entry.getValue();
            if (!key.matches("[!#$%&'*+.^_`|~0-9A-Za-z-]+") || value == null || value.indexOf('\r') >= 0 || value.indexOf('\n') >= 0)
                throw new IllegalArgumentException("Invalid HTTP header.");
            if (Arrays.asList("host", "connection", "content-length", "transfer-encoding").contains(key.toLowerCase(Locale.ROOT)))
                throw new IllegalArgumentException("HTTP connection headers are managed by the transport.");
            this.headers.put(key, value);
        }
        this.method = method; this.body = body; this.listener = listener; this.factory = factory;
    }
    static URL validateUrl(String value) throws Exception {
        URI uri = new URI(value);
        if ((!"https".equalsIgnoreCase(uri.getScheme()) && !"http".equalsIgnoreCase(uri.getScheme()))
            || uri.getHost() == null || uri.getUserInfo() != null || uri.getFragment() != null)
            throw new IllegalArgumentException("Relay requests require an HTTP(S) URL without embedded credentials or fragments.");
        return uri.toURL();
    }
    void cancel() {
        cancelled.set(true);
        HttpURLConnection active = connection;
        if (active != null) active.disconnect();
        InputStream source = input;
        if (source != null) try { source.close(); } catch (IOException ignored) { }
    }
    private void check() throws IOException {
        if (cancelled.get()) throw new IOException("Request cancelled.");
    }
    @Override public void run() {
        try {
            check(); connection = factory.open(url); check();
            // Do not forward explicitly supplied API keys to a redirect target.
            connection.setInstanceFollowRedirects(false);
            connection.setUseCaches(false);
            connection.setConnectTimeout(30000);
            connection.setReadTimeout(120000);
            connection.setRequestMethod(method);
            for (Map.Entry<String, String> header : headers.entrySet()) connection.setRequestProperty(header.getKey(), header.getValue());
            if (body != null) {
                connection.setDoOutput(true);
                connection.setFixedLengthStreamingMode(body.length);
                try (OutputStream output = connection.getOutputStream()) { check(); output.write(body); }
            }
            check(); int status = connection.getResponseCode(); check();
            if (status < 200 || status > 599) throw new IOException("Invalid upstream HTTP response.");
            Map<String, String> responseHeaders = new LinkedHashMap<>();
            for (Map.Entry<String, List<String>> header : connection.getHeaderFields().entrySet())
                if (header.getKey() != null && header.getValue() != null)
                    responseHeaders.put(header.getKey().toLowerCase(Locale.ROOT), String.join(", ", header.getValue()));
            listener.headers(status, responseHeaders);
            if (!"HEAD".equals(method) && status != 204 && status != 205 && status != 304) {
                input = status >= 400 ? connection.getErrorStream() : connection.getInputStream(); check();
                if (input != null) {
                    try (InputStream source = input) {
                        byte[] buffer = new byte[16384]; int count;
                        while ((count = source.read(buffer)) != -1) {
                            check();
                            if (count != 0) listener.chunk(Arrays.copyOf(buffer, count));
                        }
                    }
                }
            }
            check(); listener.end();
        } catch (Exception error) { listener.error(error); }
        finally {
            InputStream source = input;
            if (source != null) try { source.close(); } catch (IOException ignored) { }
            if (connection != null) connection.disconnect();
        }
    }
}
