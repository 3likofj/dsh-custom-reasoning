# dsh-custom-reasoning — 研发记忆

> 本文件是本插件研发过程中积累的**源码级事实**与**踩坑记录**。它比 README 更底层：
> README 讲"怎么用"，这里讲"为什么这么做、DSH 内部到底怎么工作、哪些坑踩过"。
>
> 记录时基线：**DSH 0.2.0-rc.2（desktop profile）**。DSH 升级后请优先复核 §2 里标注了
> 文件/行号的断言。

---

## 1. 一句话目标与设计结论

**目标**：官方模型选择器里没有"推理等级(Effort)"的第三方模型，自动给它们补上官方样式的推理等级。

**设计结论（被硬约束逼出来的）**：插件**不能**注入强度，只能**声明强度**。

```
适配器没声明 reasoning 元数据
   ├─ 官方 composer 不渲染 Effort 行（用户看不到强度入口）
   └─ dsh-llm 会拒绝任何 reasoningEffort（UNSUPPORTED_REASONING_EFFORT，请求发不出去）
所以「自定义强度」唯一自洽的做法 = 把等级声明给适配器
声明之后 → 适配器开始声明等级 → 官方 Effort 行必然出现
```

由此得到插件的形态：**检测到未声明强度的 pi-ai 模型 → 自动把五档写进该模型的
`reasoningEfforts` → 官方选择器接管 → 本插件控件自动隐藏**。任意时刻只有一个强度入口。

关键安全性质：**声明等级本身不改变任何请求**（见 §2.2），所以自动声明是惰性的、可逆的，
不会把不支持推理的模型（OCR 类等）打坏。

---

## 2. DSH 源码级契约

### 2.1 推理强度的权威来源

- 类型：`@deepseek-ai/dsh-llm` → `LlmResolvedModelInfo.reasoning?: LlmModelReasoningInfo`
  ```ts
  interface LlmModelReasoningInfo { efforts: readonly LlmReasoningEffortInfo[]; defaultEffort?: ReasoningEffortId }
  interface LlmReasoningEffortInfo { id: ReasoningEffortId; name: string; description?: string }
  ```
  由适配器的 `resolveModel(provider, model)` 返回，服务侧 `normalizeModelInfo()` 校验
  （空 efforts / 重复 id / 未知 defaultEffort 都会抛 `INVALID_MODEL_REASONING`）。
- **没有 `reasoning` 字段 = 没有 Effort 行**。官方 composer 的模型座位
  （`conversation.input.model`，包 `@deepseek-ai/dsh-client-ui-model-selection`）用
  `model.reasoning` 决定是否渲染 Effort 行；`LlmModelReasoningInfo === undefined` → 行缺席。
- **校验点**（`dsh-llm/lib/index.js` 约 2174–2186，`resolveCallConfig`）：
  ```js
  const reasoning = info.reasoning;
  const requested = defaulted.reasoningEffort;
  if (reasoning === void 0) {
    if (requested !== void 0) throw new LlmError(`... does not support reasoning effort "${requested}"`, 'UNSUPPORTED_REASONING_EFFORT');
  } else {
    const effective = requested ?? reasoning.defaultEffort;
    if (effective !== void 0 && !reasoning.efforts.some(e => e.id === effective)) throw new LlmError(..., 'UNSUPPORTED_REASONING_EFFORT');
    else resolvedConfig = { ...defaulted, reasoningEffort: effective };
  }
  ```
  → **不能绕过声明偷发强度**。这是整个插件存在的理由。

### 2.2 pi-ai 适配器（`@deepseek-ai/dsh-llm-pi-ai`）

`lib/index.js`：

- 等级集合 `THINKING_LEVELS = ["off","minimal","low","medium","high","xhigh","max"]`
- `resolveModelReasoning(provider, entry, base)`：
  | 模型配置 `reasoningEfforts` | 结果 |
  |---|---|
  | 省略 | `{ reasoning: base?.reasoning ?? false }` — 沿用 pi-ai 内置目录能力 |
  | `false` | `{ reasoning: false }` — 明确非推理 |
  | 非空字典 | `{ reasoning: true, thinkingLevelMap }` — 未声明的等级被**钉成 `null`（不支持）** |
  校验规则：
  - `off: null` 合法（语义 = 不发任何推理参数）；**其它等级的 wire 值必须是非空字符串**
  - 至少要有一个 `off` 以外的等级
  - 空字典 `{}`、`null` 都非法
