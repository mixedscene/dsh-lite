# DSH Lite

Android 8.0+ 原生聊天原型。无 Alpine、PRoot、Node、agy 或本地网页服务。

功能：Google 浏览器授权和账号切换，Gemini/Claude 流式聊天，账号独立历史及签名，Keystore 加密保存账号和会话，Markdown 对话 skill 导入。无终端、文件分析、代理工具或通用插件运行时。

## 私有 GitHub 云端构建

Actions Secrets：`AGY_CLIENT_ID`、`AGY_CLIENT_SECRET`、`APK_KEYSTORE_BASE64`、`APK_KEYSTORE_PASSWORD`、`APK_KEY_ALIAS`、`APK_KEY_PASSWORD`。

Google 用户令牌、聊天记录和 GitHub 登录凭证不进入仓库或构建环境。OAuth 共享桌面客户端参数编译进 APK，可被提取，不代表官方授权或接口稳定承诺。

推送 main 或手动运行 Build DSH Lite APK。构建后下载 DSH-Lite-APK-*，解压安装 APK。固定签名用于覆盖安装；签名备份应独立保管，换签名需要卸载重装。

本地需 JDK17 / SDK35，上述变量以及 `APK_KEYSTORE_PATH`，运行 `bash ./gradlew --no-daemon assembleRelease lintRelease`。

## 手机验收

1. 新装和断网时立即显示界面；测量冷启动到可输入的时间。
2. 添加 A 完成浏览器授权，验证 Gemini/Claude 多轮聊天。
3. 添加另一个 B，再切回 A，验证各自历史、签名和令牌刷新。
4. 强制停止再打开，检查账号和已完成会话恢复。
5. 停止生成或网络失败时，部分回复不得保存为完整签名历史。
6. 用系统文件选择器导入 UTF-8 SKILL.md。仅追加对话指令，不执行脚本和工具。

两个真实账号的独立 Python 直连测试已通过 A→B→A、多轮与刷新，但原生 APK 仍需安装验收。OAuth 回调使用 localhost:51121/oauth-callback；占用时显示错误，授权服务约三分钟超时后允许重试。关闭系统备份以避免恢复无法解密的 Keystore 数据。

BillionContext 长上下文处理尚未接入。
