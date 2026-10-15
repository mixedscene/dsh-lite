package org.chatbox.antigravity;

import android.os.Bundle;
import android.view.ViewGroup;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.BridgeActivity;

public final class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AntigravityPlugin.class);
        registerPlugin(HttpTransportPlugin.class);
        registerPlugin(DocumentSaverPlugin.class);
        super.onCreate(savedInstanceState);
        applyWindowInsets();
    }

    /**
     * Reserves the system bars and the on-screen keyboard for the WebView.
     *
     * Android 15+ enforces edge-to-edge for targetSdk 35+ apps, which turns
     * android:windowSoftInputMode="adjustResize" into a no-op: the window keeps its full
     * height and the IME simply overlaps it, leaving the input box buried under the
     * keyboard.
     *
     * Capacitor ships a handler for this, but it only reserves the system bars and then
     * consumes every inset (android.adjustMarginsForEdgeToEdge, disabled in
     * capacitor.config.ts), so the keyboard never reaches the WebView either. This
     * listener mirrors Capacitor's behaviour and additionally folds the IME inset into the
     * bottom margin, which genuinely shrinks the WebView while the keyboard is open.
     *
     * The handler is self-adapting: on devices that are not edge-to-edge the framework
     * already reserves these areas and reports the insets as zero, so nothing is offset
     * twice on older Android versions.
     */
    private void applyWindowInsets() {
        if (getBridge() == null || getBridge().getWebView() == null) return;

        ViewCompat.setOnApplyWindowInsetsListener(getBridge().getWebView(), (view, windowInsets) -> {
            Insets bars =
                    windowInsets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime());

            ViewGroup.MarginLayoutParams params = (ViewGroup.MarginLayoutParams) view.getLayoutParams();
            params.leftMargin = bars.left;
            params.topMargin = bars.top;
            params.rightMargin = bars.right;
            params.bottomMargin = Math.max(bars.bottom, ime.bottom);
            view.setLayoutParams(params);

            // Do not pass the insets on to the web content.
            return WindowInsetsCompat.CONSUMED;
        });
    }
}