- `getSupportedThinkingLevels(model)` 决定官方 Effort 行里出现哪些档
- `resolveReasoningLevel(model, options.reasoningEffort ?? profile.reasoning)`：
  显式等级不在支持集里 → **适配器自己也会抛** `UNSUPPORTED_REASONING_EFFORT`
- **惰性关键点**：`thinkingLevelMap` 只在真正选中某档时才映射出 wire 参数；
  两个都 undefined 时返回 undefined → **不发推理参数**。所以"声明等级"≠"改变请求"。
- 线格式 `SUPPORTED_THINKING_FORMATS`：
  `openai, deepseek, openrouter, together, baseten, zai, qwen, chat-template,
   qwen-chat-template, string-thinking, ant-ling`
- `COMPAT_GATES`（关键，写错会在 resolve 时 `invalid()` 直接报错）：
  - `openai-completions` 提供（`offer`）：`supportsReasoningEffort`、`thinkingFormat`、
    `supportsThinkingTokenBudget`、`thinkingTokenBudgetField`、`supportsStore`、
    `supportsDeveloperRole`、`maxTokensField`、`chatTemplateKwargs/Args`、`vllmPriority` …
  - `openai-responses` / `azure-openai-responses` / `openai-codex-responses`
    **只**提供 `supportsDeveloperRole`、`supportsMaxOutputTokens`、`supportsStrictMode`、
    `supportsLongCacheRetention`
    → **不能在 responses 路由上写 `thinkingFormat`**
  - `anthropic-messages` 又是另一套（`forceAdaptiveThinking` 等）
- `THINKING_TOKEN_BUDGET_FIELDS = thinking_token_budget | thinking_budget | thinking_budget_tokens`
- 路由级 `api` 只接受：`openai-completions | openai-responses | anthropic-messages`
- 路由配置在**每次请求**重新解析（`config.providers.get()` 记忆化于原始快照身份），
  所以设置写入后**下一次请求即生效，无需重启**。

### 2.3 客户端 UI 契约

- 槽位：`conversation.input.right`（`list`，scope `session`，`replaceRisk: none`），
  渲染位置在 `conversation.input.model`（官方模型座位）**之前**
- **standardProps 里明确有 `sessionId: SessionId`**
  → 优先用 `props.sessionId`，不要把 `inject(sessionId)` 的调用约定当唯一来源
  （本插件两者都用：标准 prop 优先，注入 echo 兜底）
- 注册 API：
  ```js
  ctx.slots.inject(SLOT, () => ctx.slots.register(
    { name: SLOT, id: '<uniq>', order: 20, label: () => '推理强度', inject?: (sessionId) => props },
    Component,
  ))
  ```
- 官方模型目录服务 `ctx.modelDirectories`（由 `dsh-client-ui-model-selection` 提供，
  服务类名 `ModelDirectoryResolver`）：
  - `directoryFor(sessionId)` → `ModelDirectory`（内部按 `sessions.binding(sessionId)` 记忆化）
  - `directory.store` 快照形状：
    `{ current, routable, groups, failures, status, pending, error, retainedEffort? }`
    - `current` = 会话当前的 `{provider, model, reasoningEffort?}`（来自 modelSelection 投影）
    - `groups[].models[]` 里每个模型带 `reasoning`（**这就是判定"官方有没有 Effort 行"的依据**）
    - `status` ∈ `idle | loading | ready | error | selecting`
  - `directory.load()`（已 ready 时直接返回）/ `directory.select({provider, model, reasoningEffort?})`
  - 目录刷新由这些事件驱动：`llm/adapters-updated`、`settings/document-updated`、
    `credentials/record-updated`、`credentials/reference-updated`、`connection/reset`
- 客户端服务注入名：`["slots", "modelDirectories", "remote", "remote.settings"]`

### 2.4 配置写入契约（本插件唯一的写路径）

- `ctx.remote.settings.describe()` →
  `{ ok, value: { namespaces: [{ ns, revision, value, base, user, schema, ... }] } }`
  - 远程返回会 **redact secret**（`apiKeyEnv` 是 `role: credential-ref`）
  - `value` = 生效层，`user` = profile 覆盖层，`base` = 下层继承
- `ctx.remote.settings.mutate(ns, ops, expectedRevision)`
  - `ops: [{ op: 'set' | 'unset', path: string[], value? }]`
  - **路径必须落在 volatile 字段内**（host 侧 `isVolatilePath` 会拒）
- `llm-pi-ai` 的 Config：`z.object({ providers: z.dict(profile).default({}).volatile() })`
  → `providers` 是 volatile，路径 `['providers', <route>, 'models']` 合法
