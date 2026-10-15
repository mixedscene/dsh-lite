package org.chatbox.antigravity;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/** Copies a Filesystem cache export to a destination chosen by the user. */
@CapacitorPlugin(name = "DocumentSaver")
public final class DocumentSaverPlugin extends Plugin {
    private final AtomicBoolean busy = new AtomicBoolean();
    private final ExecutorService worker = Executors.newSingleThreadExecutor();

    static File cacheSource(File cache, String source) throws Exception {
        if (source == null) throw new IllegalArgumentException("Export source is required.");
        File file;
        if (source.startsWith("/")) file = new File(source).getCanonicalFile();
        else {
            java.net.URI uri = new java.net.URI(source);
            if (!"file".equals(uri.getScheme())) throw new IllegalArgumentException("Export source must be a cache file.");
            if (uri.getRawQuery() != null || uri.getRawFragment() != null || uri.getRawAuthority() != null)
                throw new IllegalArgumentException("Invalid export source.");
            file = new File(uri).getCanonicalFile();
        }
        if (!file.getPath().startsWith(cache.getCanonicalPath() + File.separator) || !file.isFile())
            throw new IllegalArgumentException("Export source must be an existing app cache file.");
        return file;
    }
    @PluginMethod public void saveFile(PluginCall call) {
        if (!busy.compareAndSet(false, true)) { call.reject("A document save is already in progress."); return; }
        try {
            String source = call.getString("sourceUri"), name = call.getString("suggestedName");
            if (source == null || name == null || name.isEmpty()) throw new IllegalArgumentException("Export source and suggested name are required.");
            cacheSource(getContext().getCacheDir(), source);
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                .setType(call.getString("mimeType", "application/octet-stream")).putExtra(Intent.EXTRA_TITLE, new File(name).getName());
            getActivity().runOnUiThread(() -> {
                try { startActivityForResult(call, intent, "documentSelected"); }
                catch (RuntimeException error) { busy.set(false); call.reject("No system document selector is available."); }
            });
        } catch (Exception error) { busy.set(false); call.reject("Unable to prepare the cache file for export."); }
    }
    @ActivityCallback private void documentSelected(PluginCall call, ActivityResult result) {
        if (call == null) { busy.set(false); return; }
        Uri target = result.getData() == null ? null : result.getData().getData();
        if (result.getResultCode() != Activity.RESULT_OK || target == null) {
            busy.set(false); call.reject("Save canceled", "SAVE_CANCELED"); return;
        }
        worker.execute(() -> {
            try {
                File source = cacheSource(getContext().getCacheDir(), call.getString("sourceUri"));
                try (InputStream input = new FileInputStream(source); OutputStream output = getContext().getContentResolver().openOutputStream(target, "w")) {
                    if (output == null) throw new IllegalStateException("Document destination is unavailable.");
                    byte[] buffer = new byte[65536]; int count;
                    while ((count = input.read(buffer)) != -1) {
                        if (Thread.currentThread().isInterrupted()) throw new java.io.InterruptedIOException("Document save interrupted.");
                        output.write(buffer, 0, count);
                    }
                }
                call.resolve(new JSObject().put("uri", target.toString()));
            } catch (Exception error) { call.reject("Unable to save the exported document."); }
            finally { busy.set(false); }
        });
    }
    @Override protected void handleOnDestroy() { worker.shutdownNow(); super.handleOnDestroy(); }
}
