package org.chatbox.antigravity;

import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

final class NativeHttp {
    static String enc(String value) throws Exception { return URLEncoder.encode(value, "UTF-8"); }
    static HttpURLConnection open(String url) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(20000); connection.setReadTimeout(60000);
        connection.setRequestProperty("User-Agent", "antigravity/1.20.5 android/arm64");
        return connection;
    }
    static String read(InputStream input, int limit) throws Exception {
        if (input == null) return "";
        try (InputStream stream = input; ByteArrayOutputStream result = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192]; int count;
            while ((count = stream.read(buffer)) != -1) {
                if (result.size() + count > limit) throw new IllegalArgumentException("Response exceeds the allowed size.");
                result.write(buffer, 0, count);
            }
            return result.toString("UTF-8");
        }
    }
    static JSONObject token(String form) throws Exception {
        HttpURLConnection connection = open("https://oauth2.googleapis.com/token");
        try {
            connection.setRequestMethod("POST"); connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
            connection.setDoOutput(true); byte[] bytes = form.getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(bytes.length);
            try (java.io.OutputStream output = connection.getOutputStream()) { output.write(bytes); }
            int status = connection.getResponseCode();
            if (status != 200) {
                String raw = read(connection.getErrorStream(), 262144);
                String error = new JSONObject(raw.isEmpty() ? "{}" : raw).optString("error");
                if ("invalid_grant".equals(error)) throw new ReauthException();
                throw new IllegalStateException("Google token exchange failed (HTTP " + status + "). Retry sign-in or check OAuth client configuration.");
            }
            return new JSONObject(read(connection.getInputStream(), 262144));
        } finally { connection.disconnect(); }
    }
    static JSONObject profile(String accessToken) throws Exception {
        HttpURLConnection connection = open("https://www.googleapis.com/oauth2/v1/userinfo");
        try {
            connection.setRequestProperty("Authorization", "Bearer " + accessToken);
            if (connection.getResponseCode() != 200) throw new IllegalStateException("Google account identity could not be verified.");
            return new JSONObject(read(connection.getInputStream(), 262144));
        } finally { connection.disconnect(); }
    }
    static final class ReauthException extends Exception {
        ReauthException() { super("Google authorization expired or was revoked. Add this account again to sign in."); }
    }
}
