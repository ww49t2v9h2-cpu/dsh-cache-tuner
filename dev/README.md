# dev/ —— 开发期工具

这里的东西**不是产品代码**，不会被 `package.json` 的 `files` 收进 npm 包。
它们的存在是为了让「改动之后怎么确认没算错」这件事可以复现。

| 脚本 | 需要什么 | 它证明什么 |
| --- | --- | --- |
| `crosscheck-ledger.mjs` | 真实账本 + `dsh-cost-meter` | 本插件的金额引擎与账本真实计价**独立复算一致**（相对误差 < 1e-6） |
| `host-integration.mjs` | 只要 Node | `lib/index.js` 的接线可用：快照 `savings` 段、`GET /savings`、`cache_report` 工具 |

产品自检（不需要真实账本，全用合成数据）在 `lib/` 里：

```bash
npm run verify                 # = check + test
node lib/verify.mjs            # 归因 / token 口径
node lib/verify-savings.mjs    # 金额引擎
node lib/verify-http.mjs       # 需要**正在运行的 DSH**
```

## 跑两个 dev 脚本

```bash
# 1) 账本一致性（需要 dsh-cost-meter）
node dev/crosscheck-ledger.mjs

# 路径默认取 $DSH_HOME（缺省 ~/.dsh），也可以显式指定：
DSH_HOME=/path/to/.dsh \
DSH_PROFILE_DIR=/path/to/.dsh/profiles/desktop \
  node dev/crosscheck-ledger.mjs

# 2) 宿主接线
node dev/host-integration.mjs
```

两个脚本都只读，退出码 0 = 通过、1 = 失败。

## 为什么金额引擎要专门做交叉验证

命中率和断点归因错了，你最多是看着不舒服；**金额算错了，你会被误导去做错误的决策**。
所以金额这条路有两条独立的验证：

1. **内部口径自洽** —— `lib/verify-savings.mjs` 用合成价表把每条口径钉死
   （峰谷取档、rateHistory 边界、未定价排除、窗口边界、退化输入不 NaN）。
2. **与外部真相对账** —— `dev/crosscheck-ledger.mjs` 把同一份账本用
   `dsh-cost-meter` 自己的 `providerPriceEntryFor` + `tierFor` 重算一遍，
   两条路径必须逐窗口吻合。

第 2 条曾经真的抓到过问题：早期版本为了「稳妥」把会话时间戳夹紧到当前时刻
（`Math.min(session.at, nowMs)`），结果把当天稍晚发生在峰段的会话算成了谷段，
系统性低估金额。只靠自洽测试发现不了这个 —— 因为自洽测试里的期望值也是照着同一个错误假设写的。
