package org.dsh.lite;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.*;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.*;
import android.view.*;
import android.widget.*;
import org.json.*;
import java.lang.ref.WeakReference;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** Native views; background workers retain no Activity or view strongly. */
public final class MainActivity extends Activity {
    private static final String AUTH_ACTION = "org.dsh.lite.AUTH_RESULT";
    private static final int PICK_SKILL = 301;
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private final ExecutorService executor = Executors.newFixedThreadPool(2);
    private AccountStore accounts;
    private SkillStore skills;
    private LiteApi api;
    private SharedPreferences prefs;
    private Spinner accountSpinner, modelSpinner, skillSpinner;
    private Button addAccount, removeAccount, clear, importSkill, deleteSkill, send;
    private EditText input;
    private TextView status, live;
    private ScrollView scroll;
    private LinearLayout messages;
    private List<AccountStore.Account> accountItems = new ArrayList<>();
    private List<String> models = new ArrayList<>();
    private List<SkillStore.Skill> skillItems = new ArrayList<>();
    private String accountId = "", model = "gemini-3-flash", skillId = "";
    private JSONArray history = new JSONArray();
    private AtomicBoolean cancellation;
    private boolean streaming, importing, receiverRegistered, pendingAuthRefresh, historyReady;
    private volatile boolean destroyed;
    private int discoveryEpoch, foreground, background, surface, accent;
    private final BroadcastReceiver authReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            if (destroyed || !AUTH_ACTION.equals(intent.getAction())) return;
            if (intent.getBooleanExtra("success", false)) {
                if (streaming) { pendingAuthRefresh = true; status.setText("登录成功，当前回复结束后更新账号。"); }
                else { refreshAccounts(); status.setText("登录成功。"); discoverModels(); }
            } else status.setText("登录未完成：" + safeMessage(intent.getStringExtra("message")) + " 可点击添加账号重试。");
        }
    };
    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        accounts = new AccountStore(getApplicationContext()); skills = new SkillStore(getApplicationContext());
        api = new LiteApi(accounts); prefs = getSharedPreferences("lite_ui", MODE_PRIVATE);
        buildUi();
        IntentFilter filter = new IntentFilter(AUTH_ACTION);
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(authReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        else registerReceiver(authReceiver, filter);
        receiverRegistered = true; refreshAccounts();
        MAIN.post(() -> { if (!destroyed) discoverModels(); });
    }
    private void buildUi() {
        boolean dark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        foreground = dark ? Color.rgb(235,238,245) : Color.rgb(25,31,44);
        background = dark ? Color.rgb(17,21,29) : Color.rgb(247,248,252);
        surface = dark ? Color.rgb(34,41,55) : Color.WHITE;
        accent = dark ? Color.rgb(157,194,255) : Color.rgb(34,92,180);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        getWindow().setStatusBarColor(Color.TRANSPARENT); getWindow().setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController c = getWindow().getInsetsController();
            int flags = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            if (c != null) c.setSystemBarsAppearance(dark ? 0 : flags, flags);
        } else {
            int flags = View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION;
            if (!dark) flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            getWindow().getDecorView().setSystemUiVisibility(flags);
        }
        LinearLayout root = column(); root.setBackgroundColor(background);
        root.setPadding(dp(12),dp(8),dp(12),dp(8));
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            int left,top,right,bottom;
            if (Build.VERSION.SDK_INT >= 30) {
                Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                left=i.left; top=i.top; right=i.right; bottom=i.bottom;
            } else {
                left=insets.getSystemWindowInsetLeft(); top=insets.getSystemWindowInsetTop();
                right=insets.getSystemWindowInsetRight(); bottom=insets.getSystemWindowInsetBottom();
            }
            v.setPadding(dp(12)+left,dp(8)+top,dp(12)+right,dp(8)+bottom); return insets;
        });
        TextView title=label("DSH Lite",23); title.setTypeface(Typeface.DEFAULT,Typeface.BOLD); root.addView(title);
        LinearLayout ar=row(); accountSpinner=new Spinner(this); accountSpinner.setContentDescription("选择账号"); ar.addView(accountSpinner,weighted());
        addAccount=button("添加账号"); removeAccount=button("移除"); ar.addView(addAccount); ar.addView(removeAccount); root.addView(ar);
        LinearLayout mr=row(); mr.addView(label("模型",14)); modelSpinner=new Spinner(this); modelSpinner.setContentDescription("选择模型");
        mr.addView(modelSpinner,weighted()); clear=button("清空对话"); mr.addView(clear); root.addView(mr);
        LinearLayout sr=row(); sr.addView(label("技能",14)); skillSpinner=new Spinner(this); skillSpinner.setContentDescription("选择对话技能");
        sr.addView(skillSpinner,weighted()); importSkill=button("导入"); deleteSkill=button("删除"); sr.addView(importSkill); sr.addView(deleteSkill); root.addView(sr);
        root.addView(label("技能仅提供对话提示，不执行工具或脚本，也不读取其他文件。",12));
        status=label("添加账号后即可开始对话。",13); status.setTextColor(accent); status.setPadding(0,dp(5),0,dp(5)); root.addView(status);
        scroll=new ScrollView(this); scroll.setFillViewport(true); messages=column(); scroll.addView(messages);
        root.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));
        LinearLayout composer=row(); input=new EditText(this); input.setTextColor(foreground); input.setHintTextColor(accent); input.setHint("输入消息…");
        input.setMinLines(1); input.setMaxLines(5); input.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        input.setBackground(bubble(surface)); input.setPadding(dp(10),dp(8),dp(10),dp(8)); composer.addView(input,weighted());
        send=button("发送"); composer.addView(send); root.addView(composer); setContentView(root); root.requestApplyInsets();
        addAccount.setOnClickListener(v -> {
            try { AuthService.begin(this); status.setText("请在浏览器中完成登录，然后返回这里。"); }
            catch (Exception e) { status.setText("无法开始登录："+safeError(e)+" 可重试。"); }
        });
        removeAccount.setOnClickListener(v -> confirmRemoveAccount());
        clear.setOnClickListener(v -> {
            if (streaming || accountId.isEmpty()) return;
            new AlertDialog.Builder(this).setTitle("清空当前对话？").setMessage("只清空当前账号和模型的聊天记录。")
                .setNegativeButton("取消",null).setPositiveButton("清空",(d,w) -> clearConversation()).show();
        });
        importSkill.setOnClickListener(v -> {
            Intent intent=new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
            intent.putExtra(Intent.EXTRA_MIME_TYPES,new String[]{"text/markdown","text/x-markdown","text/plain","application/octet-stream"});
            try { startActivityForResult(intent,PICK_SKILL); } catch (Exception e) { status.setText("无法打开文件选择："+safeError(e)); }
        });
        deleteSkill.setOnClickListener(v -> confirmDeleteSkill());
        send.setOnClickListener(v -> {
            if (streaming) { cancellation.set(true); send.setEnabled(false); status.setText("正在停止，未完成回复不会保存…"); }
            else sendMessage();
        });
    }
    private void refreshAccounts() {
        try { refreshAccountsImpl(); }
        catch (Exception e) {
            accountId=""; accountItems=new ArrayList<>(); history=new JSONArray(); historyReady=false; skillId="";
            accountSpinner.setOnItemSelectedListener(null); accountSpinner.setAdapter(adapter(Collections.singletonList("账号暂不可用")));
            populateModels(Collections.emptyList()); populateSkills(); renderHistory(); updateControls();
            status.setText("本机账号数据无法读取，请检查设备存储；原数据未被清空。");
        }
    }
    private void refreshAccountsImpl() {
        if (streaming) return;
        accountSpinner.setOnItemSelectedListener(null); accountItems=accounts.list();
        AccountStore.Account active=accounts.active(); int selection=-1; List<String> labels=new ArrayList<>();
        for (int i=0;i<accountItems.size();i++) {
            AccountStore.Account a=accountItems.get(i); labels.add(a.email==null || a.email.isEmpty() ? "账号 "+(i+1) : a.email);
            if (active!=null && a.id.equals(active.id)) selection=i;
        }
        if (selection<0 && !accountItems.isEmpty()) { selection=0; accounts.setActive(accountItems.get(0).id); }
        if (labels.isEmpty()) labels.add("尚未添加账号");
        accountSpinner.setAdapter(adapter(labels)); accountSpinner.setSelection(Math.max(0,selection));
        accountId=selection<0 ? "" : accountItems.get(selection).id;
        model=prefs.getString("model:"+accountId,"gemini-3-flash"); loadModelChoices(); reloadConversation();
        accountSpinner.setOnItemSelectedListener(new SelectionListener() { void chosen(int p) {
            if (streaming || p>=accountItems.size()) return;
            String id=accountItems.get(p).id; if (id.equals(accountId)) return;
            try {
                accounts.setActive(id); accountId=id; model=prefs.getString("model:"+accountId,"gemini-3-flash");
                loadModelChoices(); reloadConversation(); discoverModels();
            } catch(Exception e) {
                refreshAccounts(); status.setText("切换账号失败："+safeError(e));
            }
        }}); updateControls();
    }
    private void loadModelChoices() {
        List<String> cached=new ArrayList<>();
        try { JSONArray a=new JSONArray(prefs.getString("models:"+accountId,"[]")); for(int i=0;i<a.length();i++) cached.add(a.getString(i)); }
        catch(Exception ignored) { }
        populateModels(cached);
    }
    private void populateModels(List<String> discovered) {
        LinkedHashSet<String> names=new LinkedHashSet<>();
        for(String name:discovered) if(name!=null && !name.trim().isEmpty()) names.add(name);
        names.add("gemini-3-flash"); names.add("claude-sonnet-4-6"); names.add(model); models=new ArrayList<>(names);
        modelSpinner.setOnItemSelectedListener(null); modelSpinner.setAdapter(adapter(models)); modelSpinner.setSelection(models.indexOf(model));
        modelSpinner.setOnItemSelectedListener(new SelectionListener() { void chosen(int p) {
            if(streaming || p>=models.size()) return;
            String next=models.get(p); if(next.equals(model)) return;
            model=next; prefs.edit().putString("model:"+accountId,model).apply(); reloadConversation();
        }});
    }
    private void reloadConversation() {
        input.setText(""); historyReady=false;
        try {
            history=accountId.isEmpty() ? new JSONArray() : accounts.loadConversation(accountId,model);
            if(history==null) throw new IllegalStateException("Missing stored conversation");
            historyReady=!accountId.isEmpty();
        } catch(Exception e) { history=new JSONArray(); }
        skillId=accountId.isEmpty() ? "" : skills.selected(accountId,model); populateSkills(); renderHistory();
        status.setText(accountId.isEmpty() ? "添加账号后即可开始对话。" : historyReady ? "聊天记录按账号和模型分别保存。" : "本机聊天记录无法读取，暂停发送以保护原记录。"); updateControls();
    }
    private void populateSkills() {
        skillItems=skills.list(); List<String> names=new ArrayList<>(); names.add("无技能"); int selection=0;
        for(int i=0;i<skillItems.size();i++) { SkillStore.Skill s=skillItems.get(i); names.add(s.name); if(s.id.equals(skillId)) selection=i+1; }
        // Keep a removed skill visible until explicitly cleared, including after restart.
        final boolean missing=!skillId.isEmpty() && skills.get(skillId)==null;
        if(missing) { names.add("已删除的技能 · 请清空对话"); selection=names.size()-1; }
        skillSpinner.setOnItemSelectedListener(null); skillSpinner.setAdapter(adapter(names)); skillSpinner.setSelection(selection);
        skillSpinner.setOnItemSelectedListener(new SelectionListener() { void chosen(int p) {
            if(streaming || accountId.isEmpty() || p>skillItems.size()) return;
            String next=p==0 ? "" : skillItems.get(p-1).id; if(next.equals(skillId)) return;
            if(history.length()>0) {
                populateSkills(); new AlertDialog.Builder(MainActivity.this).setTitle("更换技能？")
                    .setMessage("更换技能会清空当前对话，让新的提示从头生效。")
                    .setNegativeButton("取消",null).setPositiveButton("更换并清空",(d,w) -> chooseSkill(next,true)).show();
            } else chooseSkill(next,false);
        }}); updateControls();
    }
    private void chooseSkill(String id,boolean clearHistory) {
        if(streaming) return;
        // Clear first; on persistence failure do not change the conversation prompt.
        if(clearHistory && !clearConversation()) { populateSkills(); return; }
        skillId=id; skills.select(accountId,model,id); populateSkills();
        status.setText(id.isEmpty() ? "当前对话不使用技能。" : "技能已选中，仅作为对话提示；工具和脚本指令不会执行。");
    }
    private boolean clearConversation() {
        if(streaming) return false;
        try {
            accounts.saveConversation(accountId,model,new JSONArray()); history=new JSONArray(); historyReady=true; input.setText("");
            if(!skillId.isEmpty() && skills.get(skillId)==null) { skillId=""; skills.select(accountId,model,""); populateSkills(); }
            renderHistory(); status.setText("当前对话已清空。"); return true;
        } catch(Exception e) { status.setText("清空失败："+safeError(e)); return false; }
    }
    private void confirmRemoveAccount() {
        if(streaming || accountId.isEmpty()) return;
        String id=accountId;
        new AlertDialog.Builder(this).setTitle("移除当前账号？").setMessage("将移除本机登录信息，并删除该账号在本机保存的所有聊天记录。技能保留。")
            .setNegativeButton("取消",null).setPositiveButton("移除",(d,w) -> {
                if(streaming) return; try { accounts.remove(id); refreshAccounts(); discoverModels(); } catch(Exception e) { status.setText("移除失败："+safeError(e)); }
            }).show();
    }
    private void confirmDeleteSkill() {
        if(streaming || skillId.isEmpty()) return;
        String id=skillId;
        new AlertDialog.Builder(this).setTitle("删除所选技能？").setMessage("技能会从本机移除。使用该技能的聊天需清空后继续。")
            .setNegativeButton("取消",null).setPositiveButton("删除",(d,w) -> {
                if(streaming) return;
                try { skills.delete(id); populateSkills(); status.setText("技能已删除。请清空使用该技能的对话后继续。"); }
                catch(Exception e) { status.setText("删除失败："+safeError(e)); }
            }).show();
    }
    private void renderHistory() {
        messages.removeAllViews(); live=null;
        if(history.length()==0) {
            TextView welcome=label("开始一段对话\n\n选择账号和模型，输入消息即可发送。技能是可选的对话提示。",16);
            welcome.setPadding(dp(12),dp(24),dp(12),dp(24)); messages.addView(welcome);
        } else for(int i=0;i<history.length();i++) {
            JSONObject c=history.optJSONObject(i); if(c==null) continue; String text=visibleText(c);
            if(!text.isEmpty()) addMessage("user".equals(c.optString("role")) ? "你" : "助手",text);
        }
        scrollDown();
    }
    private static String visibleText(JSONObject content) {
        StringBuilder text=new StringBuilder(); JSONArray parts=content.optJSONArray("parts");
        if(parts!=null) for(int i=0;i<parts.length();i++) {
            JSONObject p=parts.optJSONObject(i); if(p!=null && !p.optBoolean("thought",false)) text.append(p.optString("text",""));
        }
        return text.toString();
    }
    private TextView addMessage(String speaker,String text) {
        LinearLayout block=column(); block.setPadding(dp(12),dp(10),dp(12),dp(10)); block.setBackground(bubble(surface));
        LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,-2); p.setMargins(0,dp(5),0,dp(5)); messages.addView(block,p);
        TextView who=label(speaker,12); who.setTextColor(accent); block.addView(who);
        TextView body=label(text,16); body.setTextIsSelectable(true); block.addView(body); return body;
    }
    private void sendMessage() {
        if(!historyReady) { status.setText("请先选择可用账号和聊天记录。"); return; }
        AccountStore.Account a;
        try { a=currentAccount(); } catch(Exception e) { status.setText("账号读取失败："+safeError(e)); return; }
        if(a==null) { status.setText("请先添加账号。"); return; }
        String prompt=input.getText().toString().trim(); if(prompt.isEmpty()) return;
        SkillStore.Skill skill=skills.get(skillId);
        if(!skillId.isEmpty() && skill==null && history.length()>0) { status.setText("本段对话的技能已删除，请先清空对话。"); return; }
        if(!skillId.isEmpty() && skill==null) { skillId=""; skills.select(accountId,model,""); populateSkills(); }
        try {
            JSONArray request=new JSONArray(history.toString());
            request.put(new JSONObject().put("role","user").put("parts",new JSONArray().put(new JSONObject().put("text",prompt))));
            cancellation=new AtomicBoolean(false); streaming=true; ++discoveryEpoch; updateControls(); input.setText(""); renderHistory();
            if(history.length()==0) messages.removeAllViews();
            addMessage("你",prompt); live=addMessage("助手",""); status.setText("正在回复…"); scrollDown();
            executor.execute(new ChatWork(this,api,a,model,request,skill==null ? "" : skill.text,prompt,cancellation));
        } catch(Exception e) { streaming=false; cancellation=null; updateControls(); input.setText(prompt); status.setText("发送失败："+safeError(e)); }
    }
    private AccountStore.Account currentAccount() {
        for(AccountStore.Account a:accounts.list()) if(a.id.equals(accountId)) return a; return null;
    }
    private void discoverModels() {
        if(streaming || destroyed) return;
        int epoch=++discoveryEpoch; AccountStore.Account a; try { a=currentAccount(); } catch(Exception e) { status.setText("账号读取失败："+safeError(e)); return; } if(a==null) return;
        status.setText("正在更新模型列表，可先使用已列出的模型。"); executor.execute(new DiscoverWork(this,api,prefs,a,epoch));
    }
    private void finishChat(JSONArray complete,String prompt,String partial,String error,boolean canceled) {
        if(destroyed) return;
        // This callback is serialized with Stop/onDestroy on the UI thread. No worker
        // can commit a canceled request or a standalone user turn.
        if(complete!=null && !canceled) {
            try { accounts.saveConversation(accountId,model,complete); }
            catch(Exception e) { complete=null; error="回复未能保存，请重试。"; }
        } else complete=null;
        streaming=false; cancellation=null;
        if(complete!=null) { history=complete; renderHistory(); status.setText("回复已完成并保存。"); }
        else {
            renderHistory(); input.setText(prompt); input.setSelection(input.length());
            if(!partial.isEmpty()) addMessage("助手 · 未完成，未保存",partial);
            status.setText(canceled ? "已停止。输入已恢复，未完成回复未保存。" : "发送失败："+error+" 输入已恢复，可重试。");
        }
        updateControls(); scrollDown();
        if(pendingAuthRefresh) { pendingAuthRefresh=false; refreshAccounts(); discoverModels(); }
    }
    @Override protected void onActivityResult(int code,int result,Intent data) {
        super.onActivityResult(code,result,data);
        if(code!=PICK_SKILL || result!=RESULT_OK || data==null || data.getData()==null) return;
        importing=true; updateControls(); status.setText("正在导入技能…"); executor.execute(new ImportWork(this,skills,data.getData()));
    }
    private void updateControls() {
        if(send==null) return; boolean idle=!streaming;
        accountSpinner.setEnabled(idle && !accountItems.isEmpty()); modelSpinner.setEnabled(idle && !accountId.isEmpty());
        skillSpinner.setEnabled(idle && !accountId.isEmpty() && historyReady); addAccount.setEnabled(idle); removeAccount.setEnabled(idle && !accountId.isEmpty());
        clear.setEnabled(idle && !accountId.isEmpty()); importSkill.setEnabled(idle && !importing);
        deleteSkill.setEnabled(idle && !skillId.isEmpty() && skills.get(skillId)!=null);
        input.setEnabled(idle); send.setText(streaming ? "停止" : "发送"); send.setEnabled(streaming || (!accountId.isEmpty() && historyReady));
    }
    @Override protected void onDestroy() {
        destroyed=true; if(cancellation!=null) cancellation.set(true); executor.shutdownNow();
        if(receiverRegistered) { unregisterReceiver(authReceiver); receiverRegistered=false; } super.onDestroy();
    }
    private void scrollDown() { scroll.post(() -> { if(!destroyed) scroll.fullScroll(View.FOCUS_DOWN); }); }
    private LinearLayout column() { LinearLayout l=new LinearLayout(this); l.setOrientation(LinearLayout.VERTICAL); return l; }
    private LinearLayout row() { LinearLayout l=new LinearLayout(this); l.setOrientation(LinearLayout.HORIZONTAL); l.setGravity(Gravity.CENTER_VERTICAL); return l; }
    private LinearLayout.LayoutParams weighted() { return new LinearLayout.LayoutParams(0,-2,1); }
    private TextView label(String text,int size) { TextView v=new TextView(this); v.setText(text); v.setTextSize(size); v.setTextColor(foreground); return v; }
    private Button button(String text) {
        Button b=new Button(this); b.setText(text); b.setTextSize(12); b.setAllCaps(false); b.setTextColor(foreground);
        b.setMinWidth(0); b.setMinimumWidth(0); b.setPadding(dp(8),0,dp(8),0); return b;
    }
    private GradientDrawable bubble(int color) { GradientDrawable b=new GradientDrawable(); b.setColor(color); b.setCornerRadius(dp(10)); return b; }
    private int dp(int n) { return Math.round(n*getResources().getDisplayMetrics().density); }
    private ArrayAdapter<String> adapter(List<String> names) {
        return new ArrayAdapter<String>(this,android.R.layout.simple_spinner_item,names) {
            { setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item); }
            @Override public View getView(int p,View recycled,android.view.ViewGroup parent) {
                TextView v=(TextView)super.getView(p,recycled,parent); v.setTextColor(foreground); v.setTextSize(14); return v;
            }
            @Override public View getDropDownView(int p,View recycled,android.view.ViewGroup parent) {
                TextView v=(TextView)super.getDropDownView(p,recycled,parent); v.setTextColor(foreground); v.setBackgroundColor(surface); return v;
            }
        };
    }
    private abstract static class SelectionListener implements AdapterView.OnItemSelectedListener {
        public void onItemSelected(AdapterView<?> parent,View view,int p,long id) { chosen(p); }
        public void onNothingSelected(AdapterView<?> parent) { } abstract void chosen(int p);
    }
    private static String safeError(Throwable error) { return safeMessage(error==null ? null : error.getMessage()); }
    private static String safeMessage(String message) {
        String lower=message==null ? "" : message.toLowerCase(Locale.ROOT);
        if(lower.contains("encrypted storage") || lower.contains("storage")) return "本机数据保存或读取失败，请检查设备存储。";
        if(lower.contains("onboarding") || lower.contains("consent") || lower.contains("no antigravity project")) return "请先在官方 Antigravity 应用完成账号开通和隐私确认，再重新登录。";
        if(lower.contains("401") || lower.contains("unauthorized") || lower.contains("invalid_grant") || lower.contains("token") || lower.contains("令牌"))
            return "登录凭据不可用，请移除账号后重新登录。";
        if(lower.contains("403") || lower.contains("permission") || lower.contains("forbidden")) return "当前账号没有访问权限，请检查账号或更换模型。";
        if(lower.contains("429") || lower.contains("quota") || lower.contains("rate")) return "请求过于频繁或额度不足，请稍后重试。";
        if(lower.contains("timeout") || lower.contains("timed out")) return "连接超时，请检查网络后重试。";
        if(lower.contains("unknownhost") || lower.contains("resolve host") || lower.contains("connect") || lower.contains("network")) return "网络连接失败，请检查网络。";
        if(lower.contains("cancel") || lower.contains("interrupt")) return "操作已停止。";
        if(lower.contains("model") || lower.contains("404")) return "模型暂不可用，请选择其他模型。";
        if(message!=null && (message.startsWith("请选择") || message.startsWith("只支持") || message.startsWith("技能") || message.startsWith("文件需")
                || message.startsWith("最多保存") || message.startsWith("无法读取"))) return message;
        return "操作未完成，请稍后重试；登录失败时可重新添加账号。";
    }
    private static final class ChatWork implements Runnable {
        private final WeakReference<MainActivity> owner;
        private final LiteApi api;
        private final AccountStore.Account account;
        private final String model,system,prompt;
        private final JSONArray request;
        private final AtomicBoolean cancel;
        ChatWork(MainActivity a,LiteApi api,AccountStore.Account account,String model,JSONArray request,String system,String prompt,AtomicBoolean cancel) {
            owner=new WeakReference<>(a); this.api=api; this.account=account; this.model=model; this.request=request; this.system=system; this.prompt=prompt; this.cancel=cancel;
        }
        public void run() {
            StringBuilder partial=new StringBuilder(); JSONArray completed=null; String error="";
            try {
                JSONObject response=api.chat(account,model,request,system,cancel,new LiteApi.Listener() {
                    public void onText(String delta) {
                        if(cancel.get() || delta==null) return; partial.append(delta);
                        MAIN.post(() -> {
                            MainActivity a=owner.get();
                            if(a!=null && !a.destroyed && a.cancellation==cancel && !cancel.get() && a.live!=null) { a.live.append(delta); a.scrollDown(); }
                        });
                    }
                    public void onThought(String delta) { }
                });
                if(cancel.get()) throw new InterruptedException("canceled");
                if(response==null || response.optJSONArray("parts")==null) throw new Exception("Incomplete response");
                completed=new JSONArray(request.toString()); completed.put(response);
            } catch(Exception e) { error=safeError(e); }
            JSONArray result=completed; String message=error, text=partial.toString();
            MAIN.post(() -> {
                MainActivity a=owner.get();
                if(a!=null && !a.destroyed && a.cancellation==cancel) a.finishChat(result,prompt,text,message,cancel.get());
            });
        }
    }
    private static final class DiscoverWork implements Runnable {
        private final WeakReference<MainActivity> owner;
        private final LiteApi api; private final SharedPreferences prefs; private final AccountStore.Account account; private final int epoch;
        DiscoverWork(MainActivity a,LiteApi api,SharedPreferences prefs,AccountStore.Account account,int epoch) {
            owner=new WeakReference<>(a); this.api=api; this.prefs=prefs; this.account=account; this.epoch=epoch;
        }
        public void run() {
            List<String> found=null; String failure="";
            try {
                found=api.discover(account); if(found==null || found.isEmpty()) throw new Exception("No models");
                prefs.edit().putString("models:"+account.id,new JSONArray(found).toString()).apply();
            } catch(Exception e) { failure=safeError(e); }
            List<String> result=found; String error=failure;
            MAIN.post(() -> {
                MainActivity a=owner.get(); if(a==null || a.destroyed || a.discoveryEpoch!=epoch || !a.accountId.equals(account.id) || a.streaming) return;
                if(result!=null && !result.isEmpty()) { a.populateModels(result); a.status.setText("模型列表已更新。"); }
                else a.status.setText("模型列表更新失败："+error+" 可尝试已列出的模型。");
            });
        }
    }
    private static final class ImportWork implements Runnable {
        private final WeakReference<MainActivity> owner; private final SkillStore store; private final Uri uri;
        ImportWork(MainActivity a,SkillStore store,Uri uri) { owner=new WeakReference<>(a); this.store=store; this.uri=uri; }
        public void run() {
            String failure=""; try { store.importMarkdown(uri); } catch(Exception e) { failure=safeError(e); } String error=failure;
            MAIN.post(() -> {
                MainActivity a=owner.get(); if(a==null || a.destroyed) return;
                a.importing=false; a.populateSkills(); a.updateControls();
                a.status.setText(error.isEmpty() ? "技能已导入，请在技能列表中选择。工具和脚本指令不会执行。" : "导入失败："+error);
            });
        }
    }
}
