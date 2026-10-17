# Antigravity 登录与 OpenAI 兼容中转 API：实现与移植指南

本文面向接手项目的 AI 和开发者，说明如何在现有聊天应用中增加 Google Antigravity 多账号登录、直接对话，以及 OpenAI 兼容中转 API。方案已集成于原始 Chatbox UI；移植时保留目标应用的界面、消息存储和聊天工作流，只替换必要的认证、provider 和传输适配层。

**源码基线：`216c715403289fe0bd79f7a73ff5e87e093c6aab`。** 文中的源码链接固定到该提交，避免后续分支变化影响复现。Google 的内部服务、可用模型与中转网关策略会变化；本文描述这个版本实际做了什么，不保证任意 Google 账号或模型都可用。

## 1. 给另一个 AI 的实施任务

接到本文后，按以下顺序执行：

1. 阅读第 2 节的组件地图，先识别目标应用的 provider 接口、消息持久化入口和网络适配器。
2. 实现两个独立原生插件：`Antigravity` 管理 Google 账号和指定 Google API；`HttpTransport` 处理用户配置的中转 HTTP(S)。后者不能读取前者的账号库。
3. 先跑通中转站的模型列表、非流式和流式调用，再添加 Google OAuth。这样不会把中转 HTTP/CORS 故障与 Google 授权故障混在一起。
4. 移植 Google OAuth、加密账号库、刷新锁与取消机制，再移植协议解析、签名历史和 provider 适配。
5. 把账号控件嵌入已有 provider 设置页，把 `clientHeaders` 加入已有自定义提供商设置。不要重写聊天页面。
6. 按第 10 节做自动检查和真机验收。仅收到 HTTP 200 或 `response.created` 不能算完整聊天成功。

桌面/其他框架可以复用 TypeScript 协议代码，但必须重写原生桥接和凭证存储。纯浏览器应用不能直接照搬 Android loopback 服务、Android Keystore 或修改 User-Agent 的能力。

## 2. 总体结构与关键源码

两条链路：

```text
Google：原有设置页 → Antigravity 插件 → 系统浏览器 OAuth
                          ↓
                  原生加密账号库/刷新令牌
                          ↓
聊天 provider → 协议客户端 → Antigravity 插件 → Google Cloud Code API

中转：原有自定义提供商设置 → OpenAI/Responses SDK → 统一 fetch 适配
                                                   ↓
                             Android HttpTransport → 用户配置的 HTTP(S) API
```

Google token 永不经 JavaScript 返回。中转 API Key 则沿用原有提供商配置，经 SDK 形成 Authorization，再交给独立原生 HTTP 通道。不能声称中转 Key 也获得了 Google 账号库相同的 Keystore 保护。