- 模型条目 schema 的合法字段：`id, name, contextWindow, maxTokens, input[],
  reasoningEfforts, compat{...}, api`；`reasoningEfforts` 的 key 域 =
  `off | minimal | low | medium | high | xhigh | max`
- host 侧 `mutate` 在 **profile 覆盖层**上求值：
  `change(projectForm(form, raw), projectForm(form, inherited), schema)`
  → **整段回写 `models` 数组比按下标写更稳**（不依赖层间顺序）；同级的
  `apiKeyEnv / api / baseURL` 会被 path-op 的克隆语义保留
  → 首选覆盖层自己的 `models`（`row.user.providers[route].models`），
    模型是继承来的则回退生效层（`row.value...`）
- 提交会话选择：`directory.select(...)` → `sessions.selectModel` → 落 Session 日志
  （`session-controller` 的 `selectModel` Remote）

---

## 3. 插件工程约定（打包与双半区）

### 3.1 一个包 = 两个半区

| 半区 | 入口 | 由谁加载 |
|---|---|---|
| host（Node） | `exports["."]` → `lib/index.js` | Cordis Loader 行 |
| client（浏览器） | `exports["./client"]` → `lib/client.js` | `dsh-client-modules`（需 `dsh.client.platform === 'web'`） |

`package.json` 必需字段：
```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web", "external": [] }
}
```

### 3.2 客户端 bundle 协议（手写，无需构建）

```js
window.__ModuleLoader__.load({
  id: "<包名>",
  factory: (require) => {
    const module = { exports: {} };   // ← 必须自建！loader 不提供 CommonJS 全局
    const React = require("react");   // 只能 require 平台种子表 / dsh.client.external
    ...
    module.exports = { name: "<包名>", inject: [...], apply };
    return module.exports;
  },
});
```
- `dsh.client.external` 用于声明**非基线**的模块请求；只 `require("react")` 时留空
  （React/Cordis/静态 UI 库在平台种子表 `PLATFORM_MODULES` 里）
- 客户端 bundle **不做依赖解析**，所以可以手写，不需要 bundler

### 3.3 行名规则（硬性）

> **Loader 行的 `name` 必须恰好等于包名。**

`dsh-client-modules` 用 `require.resolve('<row-name>/package.json')` 定位包 manifest，
行名是子路径（如 `pkg/diag`）会直接 `failed to import`。浏览器模块 id = 解析出的 **manifest 包名**
（不是行名）。

### 3.4 `cordis.patch.yml`

```yaml
- insert:
    - id: dsh-custom-reasoning      # Loader 条目 id
      name: dsh-custom-reasoning    # 必须 == 包名
```

---

## 4. 踩坑记录（现象 → 根因 → 结论）

| # | 现象 | 根因 | 结论 |
|---|---|---|---|
| 1 | `pwsh` 每次退出码 `0xC0000142`，无输出 | workspace-write 沙箱注入导致 DLL 初始化失败 | 提高文件策略（danger-full-access）后正常；沙箱模式下不要指望 shell |
| 2 | 插件 enable 报 `failed to import` | host 半区 `import Schema from "@deepseek-ai/schemastery"`；包是 `link:` 安装，位于 profile 的 `node_modules` **之外**，裸模块名解析不到 | **host 半区零 import**（改用 `ctx.get('llm')` 代替 `inject`，配置项挪到客户端菜单） |
| 3 | 改了 `lib/index.js`，disable→enable 后仍是旧行为 | Node 按 **URL** 缓存 ESM；同一 specifier 二次 import 拿到旧模块（只有上次**解析失败**的会重新解析） | **改 host 半区必须重启 DSH**；客户端半区不同 —— bundle 重新发布时会重新读盘，disable→enable 即生效 |
| 4 | 用子路径行名 `dsh-custom-reasoning/diag` 强制换 URL → `failed to import` | §3.3 的 `require.resolve('<row-name>/package.json')` 规则 | 行名只能是包名；换 URL 只剩"改包名/重启"两条路 |
| 5 | 浏览器里 `module is not defined` | 手写 bundle 漏了 `const module = { exports: {} }` | 官方 bundle 都自建 module record（该 bug 被离线测试用例抓到） |
| 6 | 官方 Effort 行、`describe()` 都正常，但"控件只生效一次" | **未定位**（见 §7） | v0.2 改为"自动声明"，不再依赖用户点击 |

---

## 5. 开发与调试流程

```powershell
$node = 'C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$pnpm = 'C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs'

# 语法
& $node --check lib\client.js
& $node --check lib\index.js

# 离线单测（无浏览器、无构建；58 项）
& $node test\verify.mjs
```

