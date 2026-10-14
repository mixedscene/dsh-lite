package org.dsh.lite;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.database.Cursor;
import android.provider.OpenableColumns;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;

/** Reads only explicitly picked Markdown; never executes files or retains URI access. */
public final class SkillStore {
    public static final int MAX_BYTES = 256 * 1024;
    public static final class Skill {
        public final String id, name, text;
        Skill(String id, String name, String text) { this.id = id; this.name = name; this.text = text; }
        @Override public String toString() { return name; }
    }
    private final SharedPreferences prefs;
    private final Context app;
    public SkillStore(Context context) {
        app = context.getApplicationContext();
        prefs = app.getSharedPreferences("lite_skills", Context.MODE_PRIVATE);
    }
    public synchronized List<Skill> list() {
        List<Skill> result = new ArrayList<>();
        try {
            JSONArray data = new JSONArray(prefs.getString("items", "[]"));
            for (int i = 0; i < data.length(); i++) {
                JSONObject item = data.getJSONObject(i);
                result.add(new Skill(item.getString("id"), item.getString("name"), item.getString("text")));
            }
        } catch (Exception ignored) { }
        return result;
    }
    public synchronized Skill get(String id) {
        for (Skill skill : list()) if (skill.id.equals(id)) return skill;
        return null;
    }
    public synchronized String selected(String accountId, String model) {
        String id = prefs.getString(selectionKey(accountId, model), "");
        return id; // Retain deleted selections to protect an existing conversation prompt.
    }
    public synchronized void select(String accountId, String model, String id) {
        prefs.edit().putString(selectionKey(accountId, model), get(id) == null ? "" : id).apply();
    }
    private String selectionKey(String accountId, String model) {
        return "selection:" + new JSONArray().put(accountId).put(model).toString();
    }
    public synchronized void delete(String id) throws Exception {
        List<Skill> items = list();
        items.removeIf(item -> item.id.equals(id));
        persist(items);
    }
    public Skill importMarkdown(Uri uri) throws Exception {
        if (uri == null || !"content".equals(uri.getScheme())) throw new Exception("请选择一个 Markdown 文件。");
        String name = "";
        try (Cursor cursor = app.getContentResolver().query(uri,
                new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) name = cursor.getString(0);
        }
        if (name == null) name = "";
        String lower = name.toLowerCase(Locale.ROOT);
        if (!lower.endsWith(".md") && !lower.endsWith(".markdown"))
            throw new Exception("只支持 SKILL.md 或其他 Markdown 文件（.md / .markdown）。");
        byte[] bytes;
        try (InputStream input = app.getContentResolver().openInputStream(uri);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            if (input == null) throw new Exception("无法读取所选文件。");
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) != -1) {
                if (output.size() + count > MAX_BYTES) throw new Exception("技能文件不能超过 256 KB。");
                output.write(buffer, 0, count);
            }
            bytes = output.toByteArray();
        }
        String text;
        try {
            text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
        } catch (Exception e) { throw new Exception("文件需使用 UTF-8 编码。"); }
        if (text.startsWith("\uFEFF")) text = text.substring(1);
        if (text.trim().isEmpty() || text.indexOf('\0') >= 0) throw new Exception("请选择非空的 Markdown 文本。");
        Skill skill = new Skill(UUID.randomUUID().toString(), name, text);
        synchronized (this) {
            List<Skill> items = list();
            if (items.size() >= 32) throw new Exception("最多保存 32 个技能，请先删除不需要的技能。");
            items.add(skill);
            persist(items);
        }
        return skill;
    }
    private void persist(List<Skill> items) throws Exception {
        JSONArray data = new JSONArray();
        for (Skill skill : items) data.put(new JSONObject().put("id", skill.id).put("name", skill.name).put("text", skill.text));
        if (!prefs.edit().putString("items", data.toString()).commit()) throw new Exception("技能保存失败，请检查可用空间。");
    }
}