| 模块 | 固定版本源码 | 移植职责 |
| --- | --- | --- |
| 原生注册 | [MainActivity.java](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/android/app/src/main/java/org/chatbox/antigravity/MainActivity.java) | `super.onCreate` 前注册两个插件 |
| 登录服务 | [OAuthService.java](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/android/app/src/main/java/org/chatbox/antigravity/OAuthService.java) | 浏览器、loopback、PKCE、超时和取消 |
| Google 账号库 | [AccountStore.java](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/android/app/src/main/java/org/chatbox/antigravity/AccountStore.java) | AES-GCM、账号元数据、活动账号 |
| Google 原生插件 | [AntigravityPlugin.java](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/android/app/src/main/java/org/chatbox/antigravity/AntigravityPlugin.java) | 白名单、Bearer 注入、刷新、Google SSE |
| OAuth HTTP | [NativeHttp.java](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/android/app/src/main/java/org/chatbox/antigravity/NativeHttp.java) | token 交换与 userinfo |
| Google JS 桥 | [native.ts](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/src/shared/providers/antigravity/native.ts) | 插件契约、事件转 ReadableStream |
| Google API 客户端 | [client.ts](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/src/shared/providers/antigravity/client.ts) | project、模型发现、生成、错误 |
| 协议和类型 | [protocol.ts](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/src/shared/providers/antigravity/protocol.ts)、[types.ts](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/src/shared/providers/antigravity/types.ts)、[sse.ts](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/src/shared/providers/antigravity/sse.ts) | 历史、签名、SSE 增量与元数据 |
| 档位选择 | [tier-utils.ts](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/src/shared/providers/antigravity/tier-utils.ts) | 显示聚合、真实模型 ID 解析 |
| 原有模型接口适配 | [antigravity.ts](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/src/shared/providers/definitions/models/antigravity.ts) | ModelInterface、流式事件和账号校验 |
| 账号 UI | [AntigravityAccounts.tsx](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/src/renderer/components/settings/AntigravityAccounts.tsx) | 登录、切换、退出、刷新模型 |
| 通用原生 HTTP | [HttpTransportPlugin.java](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/android/app/src/main/java/org/chatbox/antigravity/HttpTransportPlugin.java)、[RelayHttp.java](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/android/app/src/main/java/org/chatbox/antigravity/RelayHttp.java) | 无 Google 凭证权限的通用网络层 |
| 通用 JS HTTP 桥 | [http-transport.ts](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/src/renderer/native/http-transport.ts) | 字节传输、状态码、响应流、取消 |
| 请求路由 | [request.ts](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/src/renderer/utils/request.ts)、[mobile-request.ts](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/src/renderer/utils/mobile-request.ts) | WebView 与原生通道选择 |
| 可编辑请求头 | [codex-client-headers.ts](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/src/shared/providers/codex-client-headers.ts) | 默认值、覆盖文本解析、禁用标记 |
| 中转 provider | [custom-openai.ts](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/src/shared/providers/definitions/models/custom-openai.ts)、[custom-openai-responses.ts](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/src/shared/providers/definitions/models/custom-openai-responses.ts) | SDK、认证、路径、模型列表 |
| 设置 schema | [settings-schema.ts](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/packages/chatbox-core/src/domain/settings/settings-schema.ts) | `clientHeaders` 与 reasoning 选项 |
| CI | [android.yml](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/.github/workflows/android.yml)、[build.gradle](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/android/app/build.gradle) | 自动检查、OAuth 编译配置、签名 APK |

本表是迁移入口，不是只复制这些文件就能编译的独立依赖清单；还需接入第 6 节的消息持久化和原应用接口。

## 3. Google OAuth 的实际实现

### 3.1 OAuth 客户端与构建配置

需要自己有权使用的 Google OAuth 客户端，且其类型、授权范围和 redirect 配置允许本方案。**不能把任意 Android 类型 client ID 填入就假定 localhost 回调可用**；若 Google 拒绝所选客户端类型，必须调整 OAuth 客户端/认证架构。登录成功也不代表获得 Antigravity 模型权限。

本实现由 Gradle 从环境变量生成 BuildConfig：

| 构建环境变量 | BuildConfig | 本仓库 Actions secret |
| --- | --- | --- |
| `ANTIGRAVITY_OAUTH_CLIENT_ID` | `OAUTH_CLIENT_ID` | `AGY_CLIENT_ID` |
| `ANTIGRAVITY_OAUTH_CLIENT_SECRET` | `OAUTH_CLIENT_SECRET` | `AGY_CLIENT_SECRET` |

release 检查强制 client ID 非空；代码允许 client secret 为空，但交换请求仍包含该参数。是否需要 secret 取决于 OAuth 客户端配置。被编进 APK 的 client secret 可以被提取，不能将其视为可信的服务端秘密，也不能用它替代 PKCE。

### 3.2 登录步骤

1. 用户在 provider 设置页点击登录，JS 调用 `Antigravity.addAccount({ timeoutMs })`。
2. 原生启动临时前台 `OAuthService`。服务只用于本次登录，不提供聊天代理。
3. 生成 32 随机字节的 `state` 和 64 随机字节的 verifier，以无填充 Base64URL 编码。challenge 为 `BASE64URL(SHA256(verifier))`，method 为 `S256`。
4. 在 IPv4 `127.0.0.1:51121` 绑定 callback；尝试绑定 IPv6 `::1`，IPv6 不可用不终止登录。先绑定成功，再打开系统浏览器。
5. 浏览器使用下列授权参数：

```text
Endpoint: https://accounts.google.com/o/oauth2/v2/auth
redirect_uri: http://localhost:51121/oauth-callback
response_type: code
code_challenge_method: S256
access_type: offline
prompt: select_account consent
state: 本次随机 state
code_challenge: 本次 verifier 的 SHA-256 Base64URL
client_id: 构建配置中的客户端 ID
```

实际请求的 scope：

```text
https://www.googleapis.com/auth/cloud-platform
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/userinfo.profile
https://www.googleapis.com/auth/cclog
https://www.googleapis.com/auth/experimentsandconfigs
```