安装 / 刷新（Web GUI 会话里用 `plugin_manager` 工具）：

| 目的 | 操作 |
|---|---|
| 首次安装 | `install_bundle`，target = 本目录绝对路径（落成 `link:` 依赖） |
| 刷新**客户端**半区 | `set_bundle enabled=false` → `enabled=true`（强制重新扫描该行） |
| 刷新**主机**半区 | 只能重启 DSH（见坑 #3） |

运行时校验（只读 Inspect 查询）：

- 客户端槽位占用：`cordis_inspect_query` client `Slots.listSubTree`，`root = "conversation.input.right"`
  → 期望 `occupants` 里出现本插件且 `active: true`
- 配置 schema（写入目标合法性）：host `Config.listConfigs`，`entry = "include:llm-pi-ai"`
  → 期望 `providers` 带 `x-cordis.volatile: true`，模型字段含 `reasoningEfforts` / `compat`
- Loader 条目：`plugin_manager list_plugins` → 找 `include:dsh-custom-reasoning`，`fiberPhase: active`

profile 位置与相关文件：

```
C:\Users\Administrator\.dsh\profiles\desktop\
  package.json        # dependencies + dsh.profile.bundles
  cordis.patch.yml    # profile 覆盖层（本插件写入 reasoningEfforts 的地方）
  node_modules\dsh-custom-reasoning -> <本目录>   # 符号链接
```

---

## 6. 发布流程

```powershell
# 1) package.json 必须无 private；files 白名单；dsh.bundle.patch 存在
#    files: ["lib/index.js","lib/client.js","cordis.patch.yml","README.md","LICENSE"]
# 2) 核对包内容（test/ 不应入包）
& $node $pnpm pack --dry-run
# 3) git
git init -b main; git add -A; git commit -m "feat: dsh-custom-reasoning 0.1.0"
git remote add origin <repo>; git push -u origin main; git tag v0.1.0; git push origin v0.1.0
# 4) npm（非作用域包不需要 --access public）
npm login; npm publish --dry-run; npm publish
```

---

## 7. 未解问题与后续

### 7.1 "控件只生效一次"的根因未定位（v0.1 现象）

用户报告：手动开启一次后，切到其他第三方模型不再出现控件。

已排除/已确认：
- 客户端与主机半区都仍在挂载（`Slots` 查询 + `list_plugins` 均 active）→ 不是被卸载
- 磁盘上的写入正确：`cordis.patch.yml` 里 `reasoningEfforts` 落在正确的 provider/model 上，
  同级字段完好
- 可见性判据与官方一致（都读 `model.reasoning`），逻辑上应当对每个缺元数据的模型成立

**未能拿到真值的原因**（环境限制，记录以免重走）：
1. 主机半区改文件不生效（坑 #3），探针跑不起来
2. 想用子路径行名换 URL 被 §3.3 规则拒绝
3. pi-ai 不是磁盘上独立包（已打进 asar），无法离线复算目录
4. 没有可从 agent 侧读取"实时模型目录"的 Inspect provider

**v0.2 的规避策略**：把交互从"点一下"改成"自动声明"，
从根上消除"控件没出现 → 没生效"这个失效模式；
并把每一种异常状态做成**可见胶囊**（`开启中…` / `未开启` + hover 原因 / 模型未出现在目录中），
下一次若仍异常，用户看到的文字即可直接定位分支。

### 7.2 其他可做项

- 把"线格式"做成持久配置（当前在胶囊菜单里，每次声明时用；自动路径固定 `openai`）
- `thinkingBudgets`（token 预算）目前未暴露
- 若 DSH 暴露了可读的模型目录 Inspect provider，可补一个端到端自动化验证

---

## 8. 文件地图

```
dsh-custom-reasoning/
├─ package.json          双半区声明 + dsh.bundle/dsh.client + files 白名单
├─ cordis.patch.yml      Loader 行（name 必须 == 包名）
├─ README.md             用户视角：行为、等级映射、边界、安装、验证
├─ LICENSE               MIT
├─ docs/DEV-NOTES.md     本文件：研发记忆
├─ lib/index.js          host 半区：零 import 的空 Cordis 插件
├─ lib/client.js         浏览器半区：手写 module-loader bundle
│                         （自动声明 + 可见状态胶囊 + settings.mutate 写入）
└─ test/verify.mjs       离线验证 58 项：注册接线 / 判定表 / buildWrite /
                         declareLevels 全链路 / 拒绝分支
```
