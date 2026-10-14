package org.chatbox.antigravity;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
public final class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AntigravityPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