这些 scope 不应被描述为普通 Google 登录的最小权限集合；移植时需确认目标服务实际要求及客户端能否取得同意。

6. 回调只接受 loopback 来源、GET、精确 `/oauth-callback` 路径；拒绝重复 query 参数、absolute URI、fragment、错误 state。state 使用常量时间比较；成功匹配只消费一次。
7. 原生向 `https://oauth2.googleapis.com/token` 发送表单：`grant_type=authorization_code`、`code`、`client_id`、`client_secret`、`redirect_uri`、`code_verifier`。
8. 用 access token 请求 `https://www.googleapis.com/oauth2/v1/userinfo`，以返回的稳定 `id` 区分账号，邮箱仅用于显示。
9. 原生保存 token 并将该账号设为 active；JS 只获得安全元数据。随后发现 project 和模型列表。

默认登录超时 170000 ms，服务将调用方超时钳制到 10000–170000 ms。完成、拒绝、取消、超时都会关闭监听端口、socket、线程及前台通知。

没有 OAuthCallbackActivity，也没有 manifest deep-link 回调。**不是** `myapp://callback` 方案，不要混搭回调机制。

### 3.3 生命周期与 Android 配置

[AndroidManifest.xml](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/android/app/src/main/AndroidManifest.xml) 声明 INTERNET、FOREGROUND_SERVICE、FOREGROUND_SERVICE_SPECIAL_USE，以及不导出的 specialUse OAuthService。Android 14+ 通过对应前台服务类型启动。登录是用户主动操作，系统浏览器在前台时临时维持 callback 服务。

界面监听 `accountsChanged` 和 Capacitor `appStateChange`，恢复前台时重新调用 `listAccounts()`。这能处理 Activity/UI 重建，但**进程被杀不会恢复 state/verifier 和旧授权事务**：仅持久化 pending/error，并在下次打开时提示重新登录。不要承诺无缝断点续登。

## 4. 账号库、刷新与切换

### 4.1 原生保存与前端可见字段

账号集合使用 Android Keystore 的 AES-256-GCM 加密，SharedPreferences 保存 `{iv,data}` 密文。GCM tag 128 bit，AAD 为 `accounts.v1`。当前兼容标识：

```text
applicationId: org.chatbox.antigravity
Keystore alias: org.chatbox.antigravity.accounts.v1
SharedPreferences: antigravity_private
```

新应用可以设计自己的命名；覆盖升级这个应用时应保留标识、签名和数据结构，否则可能无法读取既有账号。manifest 已禁用普通应用备份，并配置数据提取规则；Keystore 密钥不能靠复制偏好文件跨设备还原。

前端允许得到：`id,email,name,picture,project,modelCache,updatedAt,reauthRequired`，以及 `activeAccountId,oauthConfigured,storageError,oauthPending,oauthError` 状态。不得返回 accessToken、refreshToken、expiresAt 或原始 token 响应。

账号库的读改写使用同一静态锁。损坏/密钥不可用时返回 storageError，不静默清空数据。重登同一个稳定账号 ID 时更新资料与 token；新 token 响应没给 refresh token 时保留原有值，但首次授权无 refresh token 会明确失败。

### 4.2 Token 刷新算法

`AntigravityPlugin.token(accountId, rejectedToken)`：

- 每账号独立刷新锁，防止并发刷新；不同账号不共享 token。
- 当前 access token 还剩超过 60 秒且没有被此次 401 拒绝时直接用。
- 否则调用 token endpoint，使用 `grant_type=refresh_token`。
- `invalid_grant` 或没有 refresh token 时置 `reauthRequired`，提示重新登录。
- Google 请求遇到 401 仅刷新后重试一次；第二次仍 401 标记需重新授权。

Authorization 在原生最终发往 Google 前注入，JS 请求不能自带任意 Authorization。Google 插件只允许 content-type、accept、user-agent、x-goog-api-client 这四种调用方请求头，并限制长度/换行。

### 4.3 切换、删除与竞态

- `switchAccount({accountId})` 原生先激活账号，再取消当前所有 Google 请求。
- `removeAccount({accountId})` 取消该账号请求并删除本地记录。此处“退出”不等于在 Google 服务端撤销授权。
- UI 切换后先用新账号模型缓存，再刷新模型；发现完成时重查 activeAccountId，防止旧请求覆盖新账号模型。
- 真正发出生成前也重查原生 active account，异步 project 发现结束后再次校验账号/项目快照。

