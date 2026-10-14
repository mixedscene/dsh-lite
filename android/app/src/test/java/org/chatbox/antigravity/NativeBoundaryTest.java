package org.chatbox.antigravity;

import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

/** Trust-boundary checks run offline without an account or Google credentials. */
public class NativeBoundaryTest {
    private interface Checked { void run() throws Exception; }
    private void rejects(Checked action) throws Exception {
        try { action.run(); fail("Expected boundary rejection"); }
        catch (IllegalArgumentException expected) { assertNotNull(expected.getMessage()); }
    }
    @Test public void permitsOnlyRequiredGoogleMethods() throws Exception {
        AntigravityPlugin.allowed("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", "POST");
        AntigravityPlugin.allowed("https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels", "POST");
        AntigravityPlugin.allowed("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse", "POST");
        AntigravityPlugin.allowed("https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse", "POST");
    }
    @Test public void rejectsCredentialExfiltrationAndRedirectEndpoints() throws Exception {
        rejects(() -> AntigravityPlugin.allowed("https://cloudcode-pa.googleapis.com.evil.test/v1internal:loadCodeAssist", "POST"));
        rejects(() -> AntigravityPlugin.allowed("https://user@cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", "POST"));
        rejects(() -> AntigravityPlugin.allowed("http://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", "POST"));
        rejects(() -> AntigravityPlugin.allowed("https://cloudcode-pa.googleapis.com:8443/v1internal:loadCodeAssist", "POST"));
        rejects(() -> AntigravityPlugin.allowed("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist?redirect=https://evil.test", "POST"));
        rejects(() -> AntigravityPlugin.allowed("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist#fragment", "POST"));
        rejects(() -> AntigravityPlugin.allowed("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", "GET"));
        rejects(() -> AntigravityPlugin.allowed("https://cloudcode-pa.googleapis.com/v1internal:executeCommand", "POST"));
    }
    @Test public void rejectsNestedModelTools() throws Exception {
        AntigravityPlugin.noTools(new JSONObject("{\"request\":{\"contents\":[{\"parts\":[{\"text\":\"Skill mentions tools as text only\"}]}]}}"));
        rejects(() -> AntigravityPlugin.noTools(new JSONObject("{\"request\":{\"tools\":[{\"functionDeclarations\":[]}]}}")));
        rejects(() -> AntigravityPlugin.noTools(new JSONObject("{\"contents\":[{\"parts\":[{\"functionCall\":{\"name\":\"shell\"}}]}]}")));
    }
    @Test public void callbackParametersDecodeOnceAndRejectAmbiguity() throws Exception {
        assertEquals("abc+123", OAuthService.query("state=abc%2B123&code=c").get("state"));
        rejects(() -> OAuthService.query("state=a&state=b"));
        rejects(() -> OAuthService.query("state=a&%73tate=b"));
    }
    @Test public void metadataNeverExposesCredentials() throws Exception {
        JSONObject raw = new JSONObject().put("id", "google-sub-123").put("email", "user@example.test")
            .put("accessToken", "private-access").put("refreshToken", "private-refresh").put("expiresAt", 1);
        JSONObject safe = AccountStore.metadata(raw);
        assertEquals("google-sub-123", safe.getString("id"));
        assertFalse(safe.has("accessToken")); assertFalse(safe.has("refreshToken")); assertFalse(safe.has("expiresAt"));
    }
}
