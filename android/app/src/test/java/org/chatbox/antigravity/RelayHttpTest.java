package org.chatbox.antigravity;

import org.junit.Test;
import static org.junit.Assert.*;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/** Native transport contract without network, Google credentials, or Android devices. */
public class RelayHttpTest {
    private static class Connection extends HttpURLConnection {
        int code = 200;
        byte[] bytes = "data: {\"text\":\"你好\"}\n\nevent: response.completed\ndata: {}\n\n".getBytes(StandardCharsets.UTF_8);
        boolean disconnected, closed, usedErrorStream;
        final ByteArrayOutputStream sent = new ByteArrayOutputStream();
        Connection() throws Exception { super(new URL("https://relay.example.test/v1/responses")); }
        @Override public void disconnect() { disconnected = true; }
        @Override public boolean usingProxy() { return false; }
        @Override public void connect() { }
        @Override public OutputStream getOutputStream() { return sent; }
        @Override public int getResponseCode() throws IOException { return code; }
        @Override public Map<String, List<String>> getHeaderFields() {
            Map<String, List<String>> values = new LinkedHashMap<>();
            values.put(null, Collections.singletonList("HTTP/1.1 " + code));
            values.put("Content-Type", Collections.singletonList(code >= 400 ? "application/json" : "text/event-stream"));
            values.put("Retry-After", Collections.singletonList("7"));
            values.put("X-Request-Id", Collections.singletonList("upstream-test-id"));
            return values;
        }
        private InputStream stream() { return new ByteArrayInputStream(bytes) {
            @Override public synchronized int read(byte[] target, int offset, int count) { return super.read(target, offset, Math.min(count, 3)); }
            @Override public void close() { closed = true; }
        }; }
        @Override public InputStream getInputStream() { return stream(); }
        @Override public InputStream getErrorStream() { usedErrorStream = true; return stream(); }
    }
    private static class Result implements RelayHttp.Listener {
        int status, chunks;
        Map<String, String> headers;
        final ByteArrayOutputStream body = new ByteArrayOutputStream();
        boolean done;
        Exception error;
        @Override public void headers(int code, Map<String, String> values) { status = code; headers = values; }
        @Override public void chunk(byte[] bytes) { body.write(bytes, 0, bytes.length); chunks++; }
        @Override public void end() { done = true; }
        @Override public void error(Exception exception) { error = exception; }
    }
    @Test public void preservesRawUnicodeSseHeadersAndExplicitApiKey() throws Exception {
        Connection connection = new Connection(); Result result = new Result();
        byte[] body = "{\"stream\":true,\"input\":\"hello\"}".getBytes(StandardCharsets.UTF_8);
        Map<String, String> headers = Collections.singletonMap("Authorization", "Bearer relay-test-only");
        new RelayHttp("https://relay.example.test/prefix/v1/responses?test=1", "POST", headers, body, result, url -> {
            assertEquals("/prefix/v1/responses", url.getPath()); assertEquals("test=1", url.getQuery()); return connection;
        }).run();
        assertEquals(200, result.status); assertNull(result.error); assertTrue(result.done); assertTrue(result.chunks > 1);
        assertArrayEquals(connection.bytes, result.body.toByteArray()); assertArrayEquals(body, connection.sent.toByteArray());
        assertEquals("Bearer relay-test-only", connection.getRequestProperty("Authorization"));
        assertEquals("7", result.headers.get("retry-after")); assertEquals("upstream-test-id", result.headers.get("x-request-id"));
        assertFalse(result.headers.containsKey(null)); assertTrue(connection.closed); assertTrue(connection.disconnected);
        assertFalse(connection.getInstanceFollowRedirects());
    }
    @Test public void returnsRealErrorStatusHeadersAndJsonBody() throws Exception {
        for (int status : new int[]{401, 429, 503}) {
            Connection connection = new Connection(); connection.code = status; connection.bytes = "{\"error\":{\"message\":\"quota\"}}".getBytes(StandardCharsets.UTF_8);
            Result result = new Result();
            new RelayHttp("https://relay.example.test/v1/chat/completions", "POST", Collections.emptyMap(), null, result, url -> connection).run();
            assertEquals(status, result.status); assertNull(result.error); assertTrue(result.done); assertTrue(connection.usedErrorStream);
            assertArrayEquals(connection.bytes, result.body.toByteArray()); assertEquals("7", result.headers.get("retry-after"));
            assertNull(connection.getRequestProperty("Authorization"));
        }
    }
    @Test public void exposesRedirectWithoutForwardingCredentials() throws Exception {
        Connection connection = new Connection(); connection.code = 302; Result result = new Result();
        new RelayHttp("https://relay.example.test/v1/models", "GET", Collections.singletonMap("Authorization", "Bearer relay-test-only"), null, result, url -> connection).run();
        assertEquals(302, result.status); assertFalse(connection.getInstanceFollowRedirects()); assertNull(result.error);
    }
    @Test public void acceptsExplicitHttpLanAndLoopbackWithoutChangingGoogleAllowlist() throws Exception {
        assertEquals("http", RelayHttp.validateUrl("http://127.0.0.1:11434/v1/models").getProtocol());
        assertEquals("http", RelayHttp.validateUrl("http://192.168.1.10:8080/prefix/v1/responses").getProtocol());
        assertEquals("https", RelayHttp.validateUrl("https://relay.example.test/v1/models").getProtocol());
        for (String url : new String[]{"file:///cache/key", "https://user:password@relay.example.test/v1", "https://relay.example.test/#fragment", "https:///missing-host"}) {
            try { RelayHttp.validateUrl(url); fail("Expected invalid URL"); } catch (IllegalArgumentException expected) { }
        }
        try { AntigravityPlugin.allowed("http://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", "POST"); fail("Google transport must remain HTTPS-only"); }
        catch (IllegalArgumentException expected) { }
    }
    @Test public void cancelBeforeStartNeverOpensConnection() throws Exception {
        Result result = new Result();
        RelayHttp request = new RelayHttp("https://relay.example.test/v1/models", "GET", Collections.emptyMap(), null, result, url -> { fail("Cancelled request opened a connection"); return null; });
        request.cancel(); request.run(); assertNotNull(result.error); assertFalse(result.done); assertEquals(0, result.status);
    }
    @Test public void cancellationDisconnectsWhileWaitingForHeaders() throws Exception {
        CountDownLatch waiting = new CountDownLatch(1), released = new CountDownLatch(1);
        Connection connection = new Connection() {
            @Override public int getResponseCode() throws IOException {
                waiting.countDown();
                try { if (!released.await(2, TimeUnit.SECONDS)) throw new IOException("Test timed out"); }
                catch (InterruptedException error) { throw new IOException(error); }
                throw new IOException("Disconnected");
            }
            @Override public void disconnect() { super.disconnect(); released.countDown(); }
        };
        Result result = new Result();
        RelayHttp request = new RelayHttp("https://relay.example.test/v1/models", "GET", Collections.emptyMap(), null, result, url -> connection);
        Thread worker = new Thread(request); worker.start();
        try { assertTrue(waiting.await(2, TimeUnit.SECONDS)); request.cancel(); worker.join(2000); assertFalse(worker.isAlive()); }
        finally { request.cancel(); worker.join(2000); }
        assertTrue(connection.disconnected); assertNotNull(result.error); assertFalse(result.done);
    }
    @Test public void cancellationClosesStreamAndStopsFurtherChunks() throws Exception {
        Connection connection = new Connection(); final RelayHttp[] pending = new RelayHttp[1];
        Result result = new Result() { @Override public void chunk(byte[] bytes) { super.chunk(bytes); pending[0].cancel(); } };
        pending[0] = new RelayHttp("https://relay.example.test/v1/responses", "POST", Collections.emptyMap(), null, result, url -> connection);
        pending[0].run(); assertEquals(1, result.chunks); assertTrue(connection.closed); assertTrue(connection.disconnected);
        assertNotNull(result.error); assertFalse(result.done);
    }
    @Test public void bodylessResponsesDoNotAttemptReading() throws Exception {
        for (int status : new int[]{204, 205, 304}) {
            Connection connection = new Connection() { @Override public InputStream getInputStream() { fail("Bodyless response was read"); return null; } };
            connection.code = status; Result result = new Result();
            new RelayHttp("https://relay.example.test/v1/models", "GET", Collections.emptyMap(), null, result, url -> connection).run();
            assertEquals(status, result.status); assertNull(result.error); assertTrue(result.done); assertEquals(0, result.chunks);
        }
    }
    @Test public void rejectsHeaderInjectionAndOversizedRequest() throws Exception {
        Result result = new Result();
        for (Map<String, String> headers : java.util.Arrays.asList(Collections.singletonMap("Authorization", "key\r\nInjected: true"), Collections.singletonMap("Host", "other.example.test"))) {
            try { new RelayHttp("https://relay.example.test/v1/models", "GET", headers, null, result); fail("Expected invalid header"); }
            catch (IllegalArgumentException expected) { }
        }
        try { new RelayHttp("https://relay.example.test/v1/responses", "POST", Collections.emptyMap(), new byte[RelayHttp.MAX_BODY_BYTES + 1], result); fail("Expected body limit"); }
        catch (IllegalArgumentException expected) { }
    }
}