只改变一个全局 `activeAccountId` 而不绑定会话、取消旧流和校验异步结果，容易造成跨账号上下文误发。

## 5. Antigravity 模型发现与生成协议

### 5.1 Project 和模型目录

先 POST `https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist`：

```json
{"metadata":{"ideType":"ANTIGRAVITY","pluginType":"GEMINI"}}
```

从 `cloudaicompanionProject` 读取字符串，或对象的 `id`。没有 project 时明确提示资格/同意问题，不自动接受协议、不凭空生成项目。

随后 POST `/v1internal:fetchAvailableModels`，body 为 `{ "project": 项目ID }`。解析数组或映射形式的 models，缓存真实 ID、显示名及 token 上限。

**该基线有一个需要明确记录的限制：** JS 的 `ANTIGRAVITY_CATALOG_HOSTS` 尝试 daily → production，但 Java `AntigravityPlugin.allowed()` 的 discovery 只允许 production。因此 Android 上 daily 目录请求先被原生拒绝，再回退 production。不能把源码注释中的“daily 目录优先”当作已真正生效；目录和生成主机可能不一致。若移植时修复，须同时修改 Java 精确白名单和对应原生测试，再验证真实账号，不能仅修改 JS URL。本文不修改这项运行时代码，也不宣称 Gemini 3.5–3.7 已恢复。

### 5.2 请求主机、版本头和回退

生成顺序为：

```text
https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse
https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse
```

首站只有 HTTP 404 才尝试另一站；429、403、401、400 不触发跨站重试。回退失败时保留首站 404 的上下文，并附回退错误，防止把“模型在首站不存在”误报成回退主机的额度问题。

JS 桥显式附加：

```http
User-Agent: antigravity/2.9.1 android/arm64
X-Goog-Api-Client: google-cloud-sdk vscode_cloudshelleditor/0.1
```

`NativeHttp.open()` 仍有较旧默认 UA，但生成/发现请求由 JS 提供值覆盖；只复制 NativeHttp 会漏掉实际使用的版本头。版本号是基线值，不能保证未来仍被服务接受。也不要把其他实现里的 `Client-Metadata` 生搬过来，当前 Java 头白名单不接受它。

### 5.3 生成 body

以下 JSON 是结构示例，其中 project/model/session/requestId 均为说明值，真实实现必须从账号、目录和会话生成，不能照字面发送：

```json
{
  "project": "ACCOUNT_PROJECT_ID",
  "model": "MODEL_ID_FROM_DISCOVERY",
  "requestType": "agent",
  "userAgent": "antigravity",
  "requestId": "agent-REQUEST_UUID",
  "request": {
    "sessionId": "SCOPED_SESSION_ID",
    "contents": [{"role":"user","parts":[{"text":"你好"}]}],
    "generationConfig": {
      "maxOutputTokens": 4096,
      "thinkingConfig": {"includeThoughts":true,"thinkingLevel":"LOW"}
    },
    "systemInstruction": {"parts":[{"text":"请简洁回答"}]}
  }
}
```

`systemInstruction` 按需加入；temperature/topP 有值才发送。Gemini 3 使用大写 thinkingLevel；Gemini 2.5/Claude 在输出上限大于 1024 时使用 thinkingBudget 1024。例子里的 thinkingConfig 对应 Gemini 3，不是所有模型通用参数。

本 provider 明确只支持文字会话和系统指令：不支持视觉、工具调用或图片生成。Java 递归拒绝 tools/toolConfig/functionDeclarations/functionCall/functionResponse 等字段；客户端也拒绝模型返回的工具调用。移植时 UI capability、消息转换和原生限制必须一致。

### 5.4 模型家族与思考档位

选择器合并 `-minimal/-low/-medium/-high/-tiered` 成家族，但原生账号缓存保留完整真实 ID。发请求前由 `selectAntigravityTierModelId` 还原目录发布的 ID；明确档位优先，`-tiered` 用 body 携带 level，没有档位的家族使用 bare ID；有离散档位时选接近的已发布档位。

`includeThoughts:false` 被档位解析器映射为 off，并尽量选择较低的已发布档位。Gemini 3 请求尊重这个标志，但它不保证零思考消耗。**基线限制：Claude/Gemini 2.5 在 maxOutputTokens > 1024 时仍被 client.ts 强制发送 includeThoughts:true 和 thinkingBudget:1024，visibleParts 也不统一过滤思考，因此不能称为对所有模型都隐藏思考。** 解析档位必须是同步离线操作，不能每发一次消息都临时刷新模型目录；此前这种额外发现请求破坏了流式调用顺序。

