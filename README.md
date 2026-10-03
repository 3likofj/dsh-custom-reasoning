# dsh-custom-reasoning

**自动**给官方没有推理强度(Effort)选项的第三方模型补上标准五档推理等级，补完后由 DSH 官方推理等级选择器接管。

```
切换到一个未声明推理强度的 pi-ai 模型
        ↓ 自动（无需点击）
   该模型获得 off/low/medium/high/max
        ↓
   官方模型菜单出现「推理等级」行  ← 之后一直由官方控件负责
```

## 它解决什么

DSH 的推理强度来自**适配器声明**的元数据（`dsh-llm` 的 `LlmModelReasoningInfo`）：

- 适配器声明了 → 官方模型选择器显示 Effort 行，选择结果真正发到 provider。
- 适配器没声明 → 官方不显示 Effort 行；而且 `dsh-llm` 会直接拒绝任何未声明的强度
  （`UNSUPPORTED_REASONING_EFFORT`），请求根本发不出去。

所以"自定义强度"唯一自洽的做法是**把等级声明给适配器**。本插件就是这么做的：
对 `llm-pi-ai` 路由，在该 provider 的模型条目上写 `reasoningEfforts`
（pi-ai 的 `thinkingLevelMap`：等级 → 线上字段值），必要时再补
`compat.supportsReasoningEffort` / `compat.thinkingFormat`，让 pi-ai 真的把参数发出去。

## 行为（自动）

1. 当前会话的模型每次变化，插件判断它是否属于 `llm-pi-ai` 且**没有任何 reasoning 元数据**
   （即官方 Effort 行缺失）。是则**自动**为该模型声明五档 `reasoningEfforts` —— 不需要点击。
2. 声明走宿主自身的 `remote.settings.mutate("llm-pi-ai", …)`
   （DSH Settings 的版本化、volatile-only 写路径，落到当前 profile 的 Cordis patch）。
3. 宿主随即重发模型目录 → 该模型开始声明五个等级 → **官方 Effort 行出现**，本控件自动隐藏。
4. 于是**每一个**这样的第三方模型都会被自动补上官方样式的推理强度选择；
   已经声明过（官方已有 Effort）的模型不会被重复写入。

**声明等级本身不改变任何请求**：pi-ai 只在真正选中某个等级时才发送推理参数，
所以"开启"是惰性且可逆的——不会把不支持推理的模型打坏。

模型栏左侧仍保留一个状态小胶囊（只在官方缺失时才出现）：

| 胶囊 | 含义 |
|---|---|
| `● 推理强度 开启中…` | 正在自动声明 |
| `● 推理强度` | 已声明/需要手动选择；点开可选五档、选线格式、关闭自动 |
| `● 推理强度 未开启` | 声明失败，hover 显示原因 |
| （不显示） | 官方 Effort 行已存在，或该 provider 不属于 `llm-pi-ai` |

胶囊菜单里有一项 **"选中未声明强度的模型时自动开启"**（默认勾选，存在浏览器
`localStorage`）。取消勾选后插件不再自动写入，改为手动点选等级。

## 等级与线上映射

| 等级 | 线上值 |
|---|---|
| `off` | `null`（pi-ai 语义：不发送推理参数） |
| `low` | `low` |
| `medium` | `medium` |
| `high` | `high` |
| `max` | `max` |

菜单里还有一个**线格式**下拉（`none`/`openai`/`deepseek`/`zai`/`qwen`/`together`/`baseten`/
`openrouter`/`chat-template`/`qwen-chat-template`/`string-thinking`/`ant-ling`），
只在路由的 `api` 解析为 `openai-completions` 时出现：

- 默认 `openai` → 写 `compat = { supportsReasoningEffort: true, thinkingFormat: "openai" }`。
- 网关自带推理格式（智谱 `zai`、千问 `qwen`、OpenRouter…）→ 选对应格式。
- 完全不写 compat → 选 `none`。

其他协议（如 `openai-responses`）**不写 compat**：pi-ai 对它们要么自带目录 compat，要么原生发送。
模型已有的 `compat` 字段会被逐字段保留。

## 适用边界

- **只支持 `llm-pi-ai` 路由**（`jagb` / `amd` / `platform` / `nvidia` / `zai` 这类第三方 OpenAI 兼容端点）。
  DeepSeek 官方适配器本来就有 `off/low/high/max`，官方 Effort 行永远在，本插件不会介入。
- **只处理出现在模型目录里的模型**。目录里查不到的模型无法判断推理能力，插件不会猜、也不会写。
- 该模型必须**在其 provider 的 `models` 列表里**。插件按模型 id 定位并整段回写 `models`
  （不依赖数组下标），`apiKeyEnv` / `api` / `baseURL` 等同级字段原样保留。
- 偏好写入 profile 自己拥有的那一层 `models` 数组；模型是继承来的则回退到生效数组。
- 声明后需等宿主重发目录（通常 <1s）；官方 Effort 行随即出现。
- 声明会**持久化**到 profile 的 Cordis patch。撤销：删掉该模型的 `reasoningEfforts` 字段
  （设置 → 模型，或直接编辑 `cordis.patch.yml`）。

## 安装

### 从 GitHub 安装

```powershell
dsh plugin --profile <profile> add github:3likofj/dsh-custom-reasoning
```

把 `<profile>` 换成你的 profile 名（例如 `desktop`）。需要可复现的固定版本时，在末尾钉住一个提交：

```powershell
dsh plugin --profile <profile> add github:3likofj/dsh-custom-reasoning#<commit-sha>
```

仓库：<https://github.com/3likofj/dsh-custom-reasoning>

### 本地 `link:` 安装（开发用）

改代码时指向工作副本，改动直接生效、无需重新安装：

```powershell
dsh plugin --profile desktop add link:<本目录绝对路径>
```

### 启用 bundle

两种装法都需要**启用 bundle**（`dsh.profile.bundles` 里要有 `dsh-custom-reasoning`）。

插件通过 `package.json` 的 `dsh.bundle.patch`（`cordis.patch.yml`）插入一行 Loader 条目；
`dsh.client` 声明让 Web 端加载 `exports["./client"]`（`lib/client.js`）。
**改动 `lib/client.js` 后需要 disable → enable bundle 一次**，客户端模块图才会重新扫描该行
（改主机半区还需要重启 DSH：Node 按 URL 缓存模块）。

`lib/client.js` 是**直接手写的 module-loader bundle**（`window.__ModuleLoader__.load({id, factory})`），
只 `require("react")`（平台内置模块表），所以**没有构建步骤**，也没有 `dsh.client.external` 依赖。

`lib/index.js`（节点半区）**零 import**：本地 `link:` 安装的包从自身位置解析裸模块名，
位于 profile 的 `node_modules` 之外，任何依赖都会让这个空半区加载失败。

## 验证

```powershell
node test/verify.mjs
```

无浏览器、无构建的离线验证（58 项）：捕获 bundle 工厂 → 用桩 `react` 物化 → 断言注册接线、
"是否需要声明"的判定表、`buildWrite` 的路径操作 / compat 合并 / wire 格式 / 继承回退 / 拒绝分支，
以及自动路径真正执行的完整链路（`describe → buildWrite → mutate`，含 revision、命名空间与被拒消息）。
