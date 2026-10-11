# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与
[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.2.0] - 2026-10-11

### Added

- **省下的钱（金额折算）** —— 新增 `lib/savings.js`：按实时单价把历史用量折成金额，
  给出**今日 / 近 7 天 / 近 30 天**三个窗口的节省。
  - 公式：`节省 = Σ 缓存读 token × (未命中价 − 命中价) / 1e6`
  - 峰谷取档按 **UTC 小时** + 周末/假期表，逐**会话桶**取档（而非整天取一个时刻）
  - 未定价模型**排除**并上报，绝不套默认价；缺口用 `pricedCoverage` / `unpricedCacheRead` 如实标注
  - 单价取自 cost-meter 账本里**正在使用**的完整价表（`models` + `default` + `providers`）；
    若 profile 内装了 `dsh-cost-meter`，只借它的 `providerPriceEntryFor` / `normalizePrice` 函数
- `GET /api/cache-tuner/savings` —— 只返回省钱读数，省得为了看钱拉整份 stats
- `/api/cache-tuner/stats` 响应新增 `savings` 段
- 设置页新增**今日/7 天/30 天省钱卡片**；侧边栏 tooltip 新增三档金额
- `cache_report` 工具输出新增「省下的钱」markdown 表格
- `lib/verify-savings.mjs` —— 金额引擎自检（120 条断言，不依赖账本与第三方包）
- `dev/crosscheck-ledger.mjs` —— 金额引擎与账本真实计价的独立交叉验证
- `dev/host-integration.mjs` —— 不启动 DSH 也能验证宿主接线
- `LICENSE`（MIT）、`.gitignore`、`package.json` 的 `repository` / `keywords` / `engines` / `scripts`

### Changed

- `README.md` 重写安装章节：不再写死作者本机路径，补前置条件表
- `package.json` 版本 `0.1.0` → `0.2.0`，`files` 补 `LICENSE` 与 `CHANGELOG.md`

### Fixed

- 会话桶时间戳不再夹紧到当前时刻 —— 旧行为会把当天稍晚发生在**峰段**的会话算成谷段，**系统性低估金额**
- 全零价目条目：精确命中 `models` 时**原样使用**（不回落默认价），与账本计价语义一致
- `providers` 表里**不认识**的 provider 判定为「未定价」，不再错误地套用默认价
- 价表加载不再拼装 profile 的拆分价表（`DEFAULT_PRICE_TABLE` 缺 `providers` 层，
  会导致 provider 级定价被误判为未定价）—— 统一以账本里正在使用的完整价表为准

## [0.1.0] - 2026-10-07

### Added

- 初始版本：按步采集 token 用量、全局/会话两级命中率统计
- 缓存断点**因果归因**：对每个 section / context / 工具算 sha1 指纹并 diff，
  精确指出「是谁变了」，并把**前缀变化**（section/tools，真断点）与
  **尾部变化**（context，代价小）分开报告
- `suppressRuntimeContext` 开关（默认关）—— 省的是提示词 token，不是缓存
- `GET/POST /api/cache-tuner/settings`、`POST /api/cache-tuner/reset`、`GET /api/cache-tuner/stats`
- `cache_report` 工具、设置页（`settings.section`）、侧边栏读数（`sidebar.footer.action`）
- `lib/verify.mjs` —— 纯逻辑自检（49 项断言组）

[Unreleased]: https://github.com/Migratory_bird/dsh-cache-tuner/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Migratory_bird/dsh-cache-tuner/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Migratory_bird/dsh-cache-tuner/releases/tag/v0.1.0