## 6. 流、签名历史与原有聊天系统集成

### 6.1 Google 流式桥契约

主要插件方法：`listAccounts`、`addAccount`、`cancelOAuth`、`switchAccount`、`removeAccount`、`updateAccountCache`、`request`、`cancelRequest`。

`request` 输入包含 `requestId,accountId,url,method,headers,body,stream`；响应先返回 `status,headers`，非流式或错误响应还包含 body。流式事件 `httpChunk` 包含 `requestId,accountId,chunk?,done?,error?`。

JS 必须**先注册事件监听，再发 request**；原生 chunk 可能早于 Promise 解析。按 requestId 和 accountId 双重过滤，再包装成标准 Response/ReadableStream，供 SSE parser 消费。AbortSignal 同时触发原生取消、关闭连接和监听器清理。

Google 桥用 UTF-8 Reader 解码并处理跨块代理对；不能假设一个网络块等于一个完整 SSE event。SSE parser 必须保留未完成行和 event。读取 envelope.response 或 envelope 自身，增量保留 candidates[0].content.parts 与 usageMetadata。只有 `finishReason === STOP` 且存在可见内容才算完成；截断、取消、异常、无结束原因都不能写成完成状态。

### 6.2 必须持久化协议元数据

消息除显示正文外还需要 `antigravity` 元数据：version、accountId、project、modelId、scoped sessionId、raw parts、complete、status、finishReason。

会话作用域使用四元组 `(accountId,project,modelId,sessionId)`，长度前缀拼接；当前前缀 `chatbox:` 只是协议兼容标识。历史仅回放完全匹配作用域且 completed/STOP 的 assistant 轮次，保留它前面的 user 轮次；不同账号/模型/项目/会话的旧协议上下文不复用。

Claude 思考签名可能后到或单独成块：`replayParts()` 合并连续逻辑思考块，再把签名绑定到对应块，校验冲突、孤立或缺失签名。UI 可以展示 reasoning/text，但不能用展示文本重建已签名历史，也不能给未完成块伪造签名。

### 6.3 接入宿主的几个入口

必须检查这些入口的真实实现，而不仅复制 provider 类：

- 出站准备：[AntigravityGenerationPreparation](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/src/renderer/adapters/AntigravityGenerationPreparation.ts) 在首次发出前持久绑定 `Session.antigravity` 的 accountId/project，兼容已有消息所有者，禁止附件/链接/非文本输入，并绕过会改写工具历史的普通 agent 准备流程。
- 出站转换：[model-message-converter](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/src/shared/services/model-message-converter.ts) 的 `preserveAntigravity:true` 分支把消息元数据放入 `providerOptions.antigravity`；不能只发显示文本。
- 入站类型：[ModelStreamPart](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/src/shared/models/types.ts) 增加 `antigravity-metadata`。
- 入站处理和存储：[stream-chunk-processor](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/packages/chatbox-core/src/generation/stream-chunk-processor.ts) 将事件元数据写入流状态，[GenerationService](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/packages/chatbox-core/src/generation/GenerationService.ts) 将其合入目标消息并沿原会话存储流程保存。renderer 的 [CurrentGenerationService](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/src/renderer/adapters/CurrentGenerationService.ts) 负责宿主适配和准备流程接线，不能把它误认成实际元数据消费器。
- [共享消息类型](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/src/shared/types.ts) 与 [AntigravityMetadataSchema](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/src/shared/providers/antigravity/types.ts) 的实际导出/引用关系；若目标版本目录不同，以类型定义为准。
- [model-calls](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/src/renderer/packages/model-calls/index.ts)、[naming](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/src/renderer/stores/session/naming.ts)、[summary-generator](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/src/renderer/packages/context-management/summary-generator.ts) 传递账号所有者；标题、摘要属于辅助请求，要用新的协议 session，不构造假签名历史。
- [useProviders](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/src/renderer/hooks/useProviders.ts) 让 Android 上已有账号模型的 Antigravity 能进入选择器，不能只沿用 desktop OAuth 的显示条件。
- [provider utils](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/src/shared/providers/utils.ts) 接入已有工厂；设置页嵌入账号组件并保留其他 provider。

## 7. 中转站 API 的具体方案

### 7.1 沿用已有 OpenAI / Responses provider

