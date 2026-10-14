package org.chatbox.antigravity;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.*;
import android.util.Base64;
import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** Temporary loopback service, started by an explicit user action, never a chat server. */
public final class OAuthService extends Service {
    interface Result { void complete(JSONObject account, String error); }
    private static volatile OAuthService instance;
    private static volatile Result result;
    private static volatile boolean starting, cancelRequested;
    private static final List<Runnable> observers = new CopyOnWriteArrayList<>();
    private static final String REDIRECT = "http://localhost:51121/oauth-callback";
    private static final String SCOPES = "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs";
    private final AtomicBoolean consumed = new AtomicBoolean(), finished = new AtomicBoolean();
    private final Object terminal = new Object();
    private final List<ServerSocket> listeners = new CopyOnWriteArrayList<>();
    private final List<Socket> clients = new CopyOnWriteArrayList<>();
    private final ExecutorService workers = Executors.newCachedThreadPool();
    private final Handler handler = new Handler(Looper.getMainLooper());
    private AccountStore store;
    private String state, verifier;
    private final Runnable deadline = () -> finish(null, "Google sign-in timed out. Add the account again.");
    static boolean isRunning() { return starting || instance != null; }
    static boolean isPending() { OAuthService current = instance; return starting || (current != null && !current.finished.get()); }
    static void observe(Runnable observer) { observers.add(observer); }
    static void unobserve(Runnable observer) { observers.remove(observer); }
    static synchronized void begin(Context context, long timeout, Result callback) {
        if (isRunning()) throw new IllegalStateException("Google sign-in is already in progress.");
        starting = true; cancelRequested = false; result = callback;
        try { context.startForegroundService(new Intent(context, OAuthService.class).putExtra("timeout", timeout)); }
        catch (RuntimeException e) { starting = false; result = null; throw new IllegalStateException("Cannot start browser sign-in. Keep the app visible and try again."); }
    }
    static void detach(Result callback) { if (result == callback) result = null; }
    static void cancel() { cancelRequested = true; OAuthService current = instance; if (current != null) current.finish(null, "Google sign-in cancelled."); }
    @Override public IBinder onBind(Intent intent) { return null; }
    @Override public void onCreate() { super.onCreate(); instance = this; starting = false; store = new AccountStore(this); }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (state != null) return START_NOT_STICKY;
        if (cancelRequested) { finish(null, "Google sign-in cancelled."); return START_NOT_STICKY; }
        try {
            if (BuildConfig.OAUTH_CLIENT_ID.isEmpty()) throw new IllegalStateException("OAuth client configuration is missing from this build.");
            NotificationManager manager = getSystemService(NotificationManager.class);
            manager.createNotificationChannel(new NotificationChannel("google_oauth", "Google sign-in", NotificationManager.IMPORTANCE_LOW));
            PendingIntent tap = PendingIntent.getActivity(this, 1, new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            Notification notification = new Notification.Builder(this, "google_oauth").setSmallIcon(android.R.drawable.ic_lock_lock)
                .setContentTitle("Google sign-in in progress").setContentText("Finish in your browser, then return to Chatbox.").setContentIntent(tap).setOngoing(true).build();
            if (Build.VERSION.SDK_INT >= 34) startForeground(51121, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            else startForeground(51121, notification);
            long timeout = intent == null ? 170000 : Math.max(10000, Math.min(170000, intent.getLongExtra("timeout", 170000)));
            store.pending(true); state = random(32); verifier = random(64); handler.postDelayed(deadline, timeout);
            workers.execute(this::authorize);
        } catch (Exception e) { finish(null, safeError(e)); }
        return START_NOT_STICKY;
    }
    private static String random(int bytes) {
        byte[] value = new byte[bytes]; new SecureRandom().nextBytes(value);
        return Base64.encodeToString(value, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }
    private void authorize() {
        try {
            bind("127.0.0.1");
            try { bind("::1"); } catch (IOException ignored) { /* Some Android devices disable IPv6 loopback. */ }
            String challenge = Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII)), Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
            String url = "https://accounts.google.com/o/oauth2/v2/auth?client_id=" + NativeHttp.enc(BuildConfig.OAUTH_CLIENT_ID)
                + "&redirect_uri=" + NativeHttp.enc(REDIRECT) + "&response_type=code&scope=" + NativeHttp.enc(SCOPES)
                + "&state=" + NativeHttp.enc(state) + "&code_challenge=" + NativeHttp.enc(challenge) + "&code_challenge_method=S256"
                + "&access_type=offline&prompt=" + NativeHttp.enc("select_account consent");
            handler.post(() -> {
                if (finished.get()) return;
                try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); }
                catch (RuntimeException e) { finish(null, "No system browser could open Google sign-in."); }
            });
        } catch (Exception e) { finish(null, "Cannot bind the Google callback on localhost:51121. Another app may be signing in; close that sign-in and retry."); }
    }
    private void bind(String address) throws IOException {
        ServerSocket listener = new ServerSocket(); listener.setReuseAddress(false);
        try {
            listener.bind(new InetSocketAddress(InetAddress.getByName(address), 51121), 4); listener.setSoTimeout(1000);
            synchronized (terminal) {
                if (finished.get()) { listener.close(); return; }
                listeners.add(listener);
            }
            workers.execute(() -> accept(listener));
        } catch (IOException e) { listener.close(); throw e; }
    }
    private void accept(ServerSocket listener) {
        while (!finished.get() && !consumed.get()) {
            try {
                Socket socket = listener.accept(); clients.add(socket);
                try (Socket ignored = socket) { socket.setSoTimeout(3000); handle(socket); }
                catch (Exception ignored) { /* Malformed local traffic never consumes a valid state. */ }
                finally { clients.remove(socket); }
            } catch (SocketTimeoutException ignored) { }
            catch (IOException e) { return; }
        }
    }
    private void handle(Socket socket) throws Exception {
        if (!socket.getInetAddress().isLoopbackAddress()) return;
        String[] first = request(socket.getInputStream()).split("\\r\\n", 2)[0].split(" ");
        if (first.length != 3 || !"GET".equals(first[0])) { reply(socket, 400, "Invalid callback request."); return; }
        URI uri = new URI(first[1]);
        if (uri.isAbsolute() || uri.getRawAuthority() != null || uri.getRawFragment() != null || !"/oauth-callback".equals(uri.getRawPath())) { reply(socket, 404, "Not found."); return; }
        Map<String,String> query = query(uri.getRawQuery()); String received = query.get("state");
        if (received == null || !MessageDigest.isEqual(state.getBytes(StandardCharsets.UTF_8), received.getBytes(StandardCharsets.UTF_8))) {
            reply(socket, 400, "Sign-in state did not match. Return to your original browser sign-in."); return;
        }
        if (!consumed.compareAndSet(false, true) || finished.get()) { reply(socket, 400, "Sign-in already completed or expired."); return; }
        if (query.containsKey("error")) { reply(socket, 200, "Sign-in cancelled. Return to Chatbox."); finish(null, "Google sign-in was cancelled or denied."); return; }
        String code = query.get("code");
        if (code == null || code.isEmpty()) { reply(socket, 400, "No authorization code."); finish(null, "Google callback contained no authorization code."); return; }
        reply(socket, 200, "Sign-in received. You can return to Chatbox; this tab can be closed.");
        closeListeners();
        workers.execute(() -> exchange(code));
    }
    private void exchange(String code) {
        try {
            JSONObject tokens = NativeHttp.token("grant_type=authorization_code&code=" + NativeHttp.enc(code) + "&client_id=" + NativeHttp.enc(BuildConfig.OAUTH_CLIENT_ID)
                + "&client_secret=" + NativeHttp.enc(BuildConfig.OAUTH_CLIENT_SECRET) + "&redirect_uri=" + NativeHttp.enc(REDIRECT) + "&code_verifier=" + NativeHttp.enc(verifier));
            if (finished.get()) return;
            JSONObject profile = NativeHttp.profile(tokens.getString("access_token"));
            synchronized (terminal) {
                if (finished.get()) return;
                JSONObject account = store.authenticate(profile, tokens); finish(account, null);
            }
        } catch (Exception e) { finish(null, safeError(e)); }
    }
    private static String safeError(Exception e) {
        if (e instanceof IllegalStateException || e instanceof IllegalArgumentException || e instanceof NativeHttp.ReauthException) return e.getMessage();
        return "Google sign-in could not complete. Check the network and try again.";
    }
    private void finish(JSONObject account, String error) {
        synchronized (terminal) {
            if (!finished.compareAndSet(false, true)) return;
            try { store.pending(false); } catch (RuntimeException e) { error = e.getMessage(); }
            try { store.outcome(error); } catch (RuntimeException e) { error = e.getMessage(); }
            cleanup(); Result callback = result; result = null;
            final String finalError = error;
            if (callback != null) handler.post(() -> callback.complete(account, finalError));
            for (Runnable observer : observers) handler.post(observer);
            stopSelf();
        }
    }
    private void closeListeners() { for (ServerSocket listener : listeners) try { listener.close(); } catch (IOException ignored) { } listeners.clear(); }
    private void cleanup() {
        handler.removeCallbacks(deadline); closeListeners();
        for (Socket socket : clients) try { socket.close(); } catch (IOException ignored) { }
        workers.shutdownNow(); stopForeground(STOP_FOREGROUND_REMOVE);
    }
    @Override public void onDestroy() { finish(null, "Sign-in was interrupted by Android. Add the account again."); instance = null; super.onDestroy(); }
    @Override public void onTimeout(int startId, int fgsType) { finish(null, "Android stopped Google sign-in. Add the account again."); }
    private static String request(InputStream input) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(); int next, matched = 0;
        while ((next = input.read()) != -1) {
            bytes.write(next); if (bytes.size() > 16384) throw new IOException("Callback headers exceed limit.");
            if ((matched == 0 || matched == 2) && next == '\r') matched++;
            else if ((matched == 1 || matched == 3) && next == '\n') { if (++matched == 4) break; }
            else matched = next == '\r' ? 1 : 0;
        }
        return bytes.toString("US-ASCII");
    }
    static Map<String,String> query(String raw) throws Exception {
        Map<String,String> result = new HashMap<>(); if (raw == null) return result;
        for (String pair : raw.split("&")) {
            String[] parts = pair.split("=", 2); String key = URLDecoder.decode(parts[0], "UTF-8");
            if (result.containsKey(key)) throw new IllegalArgumentException("Duplicate callback parameter.");
            result.put(key, parts.length == 2 ? URLDecoder.decode(parts[1], "UTF-8") : "");
        }
        return result;
    }
    private static void reply(Socket socket, int status, String text) throws IOException {
        byte[] body = text.getBytes(StandardCharsets.UTF_8);
        String header = "HTTP/1.1 " + status + " Response\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: " + body.length + "\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
        OutputStream output = socket.getOutputStream(); output.write(header.getBytes(StandardCharsets.US_ASCII)); output.write(body); output.flush();
    }
}
