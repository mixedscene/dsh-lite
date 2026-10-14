package org.dsh.lite;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Base64;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.HashMap;
import java.util.Map;

/** Owns the desktop OAuth IPv4 loopback listener for at most 170 seconds. */
public final class AuthService extends Service {
    public static final String ACTION_RESULT = "org.dsh.lite.AUTH_RESULT";
    private static final String REDIRECT = "http://localhost:51121/oauth-callback";
    private static final String PENDING = "pending_oauth";
    private static final long TIMEOUT = 170000;
    private static final String SCOPES = "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs";
    private final Object terminal = new Object();
    private final Handler handler = new Handler(Looper.getMainLooper());
    private volatile ServerSocket server;
    private volatile Socket client;
    private volatile Thread worker;
    private boolean finished, running;
    private AccountStore store;
    private final Runnable deadline = () -> finish("Sign-in timed out after 170 seconds. Try again.");
    public static void begin(Context context) {
        try { context.startForegroundService(new Intent(context, AuthService.class)); }
        catch (RuntimeException e) { broadcast(context, false, "Cannot start sign-in. Keep Lite open and try again."); }
    }
    private static void broadcast(Context context, boolean success, String message) {
        context.sendBroadcast(new Intent(ACTION_RESULT).setPackage("org.dsh.lite").putExtra("success", success).putExtra("message", message));
    }
    @Override public void onCreate() { super.onCreate(); store = new AccountStore(this); }
    @Override public IBinder onBind(Intent intent) { return null; }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        synchronized (terminal) { if (running || finished) return START_NOT_STICKY; running = true; }
        try {
            NotificationManager manager = getSystemService(NotificationManager.class);
            manager.createNotificationChannel(new NotificationChannel("oauth", "Account sign-in", NotificationManager.IMPORTANCE_LOW));
            Intent activity = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            PendingIntent tap = PendingIntent.getActivity(this, 1, activity, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            Notification notification = new Notification.Builder(this, "oauth").setSmallIcon(android.R.drawable.ic_lock_lock)
                    .setContentTitle("Signing in to Antigravity").setContentText("Finish Google sign-in in your browser. Tap to return to Lite.")
                    .setContentIntent(tap).setOngoing(true).build();
            if (Build.VERSION.SDK_INT >= 34) startForeground(51121, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SHORT_SERVICE);
            else startForeground(51121, notification);
            handler.postDelayed(deadline, TIMEOUT); worker = new Thread(this::authorize, "lite-oauth"); worker.start();
            return START_REDELIVER_INTENT;
        } catch (Exception e) { finish("Cannot initialize the foreground sign-in service."); return START_NOT_STICKY; }
    }
    private static String random(int bytes) {
        byte[] b = new byte[bytes]; new SecureRandom().nextBytes(b);
        return Base64.encodeToString(b, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }
    private void authorize() {
        try {
            if (OAuthConfig.CLIENT_ID.isEmpty() || OAuthConfig.CLIENT_SECRET.isEmpty()) throw new AuthError("OAuth client configuration is missing from this build.");
            String raw = store.encryptedRead(PENDING); JSONObject pending; boolean launch = raw == null;
            if (raw == null) {
                pending = new JSONObject().put("state", random(32)).put("verifier", random(64)).put("created", System.currentTimeMillis());
                synchronized (terminal) { if (finished) return; store.encryptedWrite(PENDING, pending.toString()); }
            } else pending = new JSONObject(raw);
            long remaining = TIMEOUT - (System.currentTimeMillis() - pending.getLong("created"));
            if (remaining <= 0 || remaining > TIMEOUT) throw new AuthError("The previous sign-in expired. Try again.");
            synchronized (terminal) { if (finished) return; handler.removeCallbacks(deadline); handler.postDelayed(deadline, remaining); }
            String state = pending.getString("state"), verifier = pending.getString("verifier");
            if (state.length() < 32 || !verifier.matches("[A-Za-z0-9_-]{43,128}")) throw new AuthError("Pending sign-in data is invalid. Try again.");
            ServerSocket listening = new ServerSocket();
            synchronized (terminal) {
                if (finished) { listening.close(); return; }
                server = listening; listening.setReuseAddress(true);
                listening.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), 51121), 4); listening.setSoTimeout(1000);
            }
            String challenge = Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII)), Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
            String url = "https://accounts.google.com/o/oauth2/v2/auth?client_id=" + LiteApi.enc(OAuthConfig.CLIENT_ID)
                    + "&redirect_uri=" + LiteApi.enc(REDIRECT) + "&response_type=code&scope=" + LiteApi.enc(SCOPES)
                    + "&state=" + LiteApi.enc(state) + "&code_challenge=" + LiteApi.enc(challenge) + "&code_challenge_method=S256"
                    + "&access_type=offline&prompt=" + LiteApi.enc("select_account consent");
            if (launch) synchronized (terminal) { if (finished) return; startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); }
            while (!isFinished()) {
                Socket socket; try { socket = listening.accept(); } catch (SocketTimeoutException ignored) { continue; }
                client = socket;
                try (Socket ignored = socket) {
                    socket.setSoTimeout(3000); if (!socket.getInetAddress().isLoopbackAddress()) continue;
                    String request = readRequest(socket.getInputStream()); String[] first = request.split("\\r\\n", 2)[0].split(" ");
                    if (first.length != 3 || !"GET".equals(first[0])) { reply(socket, 400, "Invalid request."); continue; }
                    URI uri; try { uri = new URI(first[1]); } catch (Exception e) { reply(socket, 400, "Invalid callback."); continue; }
                    if (uri.isAbsolute() || !"/oauth-callback".equals(uri.getPath())) { reply(socket, 404, "Not found."); continue; }
                    Map<String,String> query; try { query = query(uri.getRawQuery()); } catch (Exception e) { reply(socket, 400, "Invalid callback parameters."); continue; }
                    String received = query.get("state");
                    if (received == null || !MessageDigest.isEqual(state.getBytes(StandardCharsets.UTF_8), received.getBytes(StandardCharsets.UTF_8))) {
                        reply(socket, 400, "Sign-in state did not match. Return to the original sign-in browser."); continue;
                    }
                    if (query.containsKey("error")) { reply(socket, 200, "Sign-in cancelled. You can return to Lite."); throw new AuthError("Google sign-in was cancelled or denied. Your active account was not changed."); }
                    String code = query.get("code");
                    if (code == null || code.isEmpty()) { reply(socket, 400, "Missing authorization code."); throw new AuthError("Google callback contained no authorization code."); }
                    reply(socket, 200, "Google sign-in received. Return to Lite to see the result.");
                    listening.close(); exchange(code, verifier); return;
                } catch (SocketTimeoutException ignored) { /* Global deadline still applies. */ }
                finally { client = null; }
            }
        } catch (AuthError e) { finish(e.getMessage()); }
        catch (IllegalStateException e) { finish("Encrypted storage is unavailable. Sign-in could not be saved; existing account data was not reset."); }
        catch (LiteApi.HttpFailure e) { finish(e.getMessage()); }
        catch (Exception e) { finish("Sign-in could not complete. Check network access and that localhost port 51121 is free, then try again."); }
    }
    private void exchange(String code, String verifier) throws Exception {
        if (isFinished()) return;
        JSONObject t = LiteApi.tokenRequest("grant_type=authorization_code&code=" + LiteApi.enc(code) + "&client_id=" + LiteApi.enc(OAuthConfig.CLIENT_ID)
                + "&client_secret=" + LiteApi.enc(OAuthConfig.CLIENT_SECRET) + "&redirect_uri=" + LiteApi.enc(REDIRECT) + "&code_verifier=" + LiteApi.enc(verifier));
        String token = t.optString("access_token"); long seconds = t.optLong("expires_in", 0);
        if (token.isEmpty() || seconds <= 0 || seconds > 86400) throw new AuthError("Google returned an invalid token response.");
        if (isFinished()) return;
        JSONObject p = LiteApi.profile(token); AccountStore.Account a = new AccountStore.Account();
        a.id = p.getString("id"); a.email = p.getString("email"); a.accessToken = token;
        a.refreshToken = t.optString("refresh_token", ""); a.expiryMillis = System.currentTimeMillis() + seconds * 1000;
        for (AccountStore.Account old : store.list()) if (a.id.equals(old.id) && a.refreshToken.isEmpty()) a.refreshToken = old.refreshToken;
        if (a.refreshToken.isEmpty()) throw new AuthError("Google returned no refresh token. Revoke this app's existing grant in your Google account and sign in again with consent.");
        if (isFinished()) return;
        try { new LiteApi(store).discover(a); } catch (Exception e) {
            if (e.getMessage() != null && e.getMessage().startsWith("This account has no Antigravity project.")) throw new AuthError(e.getMessage());
            throw new AuthError("Could not load Antigravity access for this account. Complete onboarding and privacy consent in the official desktop application, then retry. Lite never accepts privacy consent automatically.");
        }
        synchronized (terminal) {
            if (finished) return;
            store.encryptedWrite(PENDING, null); store.activateAuthenticated(a);
            finished = true; cleanup(); broadcast(this, true, "Signed in as " + a.email + "."); stopSelf();
        }
    }
    private boolean isFinished() { synchronized (terminal) { return finished; } }
    private void finish(String message) {
        synchronized (terminal) {
            if (finished) return; finished = true;
            try { store.encryptedWrite(PENDING, null); }
            catch (RuntimeException e) { message = "Encrypted storage is unavailable. Pending sign-in could not be cleared; existing account data was not reset."; }
            cleanup(); broadcast(this, false, message); stopSelf();
        }
    }
    private void cleanup() {
        handler.removeCallbacks(deadline);
        try { if (server != null) server.close(); } catch (Exception ignored) { }
        try { if (client != null) client.close(); } catch (Exception ignored) { }
        Thread thread = worker; if (thread != null && thread != Thread.currentThread()) thread.interrupt(); stopForeground(STOP_FOREGROUND_REMOVE);
    }
    @Override public void onDestroy() {
        synchronized (terminal) { finished = true; cleanup(); } // Preserve pending PKCE on interruption for restart recovery.
        super.onDestroy();
    }
    @Override public void onTimeout(int startId) { finish("Android stopped sign-in at the foreground service time limit. Try again."); }
    @Override public void onTimeout(int startId, int fgsType) { finish("Android stopped sign-in at the foreground service time limit. Try again."); }
    private static class AuthError extends Exception { AuthError(String message) { super(message); } }
    private static String readRequest(InputStream in) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(); int next, matched = 0;
        while ((next = in.read()) != -1) {
            bytes.write(next); if (bytes.size() > 16384) throw new AuthError("Local callback request was too large.");
            if ((matched == 0 || matched == 2) && next == '\r') matched++;
            else if ((matched == 1 || matched == 3) && next == '\n') { matched++; if (matched == 4) return bytes.toString("US-ASCII"); }
            else matched = next == '\r' ? 1 : 0;
        }
        return bytes.toString("US-ASCII");
    }
    private static Map<String,String> query(String raw) throws Exception {
        Map<String,String> result = new HashMap<>(); if (raw == null) return result;
        for (String pair : raw.split("&")) {
            String[] kv = pair.split("=", 2); String key = URLDecoder.decode(kv[0], "UTF-8");
            if (result.containsKey(key)) throw new Exception("Duplicate callback parameter.");
            result.put(key, kv.length == 2 ? URLDecoder.decode(kv[1], "UTF-8") : "");
        }
        return result;
    }
    private static void reply(Socket socket, int status, String text) throws Exception {
        byte[] body = text.getBytes(StandardCharsets.UTF_8);
        String header = "HTTP/1.1 " + status + (status == 200 ? " OK" : status == 404 ? " Not Found" : " Bad Request")
                + "\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: " + body.length + "\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
        OutputStream out = socket.getOutputStream(); out.write(header.getBytes(StandardCharsets.US_ASCII)); out.write(body); out.flush();
    }
}