保留用户的 apiKey、apiHost、apiPath、modelId、stream 和 reasoning 配置。Chat Completions 和 Responses 分别由原有 SDK adapter 处理，不把 Google Cloud Code body 发往中转站。

[llm_utils.ts](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/src/shared/utils/llm_utils.ts) 规范化地址：去末尾斜线、处理显式 HTTP(S) 大小写、缺 scheme 默认 https；无自定义路径时处理 `/v1`；chat 默认 `/chat/completions`，Responses 默认 `/responses`。中转只有 HTTP 时用户必须明确填 `http://`，不要自动升级到一个根本没开 TLS 的端口。

模型列表由 `/models` 相关原有逻辑获取。模型 ID 必须逐字使用目录结果：显示名相似不等于 ID 相同。先打印脱敏后的最终 URL 检查 `/v1/v1` 或重复 path，而不是猜网关故障。

SDK 请求必须接入宿主网络适配，而不是保留 SDK 默认 fetch：[fetch-proxy.ts](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/src/shared/models/utils/fetch-proxy.ts) 的 `createFetchWithProxy` → `dependencies.request.apiRequest` → [RendererRequestAdapter](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/src/renderer/adapters/RendererRequestAdapter.ts) → renderer `apiRequest` → request.ts。依赖由 [RendererModelDependencies](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/src/renderer/adapters/RendererModelDependencies.ts) 装配。聊天与模型列表都应接入同一条网络边界，否则仅添加原生路由条件仍无法解决 SDK 直连 WebView 的失败。

保留 fetch-proxy 对生成 POST 的 **`retry:0`**：底层 request helper 默认 retry=3，网络断开可能发生在服务端已处理之后，盲目重试会重复生成甚至重复计费。这与 Google401刷新一次、Google404跨主机一次的专用规则分开处理。

### 7.2 Android WebView 的 HTTP / CORS 处理

WebView 使用 HTTPS localhost origin；访问纯 HTTP 中转时，浏览器 mixed-content 或 CORS/preflight 就可能阻断。原仓库的“代理开关”不是解决所有 HTTP 目标的必要前提。

实际路由条件：

```typescript
// request.ts 中的实际条件；platform/useProxy/url 来自宿主请求上下文。
function needsNativeTransport(url: string): boolean {
  return /^http:\/\//i.test(url)
}
// Android/mobile：useProxy || needsNativeTransport(requestUrl) -> handleMobileRequest
// Android handleMobileRequest -> nativeHttpRequest -> HttpTransport 插件
```

HTTPS 且未启用 useProxy 时通常保留 fetch；HTTPS 目标也可能有 CORS 问题，可走现有 useProxy 原生通道，不能保证“HTTPS 就一定能直连”。Android manifest `usesCleartextTraffic=true` 允许本方案的 HTTP 出站；Capacitor 仍保持 `allowMixedContent:false`，不靠放开 WebView 混合内容解决问题。

### 7.3 通用原生网络层

`HttpTransport` 输入 requestId、url、method、headers、bodyBase64。Promise 返回真实 status/headers；`httpData` 事件传输 base64 原始字节及 done/error。JS 恢复 Uint8Array 后包装 ReadableStream，因此 JSON、SSE、中文跨字节边界都能由上层正确处理。

Java `RelayHttp`：支持 HTTP/HTTPS，拒绝 URL 内嵌凭证和 fragment；不自动跟随重定向，避免 API Key 跟随到其他域名；禁止调用方设置 Host/Connection/Content-Length/Transfer-Encoding，拒绝非法 header 与 CR/LF；连接超时30秒，读超时120秒。请求体以及 JS 累计响应有限制32 MiB。

收到 upstream 4xx/5xx 时仍返回真实状态和错误流，不假装200；取消要断开连接、关闭输入流，并幂等清理 listener。这个插件不读取 AccountStore，也不会自动注入 Google Authorization。

### 7.4 Codex 兼容请求头与运行时配置

部分用户已授权使用的中转网关按客户端请求头分流，可能返回：

```text
403 This account only allows Codex official clients
```

实现使用如下默认配置（版本是基线值）：

```http
user-agent: codex_cli_rs/0.154.0
originator: codex_cli_rs
x-codex-window-id: 11111111-2222-3333-4444-555555555555
session_id: 11111111-2222-3333-4444-555555555555
OpenAI-Beta: responses=experimental
Version: 0.154.0
```

这些头是网关兼容参数，不提供身份认证或额外额度，不能替代有效 API Key 和网关授权。不同网关可能不需要它们。

