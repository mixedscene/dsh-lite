# Chatbox Antigravity 0.1.14 交付与验收记录

## 当前结论

第 1、2 步的代码、云端构建和无需 Google 账号授权的真机验证已完成，已生成并覆盖安装签名发布版。真实 Google 账号授权、模型发现、Gemini/Claude 三轮对话、双账号 A→B→A 与真实回复重启续聊尚待人工授权后验证，不能视为端到端验收通过。

## 已实现

- 标准 Capacitor 7 Android 壳，包名 `org.chatbox.antigravity`，Android 8/API 26 起，目标 API 35。APK 自带页面与原生网络桥，无本地 Node/CLI 服务依赖。
- 系统浏览器 Google OAuth，PKCE/S256、一次性 state、本机回调与超时处理；凭证使用 Android Keystore 加密，仅原生持有，JavaScript 接收账号资料。
- 按 Google 稳定用户 ID 管理多账号，项目和模型缓存分账号保存；账号切换会取消请求。
- 动态 loadCodeAssist/fetchAvailableModels；原生 HTTP/SSE，传递真实 HTTP 状态和响应头，支持取消、有限 401 重试。
- Gemini/Claude 多轮协议原始 parts 和签名保存、完整响应回放；账号、项目、模型、会话隔离。中断回复保留显示，不能冒充完整协议历史。
- 轻量聊天入口复用 Chatbox 输入组件、会话数据模型与 SQLite 存储，支持停止、重试、历史恢复、Markdown、代码复制及对话 Skill。没有接入原 Chatbox 整套桌面 Agent 页面。
- Skill 从系统文件选择器导入 UTF-8 Markdown，最多 256 KiB，可查看/选择/删除；只注入对话系统指令。请求和原生边界拒绝模型 tools/functionCall/functionResponse，无模型文件、Shell 或 MCP 执行能力。

## 最小改动策略

保留上游源码、原构建工具和依赖锁文件；以新增 Antigravity provider、原生桥和独立轻量入口为主。共享层只补协议元数据、provider 注册和 SQLite 初始化复用。Android 只纳入 App、Browser、Keyboard、SQLite、Splash Screen 五个所需插件及手工注册的 Antigravity 桥，避免把桌面运行时带进 APK。

## 可复核的云端验证

- 仓库：`https://github.com/mixedscene/dsh-lite`，分支 `chatbox-antigravity`；原 `main` 保留。
- 最终 APK 对应源码提交：`1bda648b51f469a96eff1ab05487d8f34e4196fd`。
- GitHub Actions：`https://github.com/mixedscene/dsh-lite/actions/runs/38660099594`，成功，用时 6 分 41 秒。
- 前端/协议测试：5 个文件、54 项通过；包含 Gemini/Claude 签名回放、作用域隔离、中断、传输、SQLite 生命周期、账号存储和 Skill 数据限制。使用离线 fixture/替身，不能代替真实 Google 测试。
- Android 原生边界测试：5 项通过，0 失败。
- scoped TypeScript 检查、轻量 renderer、Capacitor 同步、debug/release 编译、R8 和 release lint 全部通过；lint 为 0 errors、17 warnings，主要涉及模板资源及 SharedPreferences 提交建议，报告已随构建保存。
- debug/release 使用既有固定签名，证书 SHA-256：`38a6ee867b868886f3ca7f98773966d42c97b316279b7ffcbe6bd8d952108d2a`。

## 真机已验证

1. 发布版 0.1.13 成功安装并正常显示首屏。
2. 通过 Android 系统选择器选择测试 Markdown，成功显示中文 Skill 名称、说明和预览入口。
3. 0.1.14 覆盖升级成功；重启后该 Skill 保留。
4. 修复真机发现的抽屉标题与状态栏重叠，0.1.14 截图确认修复。
5. 点击添加 Google 账号，外部浏览器成功显示 Google Antigravity 官方账号选择页，停在用户选择账号/授权处。
6. Android `am start -W` 报告 Activity 冷启动 401 ms。这只反映 Activity 指标，未证明页面完整可交互或发消息耗时达到 1 秒；第 3 步专项性能优化未开展。

## 还需完成的真实验收

在已安装 App 中点“添加 Google 账号”，由用户在官方页面选择账号并确认授权；若当前 170 秒授权窗口已超时，返回 App 重新发起。

随后依次检查：动态模型列表；Gemini 与 Claude 各三轮；停止后重试；杀进程重启续聊；添加第二账号并 A→B→A；真实账号刷新和 401/403/429 行为；勾选 Skill 后实际请求与回答。当前没有授权后成功生成或模型数量的实测结论。

## 交付物

- `Chatbox-Antigravity-0.1.14.apk`：21,927,417 字节（约 20.9 MiB），versionCode 14，已安装。
- APK SHA-256：`41d2d5ebe5ed8ffe8cca94051d3aa889f88c1e361e82cc0efec20cd38497760c`。
- `Chatbox-Antigravity-source-0.1.14.zip`：与 APK 构建提交对应的完整源码快照。
- `Chatbox-Antigravity-source-with-report.zip`：额外包含本次真机验收记录的源码快照，运行时代码与 APK 构建提交一致。
- `build-38660099594/`：云端原始 debug/release APK、Git bundle、原生测试和 lint 报告。
- `Skill保存与界面验证-0.1.14.png`、`启动界面-0.1.14.png`：真机截图。

构建遵循后续要求放在 GitHub。此前本地工具链探测阶段安装过 JDK；收到云端要求后未再下载构建工具，最终包完全由 GitHub 生成。保留上游 GPLv3 授权与版权信息。
