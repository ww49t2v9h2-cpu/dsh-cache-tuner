# 贡献指南

感谢愿意帮忙。这个插件的核心价值是**「说的每一句话都要能被验证」**，
所以下面大部分要求都是围绕这一点。

## 开发环境

```bash
git clone https://github.com/Migratory_bird/dsh-cache-tuner.git
cd dsh-cache-tuner

# 装进 DSH（用 link 方式，改代码后重启/热重载即可生效）
dsh plugin --profile desktop add link:$PWD

npm run verify     # 提交前必须全绿
```

只需要 Node.js ≥ 20。**没有构建步骤**：客户端半侧是零依赖、零打包的
`window.__ModuleLoader__.load({...})` 形式，只 `require('react')`。

## 硬性约束（改代码前请先读）

1. **不许 `import '@deepseek-ai/*'`。**
   宿主半侧只允许 `node:*` 内建模块与相对路径 `./x.js`。
   （唯一例外是 `savings.js` 用**绝对文件路径**动态 import `dsh-cost-meter` 的
   `pricing.js` —— 那是 profile 安装的第三方包，且包在 `try/catch` 里，
   失败只降级不报错。）
2. **监听器绝不向事件总线抛异常。** 所有 `ctx.on(...)` 回调整段包 `try/catch`。
3. **一切结构都有上限。** 步数、断点、会话、账本缓存——任何会随运行时间增长的东西
   都必须有明确的截断策略。
4. **`null` 不能变成 `NaN`。** 没有数据就是 `null` 或 `—`，不要用 `0` 冒充，
   也不要在界面上漏出 `NaN` / `Infinity` / `undefined`。
5. **「算不出来」和「等于 0」是两件事。** 金额不可用时报 `available: false`，
   绝不当 0 展示。

## 改「金额」相关的代码时

金额是唯一会让用户**做出错误花钱决策**的输出，门槛更高：

- 任何公式/口径改动，都要在 `lib/verify-savings.mjs` 里补一条**有明确期望值**的断言
  （不是「跑通就行」）。
- 涉及账本真实计价的改动，额外跑 `node dev/crosscheck-ledger.mjs`，
  必须与 `dsh-cost-meter` 的独立复算吻合（相对误差 < 1e-6）。
- 想「顺手稳妥一点」而给时间戳做夹紧、给未知模型套默认价之类的改动 —— **先别做**。
  这两类改动都真实发生过并导致过金额算错，原因写在 `dev/README.md` 里。

## 提交前检查清单

```bash
npm run check                     # 语法
npm test                          # 两个自检脚本
node dev/host-integration.mjs      # 宿主接线
```

- [ ] 上面的命令全绿
- [ ] 改了对外行为 → 更新 `README.md`
- [ ] 改了行为/修了 bug → 在 `CHANGELOG.md` 的 `[Unreleased]` 下加一条
- [ ] 改了 `.js` 文件名或导出 → 检查 `package.json` 的 `exports` / `files`
      （漏掉 `files` 会导致 npm 包里少文件，而本地一切正常）

## 三处标识必须一致

改了插件 id 的时候，这四个地方要一起改（漏一个就是「装上了但不生效」）：

| 位置 | 值 |
| --- | --- |
| `cordis.patch.yml` 行 `id` | `cache-tuner` |
| `lib/index.js` → `export const name` | `cache-tuner` |
| `lib/client.js` → `exports.name` | `cache-tuner` |
| `lib/client.js` → `__ModuleLoader__.load({ id })` | `dsh-cache-tuner`（**包名**） |

## 提交信息

用 [Conventional Commits](https://www.conventionalcommits.org/) 风格：

```
feat(savings): 支持按会话桶取峰谷档
fix(savings): 不再把峰段会话夹紧成谷段
docs: 补充未定价模型的口径说明
test: 补 30 天窗口跨月边界断言
```

## 报告问题

提 issue 时请带上：

1. DSH 版本与 Node 版本
2. 复现步骤
3. `node dev/host-integration.mjs` 和 `npm test` 的输出
4. 如果是金额对不上，附上 `node dev/crosscheck-ledger.mjs` 的输出

**不要**在 issue 里贴完整账本文件 —— 它包含你的会话标题等隐私信息。
只贴相关的数字与 `provider:model` 键名即可。