关键发现是 **User-Agent**：即使其他指纹头已发送，只有 SDK 默认 `ai-sdk/... runtime/browser` 仍可能403；配置 `codex_cli_rs/0.154.0` 后，SDK 附加自己的后缀仍可被当时被测网关接受。不能仅靠代码配置猜最终请求头，需在网络边界观察实际发出的值。普通浏览器可能限制覆盖 UA，Android 原生通道可显式发送。

当前两个 UUID 值固定，是兼容实现的真实情况，不是凭证或 Google 账号 ID。新移植若改成每安装/窗口/会话独立 UUID，应再验证网关行为；不能宣称当前已实现了动态 UUID。

`ProviderSettingsSchema.clientHeaders` 是可选字符串，设置页多行文本支持：

| 用户输入 | `resolveClientHeaders()` 结果 |
| --- | --- |
| 未设置/空白 | 使用全部默认头 |
| `-` 或不区分大小写的 `none` | 关闭这些额外头；SDK 的 API Key 认证仍保留 |
| `key: value` 多行或字符串值 JSON 对象 | 用解析后的整组头覆盖默认组，不合并 |
| 无任何可解析项 | 回退默认组 |

空行和 `#` 注释忽略，非法名字或无值项丢弃。部分有效输入只保留有效项，因此只填 `Version` 不会自动补齐其他默认头。原生层再做 CR/LF 校验；解析器不是完整安全策略。不要鼓励在这个额外头字段重复填写 Authorization，沿用专用 API Key 字段。

**必须同时接两处**：

- [providers/utils.ts](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/src/shared/providers/utils.ts)：聊天实例构造时传 `extraHeaders: resolveClientHeaders(providerSetting.clientHeaders)`。
- [custom-provider-setting-util.ts](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/src/renderer/packages/model-setting-utils/custom-provider-setting-util.ts)：设置页获取模型也传相同 extraHeaders。

CustomOpenAI / CustomOpenAIResponses 的 SDK 构造与 listModels 都接收这些头。旧的 `codexClientHeaders` 布尔开关已经被可编辑文本替换，改头无需重新打包。

## 8. 常见失败：证据 → 判断 → 排查路径

| 证据/症状 | 应得出的判断 | 下一步 |
| --- | --- | --- |
| OAuth redirect/client 被 Google 拒绝 | 客户端配置或允许的认证流程不匹配 | 核对客户端类型、callback 和 scope；不是修改模型 body |
| localhost:51121 bind 失败 | 端口占用/登录服务冲突 | 关闭另一登录事务再试，不绑定0.0.0.0 |
| 用户浏览器授权后未完成 | 可能超时、进程中断或 callback 不匹配 | 看 oauthPending/oauthError；旧 state 不恢复，重新登录 |
| 登录成功但没有 project | 账号资格或服务同意不足 | 查看 loadCodeAssist，不自动代替用户接受协议 |
| Google401 | access token 失效或授权撤销 | 一次刷新重试，失败后重新授权 |
| Google404 | 主机、模型真实 ID、版本或权限映射等问题 | 保留 host/model/error body，按精确条件回退一次 |
| Google429 | 当前服务给出的限流/配额答复 | 保留 Retry-After，等待；不自动跨站轮询 |
| 列得出模型但发消息404 | 目录不保证生成主机可用 | 核对 daily/production、Java白名单、真实tier ID |
| 中转模型获取失败但命令行能访问 | WebView mixed content/CORS 的可能性高 | 检查是否走 HttpTransport，再查真实 HTTP 状态 |
| TLS WRONG_VERSION_NUMBER | 用https访问了纯HTTP端口的可能性 | 核对协议与端口，不关闭证书校验 |
| 中转403官方客户端限制 | key有效也可能被网关分流策略拦截 | 比较真实 UA 和整组 headers；确认网关授权与政策 |
| 中转500 Failed to validate API key | 服务端验证过程失败，不等于已证明key写错 | 查网关状态和日志，保留响应，再排查配置 |
| response.created 后没有回答 | 仅建流成功 | 继续读取完整流、错误事件和完成标志 |
| 多轮失败/Claude signature错误 | 签名历史可能丢失或作用域错配 | 检查raw parts、complete/STOP、账号与model绑定 |

Google `failureDetail()` 仅压缩空白和截断300字符，并不自动脱敏。记录/展示错误时应限制可见范围，分享日志前另做 token、邮箱、请求体等脱敏；不得声称当前已完成端到端错误脱敏。

