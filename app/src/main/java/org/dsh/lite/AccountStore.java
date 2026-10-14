package org.dsh.lite;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import org.json.JSONArray;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Encrypted app-owned accounts and conversations; failures never silently reset data. */
public final class AccountStore {
    private static final Object LOCK = new Object();
    private static final String ALIAS = "org.dsh.lite.storage.v1";
    private final SharedPreferences prefs;
    public static class Account {
        public String id, email, project, accessToken, refreshToken;
        public long expiryMillis;
    }
    public AccountStore(Context context) {
        prefs = context.getApplicationContext().getSharedPreferences("lite_encrypted", Context.MODE_PRIVATE);
    }
    private SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore"); ks.load(null);
        if (!ks.containsAlias(ALIAS)) {
            KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            gen.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256).build()); gen.generateKey();
        }
        return (SecretKey) ks.getKey(ALIAS, null);
    }
    String encryptedRead(String name) {
        synchronized (LOCK) {
            String value = prefs.getString(name, null); if (value == null) return null;
            try {
                JSONObject j = new JSONObject(value); Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
                c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(j.getString("iv"), Base64.NO_WRAP)));
                c.updateAAD(name.getBytes(StandardCharsets.UTF_8));
                return new String(c.doFinal(Base64.decode(j.getString("data"), Base64.NO_WRAP)), StandardCharsets.UTF_8);
            } catch (Exception e) { throw failure(); }
        }
    }
    void encryptedWrite(String name, String value) {
        synchronized (LOCK) {
            try {
                SharedPreferences.Editor editor = prefs.edit();
                if (value == null) editor.remove(name);
                else {
                    Cipher c = Cipher.getInstance("AES/GCM/NoPadding"); c.init(Cipher.ENCRYPT_MODE, key());
                    c.updateAAD(name.getBytes(StandardCharsets.UTF_8));
                    editor.putString(name, new JSONObject().put("iv", Base64.encodeToString(c.getIV(), Base64.NO_WRAP))
                            .put("data", Base64.encodeToString(c.doFinal(value.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP)).toString());
                }
                if (!editor.commit()) throw failure();
            } catch (Exception e) { throw failure(); }
        }
    }
    private static IllegalStateException failure() {
        return new IllegalStateException("Encrypted storage is unavailable or damaged. Account data was not reset.");
    }
    private JSONObject database() {
        String raw = encryptedRead("accounts");
        try { return raw == null ? new JSONObject().put("accounts", new JSONArray()) : new JSONObject(raw); }
        catch (Exception e) { throw failure(); }
    }
    private static Account decode(JSONObject j) throws Exception {
        Account a = new Account(); a.id = j.getString("id"); a.email = j.optString("email"); a.project = j.optString("project");
        a.accessToken = j.optString("accessToken"); a.refreshToken = j.optString("refreshToken"); a.expiryMillis = j.optLong("expiryMillis"); return a;
    }
    private static JSONObject encode(Account a) throws Exception {
        return new JSONObject().put("id", a.id).put("email", a.email).put("project", a.project)
                .put("accessToken", a.accessToken).put("refreshToken", a.refreshToken).put("expiryMillis", a.expiryMillis);
    }
    public List<Account> list() {
        synchronized (LOCK) { try {
            JSONArray array = database().getJSONArray("accounts"); List<Account> result = new ArrayList<>();
            for (int i = 0; i < array.length(); i++) result.add(decode(array.getJSONObject(i))); return result;
        } catch (Exception e) { throw failure(); } }
    }
    public Account active() {
        synchronized (LOCK) { String id = database().optString("active", ""); for (Account a : list()) if (a.id.equals(id)) return a; return null; }
    }
    public void setActive(String id) {
        synchronized (LOCK) {
            boolean found = false; for (Account a : list()) if (a.id.equals(id)) found = true;
            if (!found) throw new IllegalArgumentException("Account no longer exists.");
            try { encryptedWrite("accounts", database().put("active", id).toString()); } catch (Exception e) { throw failure(); }
        }
    }
    public void upsert(Account a) { update(a, false); }
    void activateAuthenticated(Account a) { update(a, true); }
    private void update(Account a, boolean activate) {
        if (a == null || a.id == null || a.id.isEmpty()) throw new IllegalArgumentException("Missing account identity.");
        synchronized (LOCK) { try {
            JSONObject db = database(); JSONArray old = db.getJSONArray("accounts"), next = new JSONArray(); boolean replaced = false;
            for (int i = 0; i < old.length(); i++) { JSONObject item = old.getJSONObject(i);
                if (a.id.equals(item.getString("id"))) { next.put(encode(a)); replaced = true; } else next.put(item); }
            if (!replaced) next.put(encode(a));
            if (activate) db.put("active", a.id);
            encryptedWrite("accounts", db.put("accounts", next).toString());
        } catch (Exception e) { throw failure(); } }
    }
    public void remove(String id) {
        synchronized (LOCK) { try {
            JSONObject db = database(); JSONArray old = db.getJSONArray("accounts"), next = new JSONArray();
            for (int i = 0; i < old.length(); i++) if (!id.equals(old.getJSONObject(i).getString("id"))) next.put(old.getJSONObject(i));
            if (id.equals(db.optString("active"))) db.remove("active"); encryptedWrite("accounts", db.put("accounts", next).toString());
            String name = "index_" + digest(id), raw = encryptedRead(name);
            if (raw != null) { JSONArray index = new JSONArray(raw); for (int i = 0; i < index.length(); i++) encryptedWrite(index.getString(i), null); }
            encryptedWrite(name, null);
        } catch (Exception e) { throw failure(); } }
    }
    private static String digest(String value) {
        try { return Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP | Base64.URL_SAFE); }
        catch (Exception e) { throw failure(); }
    }
    private String conversationKey(String id, String model) {
        if (id == null || id.isEmpty() || model == null || model.isEmpty()) throw new IllegalArgumentException("Account and model are required.");
        boolean exists = false; for (Account a : list()) if (id.equals(a.id)) exists = true;
        if (!exists) throw new IllegalArgumentException("Account no longer exists.");
        return "conversation_" + digest(id + "\u0000" + model);
    }
    private JSONObject conversation(String id, String model) throws Exception {
        String name = conversationKey(id, model), raw = encryptedRead(name); if (raw != null) return new JSONObject(raw);
        JSONObject j = new JSONObject().put("sessionId", UUID.randomUUID().toString()).put("contents", new JSONArray());
        String indexKey = "index_" + digest(id), indexRaw = encryptedRead(indexKey);
        JSONArray index = indexRaw == null ? new JSONArray() : new JSONArray(indexRaw); boolean found = false;
        for (int i = 0; i < index.length(); i++) if (name.equals(index.getString(i))) found = true;
        if (!found) encryptedWrite(indexKey, index.put(name).toString()); encryptedWrite(name, j.toString()); return j;
    }
    public JSONArray loadConversation(String accountId, String model) {
        synchronized (LOCK) { try { return conversation(accountId, model).getJSONArray("contents"); }
        catch (Exception e) { if (e instanceof IllegalArgumentException) throw (IllegalArgumentException)e; throw failure(); } }
    }
    public void saveConversation(String accountId, String model, JSONArray contents) {
        if (contents == null) throw new IllegalArgumentException("Conversation is required.");
        synchronized (LOCK) { try { JSONObject j = conversation(accountId, model); encryptedWrite(conversationKey(accountId, model), j.put("contents", contents).toString()); }
        catch (Exception e) { if (e instanceof IllegalArgumentException) throw (IllegalArgumentException)e; throw failure(); } }
    }
    public String sessionId(String accountId, String model) {
        synchronized (LOCK) { try { return conversation(accountId, model).getString("sessionId"); }
        catch (Exception e) { if (e instanceof IllegalArgumentException) throw (IllegalArgumentException)e; throw failure(); } }
    }
}
