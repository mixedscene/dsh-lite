package org.chatbox.antigravity;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import org.json.JSONArray;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Tokens never leave this native store. All mutations reread under the same lock. */
final class AccountStore {
    private static final Object LOCK = new Object();
    private static final String ALIAS = "org.chatbox.antigravity.accounts.v1";
    private final SharedPreferences prefs;
    AccountStore(Context context) { prefs = context.getSharedPreferences("antigravity_private", Context.MODE_PRIVATE); }
    private static IllegalStateException failure() {
        return new IllegalStateException("Encrypted account storage is unavailable or damaged. Existing data was not reset. Reinstall only after exporting your conversations.");
    }
    private SecretKey key(boolean create) throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore"); ks.load(null);
        if (!ks.containsAlias(ALIAS)) {
            if (!create || prefs.contains("accounts")) throw failure();
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build());
            generator.generateKey();
        }
        return (SecretKey) ks.getKey(ALIAS, null);
    }
    private JSONObject database() {
        String raw = prefs.getString("accounts", null);
        try {
            if (raw == null) return new JSONObject().put("accounts", new JSONArray());
            JSONObject envelope = new JSONObject(raw);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, Base64.decode(envelope.getString("iv"), Base64.NO_WRAP)));
            cipher.updateAAD("accounts.v1".getBytes(StandardCharsets.UTF_8));
            return new JSONObject(new String(cipher.doFinal(Base64.decode(envelope.getString("data"), Base64.NO_WRAP)), StandardCharsets.UTF_8));
        } catch (Exception e) { throw failure(); }
    }
    private void save(JSONObject db) {
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key(true));
            cipher.updateAAD("accounts.v1".getBytes(StandardCharsets.UTF_8));
            JSONObject envelope = new JSONObject().put("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
                .put("data", Base64.encodeToString(cipher.doFinal(db.toString().getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP));
            if (!prefs.edit().putString("accounts", envelope.toString()).commit()) throw failure();
        } catch (Exception e) { throw failure(); }
    }
    static JSONObject metadata(JSONObject account) throws Exception {
        JSONObject safe = new JSONObject();
        for (String key : new String[]{"id", "email", "name", "picture", "project", "modelCache", "updatedAt", "reauthRequired"})
            if (account.has(key)) safe.put(key, account.get(key));
        if (!safe.has("reauthRequired")) safe.put("reauthRequired", false);
        return safe;
    }
    JSONObject list() throws Exception { return list(true); }
    JSONObject list(boolean consumeError) throws Exception {
        synchronized (LOCK) {
            JSONObject db = database(), result = new JSONObject(); JSONArray safe = new JSONArray(), all = db.getJSONArray("accounts");
            for (int i = 0; i < all.length(); i++) safe.put(metadata(all.getJSONObject(i)));
            result.put("accounts", safe).put("oauthPending", OAuthService.isPending());
            if (db.has("active")) result.put("activeAccountId", db.getString("active"));
            if (prefs.getBoolean("oauth_pending", false) && !OAuthService.isRunning()) {
                result.put("oauthError", "Sign-in was interrupted by Android. Add the account again.");
                if (consumeError) prefs.edit().remove("oauth_pending").commit();
            }
            String outcome = prefs.getString("oauth_error", null);
            if (outcome != null) { result.put("oauthError", outcome); if (consumeError) prefs.edit().remove("oauth_error").commit(); }
            return result;
        }
    }
    JSONObject get(String id) throws Exception {
        synchronized (LOCK) { return new JSONObject(find(database(), id).toString()); }
    }
    private static JSONObject find(JSONObject db, String id) throws Exception {
        JSONArray all = db.getJSONArray("accounts");
        for (int i = 0; i < all.length(); i++) if (id.equals(all.getJSONObject(i).getString("id"))) return all.getJSONObject(i);
        throw new IllegalArgumentException("Account no longer exists.");
    }
    JSONObject activate(String id) throws Exception {
        synchronized (LOCK) { JSONObject db = database(), account = find(db, id); db.put("active", id); save(db); return metadata(account); }
    }
    JSONObject authenticate(JSONObject profile, JSONObject tokens) throws Exception {
        synchronized (LOCK) {
            String id = profile.getString("id"); if (id.isEmpty()) throw new IllegalArgumentException("Google returned no stable account ID.");
            JSONObject db = database(), account;
            try { account = find(db, id); } catch (IllegalArgumentException e) { account = new JSONObject().put("id", id); db.getJSONArray("accounts").put(account); }
            for (String key : new String[]{"email", "name", "picture"}) account.put(key, profile.optString(key));
            applyTokens(account, tokens);
            if (account.optString("refreshToken").isEmpty()) throw new IllegalArgumentException("Google returned no refresh token. Reauthorize with consent.");
            db.put("active", id); save(db); return metadata(account);
        }
    }
    private static void applyTokens(JSONObject account, JSONObject tokens) throws Exception {
        String access = tokens.optString("access_token"); long expiry = tokens.optLong("expires_in");
        if (access.isEmpty() || expiry <= 0 || expiry > 86400) throw new IllegalArgumentException("Google returned an invalid token response.");
        account.put("accessToken", access).put("expiresAt", System.currentTimeMillis() + expiry * 1000).put("updatedAt", System.currentTimeMillis()).put("reauthRequired", false);
        if (!tokens.optString("refresh_token").isEmpty()) account.put("refreshToken", tokens.getString("refresh_token"));
    }
    void refreshed(String id, JSONObject tokens) throws Exception {
        synchronized (LOCK) { JSONObject db = database(); applyTokens(find(db, id), tokens); save(db); }
    }
    void reauth(String id) throws Exception {
        synchronized (LOCK) { JSONObject db = database(); find(db, id).put("reauthRequired", true); save(db); }
    }
    void cache(String id, String project, Object models) throws Exception {
        synchronized (LOCK) {
            JSONObject db = database(), account = find(db, id);
            if (project != null) account.put("project", project);
            if (models != null) account.put("modelCache", models);
            account.put("updatedAt", System.currentTimeMillis()); save(db);
        }
    }
    void remove(String id) throws Exception {
        synchronized (LOCK) {
            JSONObject db = database(); JSONArray all = db.getJSONArray("accounts"), next = new JSONArray();
            for (int i = 0; i < all.length(); i++) if (!id.equals(all.getJSONObject(i).getString("id"))) next.put(all.getJSONObject(i));
            db.put("accounts", next); if (id.equals(db.optString("active"))) db.remove("active"); save(db);
        }
    }
    void pending(boolean pending) {
        SharedPreferences.Editor edit = prefs.edit().putBoolean("oauth_pending", pending);
        if (pending) edit.remove("oauth_error");
        if (!edit.commit()) throw failure();
    }
    void outcome(String error) {
        SharedPreferences.Editor edit = prefs.edit();
        if (error == null) edit.remove("oauth_error"); else edit.putString("oauth_error", error);
        if (!edit.commit()) throw failure();
    }
}