## 9. 保留原应用体验的注意点

- 不重写原始侧栏、聊天页、模型切换和设置流程；新增功能放在原 provider 设置与统一模型接口。
- Provider 发现/可见性不能只检查 desktop OAuth；Android Antigravity 使用原生账号和模型缓存。
- 避免在模块顶层同步读取相互导入的 platform；本项目曾因 featureFlags/platform 循环引用出现 `Cannot access platform before initialization`，相应能力用 getter 延迟读取。
- Android15/16 edge-to-edge 不能仅依赖 adjustResize；本项目禁用 Capacitor 默认 margin 处理，由 MainActivity 按 systemBars/cutout 与 IME 的最大 bottom inset 收缩 WebView，防止键盘盖住输入框。此项与登录协议无关，但影响“移植后正常聊天”。
- 不改变包名、签名、数据库名、Keystore alias 和旧备份格式来完成外观改名；新独立应用另行规划身份与数据迁移。
- 保留第三方 providers 和自定义 API；Google 专用安全白名单不能用于通用中转通道，也不能为支持中转而放宽 Google token 出站目标。

## 10. 自动检查与真机验收

本项目以 GitHub Actions 云端检查为准，不要求在手机上下载依赖或本地构建。参考 workflow 中锁定依赖安装 → Vitest → `pnpm run check` → renderer build / Capacitor sync → Android 单测/lint/签名顺序。不要省略类型检查后直接交 APK。

重点回归源码：

- [Google协议和桥测试目录](https://github.com/mixedscene/dsh-lite/tree/216c715403289fe0bd79f7a73ff5e87e093c6aab/src/shared/providers/antigravity)、[provider测试](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/src/shared/providers/definitions/models/antigravity.test.ts)。
- [原生JS传输测试目录](https://github.com/mixedscene/dsh-lite/tree/216c715403289fe0bd79f7a73ff5e87e093c6aab/src/renderer/native)、[mobile-request.test.ts](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/src/renderer/utils/mobile-request.test.ts)、[request.test.ts](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/src/renderer/utils/request.test.ts)。
- [Codex头解析测试](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/src/shared/providers/codex-client-headers-spec.test.ts)、[OpenAI SSE结束处理测试](https://github.com/mixedscene/dsh-lite/blob/216c715403289fe0bd79f7a73ff5e87e093c6aab/src/shared/providers/definitions/models/openai-chat-sse-providers.test.ts)。
- [Java测试目录](https://github.com/mixedscene/dsh-lite/tree/216c715403289fe0bd79f7a73ff5e87e093c6aab/android/app/src/test)、原有 generation、naming、summary、session/provider 相关测试，详见 workflow。

移植项目的测试必须覆盖：callback错误state/重复参数/超时/取消；账号元数据无token；刷新并发和401只重试一次；切换取消旧流且不能重绑旧会话；SSE跨块中文/中途断流/STOP缺失；Claude签名后到；中转非2xx、base64字节、取消和重定向；模型列表和聊天都带配置头；HTTP URL在代理开关关闭时仍走原生。

人工在测试账号和授权的中转上验收：

1. 新装登录A，刷新目录，完整输出一轮；重启后无需再次浏览器授权。
2. 添加B并切换，旧流停止；A的旧会话不能静默改用B发出。切回A再验证历史。
3. 撤销/失效授权，验证刷新失败提示；模拟进程中断，验证重新登录提示而非永久pending。
4. 中转分别验证 `/models`、Chat Completions/Responses 的非流式与完整流式，确认真实模型ID、最终URL、真实UA；切换默认、自定义、禁用三种头配置。
5. 验证取消、多轮、标题生成/摘要、导入旧聊天、导出备份及键盘遮挡。

自动检查通过不代表 Google 为该账号开放全部模型，也不代表某次网关HTTP200已经完成回答。记录验收结果应标明具体应用版本、主机、真实模型ID、请求方式和完成状态；不记录密钥或token。

## 11. 移植完成判据

交付应包含：原生认证与账号存储、原生中转HTTP、JS桥、Google协议及签名元数据、两个provider适配、设置schema/UI、消息持久化接入、云端检查和上述真机结果。若只做了浏览器登录或单次curl成功，仍未完成这个方案。

本文未包含任何 OAuth client secret、Google token、用户 API Key、签名密钥或真实账号资料。Google客户端与中转地址/Key由部署者自行配置；保留原项目适用的开源许可证及版权声明。
