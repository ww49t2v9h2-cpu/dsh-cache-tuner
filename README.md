# dsh-cache-tuner

[![version](https://img.shields.io/badge/version-0.2.0-blue.svg)](CHANGELOG.md)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![dependencies](https://img.shields.io/badge/runtime%20deps-0-success.svg)](package.json)
[![tests](https://img.shields.io/badge/tests-169%20assertions-success.svg)](CONTRIBUTING.md)

> DeepSeek 前缀缓存调优器：**把「命中率突然掉了」变成「是 `context "time"` 又变了」，
> 并且告诉你这到底省了多少钱。**

**一句话**：DSH（DeepSeek Harness）的第三方插件。采集每一步的缓存命中情况 →
精确指出是哪一段提示词把前缀缓存弄断了 → 按实时单价折算**今日 / 近 7 天 / 近 30 天**省下的钱。

- 运行时依赖 **0**（客户端半侧零构建，只 `require('react')`）
- 不联网、不读凭据、账本只读 → [隐私与数据边界](#隐私与数据边界)
- 169 条断言的自检 + 与账本真实计价的独立交叉验证 → [自检](#自检)

---

## 用途

DeepSeek 的计费把输入 token 分成三档：

| 字段 | 含义 | 价格 |
| --- | --- | --- |
| `cacheReadTokens` | 命中前缀缓存、直接复用的输入 | **最便宜** |
| `cacheWriteTokens` | 写入前缀缓存的输入 | 较贵 |
| `inputTokens` | 完全没命中、现算的输入 | **最贵** |

所以：**提示词前缀越稳定，越省钱**。

配套插件 `dsh-whale-girl-pet` 已经在它自己的计费界面里*显示*缓存命中率。本插件补上缺的另一半 —— **因果归因 + 金额折算**：

- 每一步的 `inputTokens / cacheReadTokens / cacheWriteTokens / outputTokens` 按会话归集；
- 在 `step/start` 与 `request/header(reason=change)` 时调用 `systemPrompt.assemble()`，
  对 **每个 section、每个 context、每个工具** 分别算 sha1 指纹；
- 下一次装配时做 diff，精确指出**到底是谁变了**：

```
turn 4 / step 2 · step/start
  context "time" 文本变化
```

这样你看到的就不再是「命中率掉了」，而是「`context time` 每次请求都在变，去治它」。

**并且**：按实时单价把历史用量折成钱，给出 **今日 / 近 7 天 / 近 30 天** 三个窗口的节省金额。

### 它做什么 / 不做什么

**做：**
1. 采集 —— 全局 + 会话两级 token 统计与命中率；
2. 归因 —— 逐部件指纹 diff，把「前缀变化（section/tools，真断点）」与
   「尾部变化（context，代价小）」分开报告；
3. 省 token —— 一个开关（`suppressRuntimeContext`，默认关）+ 一份可执行建议（`notes`）；
4. **算钱 —— 今日 / 近 7 天 / 近 30 天按实时单价折算的节省金额**；
5. 暴露 —— `/api/cache-tuner/*` 接口（含 `/savings`）、`cache_report` 工具、设置页、侧边栏读数。

**不做：** 不做完整账单/成本仪表盘、不管余额、不管套餐 —— 那是 `dsh-cost-meter` 与
`dsh-whale-girl-pet` 的活。本插件**只借历史用量算「缓存省下来的那部分钱」**，
不重复实现一套计费体系。

---

## 安装

### 方式一：从源码目录 link（开发/自用推荐）

```bash
git clone https://github.com/Migratory_bird/dsh-cache-tuner.git
dsh plugin --profile desktop add link:/absolute/path/to/dsh-cache-tuner
```

Windows 上路径写成 `link:C:\path\to\dsh-cache-tuner` 也可以。

### 方式二：从打包产物安装

下载 Release 里的 `dsh-cache-tuner-0.2.0.tgz`，然后：

```bash
dsh plugin --profile desktop add ./dsh-cache-tuner-0.2.0.tgz
```

装好后重启（或让配置热重载生效），然后在 **设置 → 缓存命中** 打开页面。

- 设置页：命中率、累计 token、**今日/7 天/30 天省钱卡片**、逐步命中率柱状图、断点归因列表、开关。
- 侧边栏底部：一个 `♻ 97%` 小读数，鼠标悬停看详情（含三档省钱金额），点一下刷新。

**前置条件**

| 依赖 | 必要性 | 说明 |
| --- | --- | --- |
| DSH | 必须 | 宿主运行时。客户端 bundle 依赖 `@deepseek-ai/dsh-client-ui-slots`，由 DSH 提供。 |
| Node.js ≥ 20 | 必须 | 自检脚本与宿主半侧使用。开发时实测于 Node 26。 |
| `dsh-cost-meter` | **可选** | 只有「算钱」功能需要它：用量与价表都来自它的账本。**没装也能正常工作** —— 命中率与断点归因照常，金额显示 `—`。 |

> 本插件**不联网**，不读取任何凭据；账本只读。详见 [省下的钱](#省下的钱今日--近-7-天--近-30-天) 一节。

---

## 界面挂载点

| Slot | 内容 |
| --- | --- |
| `settings.section`（`label: 缓存命中`，`order: 57`） | 完整设置页：命中率卡片、**今日/7 天/30 天省钱卡片**、逐步命中率柱状图、断点归因、建议、开关 |
| `sidebar.footer.action`（`order: 57`） | `♻ 97%` 紧凑读数；悬停的 tooltip 里带三个窗口的省钱金额 |

两个挂载点**共享同一条 5 秒轮询**：第一个组件挂载时启动定时器，最后一个卸载时清理。
金额读数与命中率读数走同一次 `/stats` 请求，不会额外增加请求数。

---

## 配置项

宿主半侧持久化到 `$DSH_HOME/storages/cache-tuner/settings.json`
（`$DSH_HOME` 缺省为 `~/.dsh`）。所有字段都做类型净化：类型不对就丢弃回落默认值，数字越界就夹紧。

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 总开关。关掉后不再采集步数据、不再做断点归因；已采集的数据留在内存直到重置。 |
| `suppressRuntimeContext` | boolean | `false` | 调用 `ctx.systemPrompt.suppressRuntimeContext()`，整体移除动态运行上下文。**取舍见下。** |
| `stableTools` | boolean | `true` | 工具集稳定化。**本版本不注册**，原因见「已知限制」。 |
| `maxStepsPerSession` | number | `500` | 每会话保留步数上限，夹紧到 `[50, 2000]`。 |
| `maxSessions` | number | `50` | 跟踪会话数上限（LRU），夹紧到 `[5, 200]`。 |
| `maxBreaksPerSession` | number | `100` | 每会话保留断点上限，夹紧到 `[10, 500]`。 |

`cordis.patch.yml` 里的 `config` 就是这组默认值的覆盖入口。

---

## 数据口径

```
promptTokens = inputTokens + cacheWriteTokens + cacheReadTokens
hitRate      = cacheReadTokens / promptTokens        // 分母为 0 → null（不是 NaN）
savedTokens ≈ cacheReadTokens                         // 缓存读的输入远比新输入便宜
```

两点务必注意：

1. **命中率按总量算，不是各步平均。** 全局命中率是 `ΣcacheRead / Σprompt`，所以首轮的冷启动成本会被摊进来 —— 这正是真实账单的样子。
2. **`hitRate` 在没有任何数据时是 `null`**，界面上显示 `—`。任何地方都不会出现 `NaN`。

会话的 `provider` / `model` 取自 `session.requestHeader().config`，取不到就留空串。

---

## 省下的钱（今日 / 近 7 天 / 近 30 天）

### 唯一公式

同 1 个输入 token，走缓存和不走缓存是**两个价**：

```
节省(USD) = Σ 各桶 cacheReadTokens × (cacheMiss − cacheHit) / 1e6
```

直觉：这些 token 本来要按**未命中全价**买，实际只按**命中低价**付了，差价就是省下来的。

三条**刻意的口径决定**（都写进了 `lib/verify-savings.mjs` 的断言）：

| 决定 | 理由 |
| --- | --- |
| **输出 token 不计入节省** | 缓存只作用于输入侧，输出侧没有折扣；算进来是虚报。 |
| **cacheWrite 不单独计** | DeepSeek 价表没有独立写价档，计价函数回落到命中价，所以「写缓存」相对全价没有额外折扣可算。 |
| **只有 priced=true 的模型进金额** | 没有权威单价的模型（本机：`paratra-1:DeepSeek-OCR`、`GLM-4V-Flash` 等）**排除**，绝不套默认价。它们的用量照常进 token 口径，并在 `unpricedModels` 里如实上报。 |

### 数据从哪来

| 项 | 来源 |
| --- | --- |
| **历史用量** | cost-meter 账本 `$DSH_HOME/storages/cost-meter/ledger.json` 的 `days[]`（按 `provider:model` 分桶） |
| **计价粒度** | 优先 `days[d].sessions[].byProviderModel`（会话×日），拿会话自己的 `at` 取峰谷档；缺 `sessions` 时回落 `days[d].byProviderModel` 并把该天标为 `granularity: 'day'` |
| **实时单价** | 账本里**正在使用**的完整价表 `config.prices`（`models` + `default` + `providers` 三层）。若 profile 里装了 `dsh-cost-meter`，只用它的 `providerPriceEntryFor` / `normalizePrice` **函数**做 provider 级解析（用 file URL 动态 import，失败静默降级到内置解析） |
| **展示口径** | `config.currency` / `symbol` / `decimals` / `exchangeRate`（**不读** `prices.currency`，它是 `undefined`） |

> ⚠ **两个层次的币种别混**：单价是 **USD / 1M token**；账本里的 `cost` 也恒为 USD。
> 只有**展示**时才乘 `exchangeRate` 折成人民币。本机展示口径 = `¥`、4 位小数、汇率 7.2。

### 窗口与峰谷

- 窗口是**含今日的本地日历窗口**：`1` = 今日，`7` = 今天往前数 7 天，`30` = 30 天。
  **不是**「最近 7 个有数据的日子」——没有数据的那天按 0 计入，这不是丢数据。
- 峰谷价按 **UTC 小时** 判定（窗口 `[{start:1,end:4},{start:6,end:10}]`，即 UTC `01–04` 与 `06–10`），
  周末与假期表命中恒为谷价，`peakEffectiveAt` 之前恒为谷价。
- 因此同一个模型在不同时刻的 `(cacheMiss − cacheHit)` 差价不同：谷价档差价小、峰价档差价大。

### 关于「实时」的真实含义

单价取的是 **cost-meter 账本里正在使用的那份价表**（它由 `dsh-cost-meter` 维护/刷新，
本机价表带 `sourceUrl` + `checkedAt` 溯源字段），**不是**每次请求去网上现抓。
本插件不联网。账本本身带 5 秒读取缓存，价表随账本刷新而刷新。

### 自检

```bash
node lib/verify-savings.mjs    # 120 条断言，全通过 exit 0
```

覆盖：窗口边界（跨月/跨年/本地日首尾）、金额公式逐档精确、**输出不计入**、
cacheWrite 不计、峰谷/周末/假期/`rateHistory` 边界、未定价必须排除、
会话桶优先与日桶回落、模型名归一化、退化输入绝不 NaN/Infinity/抛错、
账本读取与缓存失效、展示口径夹紧、渲染不含 NaN。

---

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/cache-tuner/stats?session=<id>` | 完整快照（含 `savings` 段）。不带 `session` 时自动跟随**最近产出过 usage 的会话**；响应里的 `sessionId` 会告诉你最终用了哪个。 |
| `GET` | `/api/cache-tuner/savings?refresh=1` | **只返回省钱读数**：今日 / 近 7 天 / 近 30 天。省得为了看钱而拉整份 stats。 |
| `GET` | `/api/cache-tuner/settings` | 当前设置 + 默认值 + 能力状态。 |
| `POST` | `/api/cache-tuner/settings` | 写设置（净化后落盘）。 |
| `POST` | `/api/cache-tuner/reset` | 清空所有计数器与断点记录。 |

响应恒为 `content-type: application/json; charset=utf-8` + `cache-control: no-store`；
请求体上限 1 MB。

`/stats` 的形态：

```jsonc
{
  "ok": true,
  "sessionId": "…",
  "global":  { "steps": 0, "promptTokens": 0, "cacheRead": 0, "cacheWrite": 0,
               "input": 0, "output": 0, "savedTokens": 0, "hitRate": null },
  "session": { "…同上…", "id": "…", "steps": [ /* 逐步记录，最多 500 条 */ ] },
  "breaks":  [ { "at": 0, "turn": 0, "step": 0, "reason": "step/start",
                 "changed": ["context \"time\" 文本变化"],
                 "kinds": { "section": 0, "context": 1, "tool": 0 } } ],
  "notes":   ["…中文可执行建议…"],
  "capabilities": {
    "scope": true,
    "stableTools": { "supported": false, "checked": true, "reason": "…" },
    "suppressRuntimeContext": { "active": false }
  },
  "savings": {
    "available": true,
    "reason": "ok",                       // ok | ledger-missing | price-table-missing | not-computed
    "source": "profile+ledger",            // profile+ledger | ledger | none
    "display": { "currency": "CNY", "symbol": "¥", "decimals": 4, "exchangeRate": 7.2 },
    "windows": [
      { "window": 1,  "label": "今日",     "from": "2026-10-11", "to": "2026-10-11",
        "savingsUsd": 52.53, "savingsDisplay": 378.2212, "savingsText": "¥378.2212",
        "cacheRead": 357351808, "pricedCoverage": 1, "dayFallbackDays": 0,
        "unpricedModels": [], "unpricedCacheRead": 0, "perDay": [ /* … */ ] },
      { "window": 7,  "label": "近 7 天",  "…": "…" },
      { "window": 30, "label": "近 30 天", "…": "…", "pricedCoverage": 0.99999 }
    ],
    "unpricedModels": ["paratra-1:GLM-4V-Flash", "…"]
  },
  "recentSessions": [ /* 最近 10 个会话，供设置页的下拉框使用 */ ]
}
```

**读 `savings` 时的三个要点：**

1. `available: false` 时**不要**把金额当 0 —— 那是「算不出来」，界面必须显示 `—`。
2. `pricedCoverage < 1` 或 `unpricedModels` 非空 ⇒ 金额是**下界**，实际节省不低于它。
3. 金额是 **USD/1M token 单价 × 用量** 的结果；展示值已按 `display.exchangeRate` 折过。

## 模型侧工具

`cache_report`（无参数）生成一份中文 markdown 报告：全局/会话命中率、token 明细、
**今日 / 近 7 天 / 近 30 天的节省金额**、最近断点归因、建议。
适合直接问模型「为什么这轮没命中缓存」以及「我省了多少钱」。

---

## 归因算法

1. **每个部件一个 sha1**（`node:crypto`）：
   - section → `sha1(text)`
   - context → `sha1(text)`
   - tool → `sha1(name + "\0" + description + "\0" + stableStringify(parameters))`
2. **`stableStringify` 先对对象键排序再序列化** —— 这样「同样的工具参数、只是键顺序不同」
   不会被误判成断点。数组顺序仍然保留（数组顺序是有意义的）。
3. **`diffFingerprints` 按 `section → context → tool` 的固定顺序** 输出中文描述，
   例如 `新增 section "extra"`、`移除 context "time"`、`tools: read 定义变化`。
4. 每次断点同时记录 `changed`（给人看的字符串）和 `kinds`（给统计用的计数），
   `kinds` 驱动 `notes` 里的可执行建议。
5. 上限纪律：每会话 500 步、每会话 100 条断点、全局 200 条断点、最多 50 个会话，
   **任何结构都不会无限增长**。

---

## 已知限制

### 1. 拿不到会话作用域时，归因会退化

`ctx.systemPrompt.assemble({ scope })` 的 `scope` 就是 **Agent 对象本身**。
本插件通过 `ctx.on('agent/created')` 建立 `sessionId → Agent` 映射，
所以正常情况下能拿到完整作用域（包含会话级 scoped section / context）。

一旦拿不到（例如插件在 agent 建立之前就启动了、或映射已被 LRU 淘汰），
就会退化为 `assemble({})` —— **只覆盖全局提示词**，会话级 scoped 分区不会进入指纹。
此时 `/stats` 的 `capabilities.scope` 为 `false`，`notes` 里也会明确标注 ⚠。

**退化的后果是「漏报」，不是「误报」**：统计本身照常工作，只是归因覆盖面变窄。

### 2. `suppressRuntimeContext` 的取舍：它省的是 **token**，不是缓存

打开它会整体清空 `contexts` 数组（DSH 的实现就是 `contexts: runtimeContextSuppressed ? [] : [...]`）。

⚠ **但请先读这一条口径**：`systemPrompt.context()` 注册的动态运行上下文是以
**「尾部用户消息」**下发的（形如 `Current runtime context. This snapshot supersedes…`），
**不在系统提示词前缀里**。因此：

- 改动它**不会**破坏前缀缓存，只影响消息序列尾巴那一小段（代价小得多）；
- 打开抑制**不会提升命中率**，它提升的是「提示词 token 用量」。

本插件在 `/stats` 的归因里把变化明确分成两类，不会把两者混为一谈：

| 类别 | 成员 | 对缓存的影响 |
|---|---|---|
| **前缀变化** | `section`、`tools` | 真正位于前缀，一变其后全部失效 —— 这是真金白银的断点 |
| **尾部变化** | `context` | 只影响尾部一小段，代价小得多 |

抑制的**真实代价**（所以默认关闭）：

- 模型不再知道**当前时间**；
- 模型不再知道**工作区状态**等实时事实；
- 涉及时间、环境、"现在"的推理会明显变差。

另外：抑制只作用于 DSH 自己的运行时上下文；**插件自己注册的 context 不受影响** ——
如果开了抑制还有 context 变化，归因会照常指出是哪个 context 在动。

> 附带说明：DSH 官方路由声明了 `systemPromptUpdate: 'in-history'`。系统提示词中途变化时，
> 变化部分会被**追加到历史尾部**而不是重写第 0 个节点 —— 也就是说 DSH 自己已经在保护前缀了。
> 本插件做的事是**把这个过程变得可见**：告诉你前缀到底有没有被动过。

### 3. `stableTools` 稳定器：本版本**刻意不注册**

需求里要求「只有能返回全量可见工具集时才注册；不确定就跳过」。实际核查 DSH 0.2.0-rc.2
的实现后，结论比「不确定」更硬：

**（a）provider 是追加语义，且不按名字去重。** `assemble()` 里：

```js
const providers = [...this.layers.global.toolProviders.values(),
                   ...scopeLayers.flatMap((layer) => [...layer.toolProviders.values()])];
const collected = [];
for (const provider of providers) {
  // …
  collected.push(...schemas);          // ← 直接追加，全程没有任何按名字去重
}
```

**（b）工具注册表自己已经注册了全量 provider：**

```js
ctx.systemPrompt.tools((context) => this.wireSchemas(context.scope));
```

所以再注册一个「返回同样 schema」的 provider，**只会把每个工具原样复制一份塞进提示词** ——
提示词长度翻倍，既毁缓存又更贵，与插件目标完全相反。

**（c）收益本来就是零。** `orderTools()` 在 `toolOrder` 未配置时已经
`tools.sort(compareToolNames)` —— 工具列表本来就是按名字典序确定的。

**结论：不注册。** 设置页里这一项显示为不可用，并把原因原样写给用户看。
`/stats` 的 `capabilities.stableTools.reason` 会带上**运行时只读探测**的结果
（探测方式：装配一次，检查可见工具的 schema 是否已全部出现在装配结果里）。

### 4. 其它

- 归因是**尽力而为**的：`assemble()` 失败（比如别的插件注册了会抛错的 provider）
  只会被记一条 warn 日志然后跳过本轮，绝不会影响正常请求。
- 每个 step 最多装配一次（按 `turn:step:reason` 去重），不会让 `assemble()` 变成热路径负担。
- 计数器**只在内存里**，不落盘；重启归零。持久化的只有设置。
- 本插件没有 `peerDependencies`（安装器会拒绝无法满足的 DSH peer 依赖）。

---

## 自检

```bash
npm run verify                 # = check + test（推荐，一条命令）
node --check lib/index.js
node --check lib/client.js
node --check lib/model.js
node --check lib/savings.js
node lib/verify.mjs            # 归因/token 口径：49 项断言组
node lib/verify-savings.mjs    # 金额引擎：120 条断言
node lib/verify-http.mjs       # 需要**正在运行的 DSH**
```

`lib/verify.mjs` 是一个普通 node 脚本（**不用任何测试框架**），
直接测 `lib/model.js` 里的纯逻辑：指纹、归因 diff、token 口径、设置净化、
建议生成、上限纪律，外加一个「time 上下文每步都变」的端到端场景。
全部通过退出码 0，任何一条失败退出码 1。

`lib/verify-savings.mjs` 同样不用测试框架，把金额引擎的口径钉死在断言上
（明细见上文「省下的钱 → 自检」）。它**不需要** `dsh-cost-meter` 在场，
也不需要账本，因为所有算例都用可控的合成价表。

### 开发期工具（`dev/`）

这两个**不随包发布**，用来验证产品自检覆盖不到的那一层：

```bash
node dev/crosscheck-ledger.mjs    # 金额引擎 vs 账本真实计价（独立复算，需 dsh-cost-meter）
node dev/host-integration.mjs     # 宿主接线：桩 ctx + 真实 HTTP 处理器（只需 Node）
```

`dev/` 里为什么要有这两个脚本，以及它们各自抓到过什么问题，见 [`dev/README.md`](dev/README.md)。

---

## 文件结构

```
dsh-cache-tuner/
├── package.json          # 无 peerDependencies；dsh.bundle + dsh.client 声明
├── cordis.patch.yml      # 挂载行：id = cache-tuner
├── README.md             # 本文档
├── CHANGELOG.md
├── CONTRIBUTING.md
├── LICENSE               # MIT
├── .gitignore
├── dev/                  # 开发期工具（不随 npm 包发布）
│   ├── README.md
│   ├── crosscheck-ledger.mjs
│   └── host-integration.mjs
└── lib/
    ├── index.js          # 宿主半侧：事件采集、归因、稳定器、路由、cache_report 工具
    ├── model.js          # 纯逻辑：token 口径、指纹、diff、净化、建议（可独立测试）
    ├── savings.js        # 金额引擎：窗口、峰谷档、价表解析、账本读取、渲染
    ├── loopback.js       # 环回来源判定（路由安全围栏）
    ├── client.js         # 浏览器半侧：零构建、零依赖（只 require('react')）
    ├── verify.mjs        # 归因/token 口径自检
    ├── verify-savings.mjs# 金额引擎自检
    └── verify-http.mjs   # 对运行中的 DSH 打接口的自检
```

`package.json` 的 `files` 只收 `lib/`、`cordis.patch.yml`、`README.md`、
`CHANGELOG.md`、`LICENSE` —— 所以 `dev/` 与 `.gitignore` **不会进 npm 包**，
但会留在 GitHub 仓库里。

三处标识必须一致，改动时请一起改：

| 位置 | 值 |
| --- | --- |
| `cordis.patch.yml` 行 `id` | `cache-tuner` |
| `lib/index.js` → `export const name` | `cache-tuner` |
| `lib/client.js` → `exports.name` | `cache-tuner` |
| `lib/client.js` → `window.__ModuleLoader__.load({ id })` | `dsh-cache-tuner`（**包名**） |

---

## 隐私与数据边界

这个插件会读你的 token 用量，所以这一节写清楚它碰什么、不碰什么：

| 行为 | 说明 |
| --- | --- |
| **不联网** | 插件自身不发任何网络请求（没有 `fetch`、没有 `http` 客户端）。单价来自本机账本。 |
| **不读凭据** | 不读 `~/.dsh/.credentials.yaml`，不读环境变量里的密钥。 |
| **账本只读** | `storages/cost-meter/ledger.json` 只以 `readFileSync` 读取，从不写入。 |
| **落盘只有设置** | 唯一写入的是 `storages/cache-tuner/settings.json`（开关与上限）。 |
| **token 计数只在内存** | 全局/会话统计量只存在内存里，重启归零，不落盘。 |
| **接口只对环回开放** | `/api/cache-tuner/*` 由 `lib/loopback.js` 挡住非环回来源，返回 403。 |
| **账本含隐私** | ⚠ 账本条目里有 `sessions[].title`（你的会话标题）。本插件**不读取也不展示**该字段，只在本地内存里对着 `provider:model` 计数。**给 issue 报数时不要贴整个账本文件。** |

---

## 贡献

见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。提交前请确保：

```bash
npm run verify                  # 语法 + 两个自检
node dev/host-integration.mjs   # 宿主接线
```

## 致谢

- 计价口径与价表来自 [`dsh-cost-meter`](https://www.npmjs.com/package/dsh-cost-meter)（本插件不修改它，只读它的账本、可选地借用它的计价函数）。
- 本插件是 [DSH（DeepSeek Harness）](https://deepseek-harness.github.io/deepseek-harness/) 的第三方插件，
  宿主运行时以 [`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh) 发布；
  本项目与 DeepSeek 官方无隶属关系，也未获其背书。

---

## License

[MIT](LICENSE) © 2026 dsh-cache-tuner contributors
