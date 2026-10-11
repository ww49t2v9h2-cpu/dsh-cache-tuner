/**
 * ============================================================================
 * dsh-cache-tuner —— 节省金额引擎自检（verify-savings.mjs）
 * ============================================================================
 *
 * 目的：把 `lib/savings.js` 里所有「口径」钉死在可执行断言上。
 * 用法：node lib/verify-savings.mjs   （全通过退出码 0，任一失败退出码 1）
 *
 * 覆盖（每条都有明确期望值，不是「跑通就算过」）：
 *   1. 窗口边界：含今日的**日历**窗口；跨月、跨年、本地日首尾。
 *   2. 金额公式：节省 = Σ cacheRead × (cacheMiss − cacheHit) / 1e6，逐档精确。
 *   3. 输出 token 不计入、cacheWrite 不单独计。
 *   4. 峰谷取档：UTC 小时窗口 / 周末 / 假期 / 生效时刻；rateHistory 的 before 边界。
 *   5. 未定价模型必须排除（绝不套默认价），且能上报；全零价条目视同未定价。
 *   6. 缺口如实上报：pricedCoverage / unpricedCacheRead / dayFallbackDays。
 *   7. 退化输入：账本缺失 / config 缺失 / 空 days / 负值 / 字符串 / NaN →
 *      金额恒为 0，绝不出现 NaN、Infinity、undefined。
 *   8. 会话桶优先、缺 sessions 时回落日桶并标 granularity。
 *   9. 账本缓存：文件未变时读缓存、文件变化时失效。
 *  10. 渲染：formatMoney / renderSavingsMarkdown 在不可用与可用两种状态下都不抛错。
 *
 * 只依赖 node 内建模块 —— 不需要跑起 DSH，也不需要 dsh-cost-meter 在场。
 * ============================================================================
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PriceSource,
  computeSavings,
  formatMoney,
  formatTokens,
  isDayKey,
  isPeakHourLike,
  localDayKey,
  pickWindow,
  readLedger,
  renderSavingsMarkdown,
  windowDayKeys,
} from './savings.js'

// ---------------------------------------------------------------------------
// 极简断言框架（不用任何测试库，与本插件既有风格一致）
// ---------------------------------------------------------------------------
let passed = 0
const failures = []

function ok(name, condition, detail) {
  if (condition) {
    passed += 1
    return true
  }
  failures.push(`${name}${detail === undefined ? '' : ` —— ${detail}`}`)
  return false
}

/** 浮点近似比较。 */
function near(a, b, eps = 1e-9) {
  return Math.abs(a - b) <= eps
}

function eq(name, actual, expected) {
  return ok(name, Object.is(actual, expected), `期望 ${String(expected)}，实际 ${String(actual)}`)
}

function close(name, actual, expected, eps = 1e-9) {
  return ok(name, near(Number(actual), Number(expected), eps), `期望 ≈${expected}，实际 ${actual}`)
}

/** 断言一个值既不是 NaN 也不是 Infinity。 */
function finite(name, value) {
  return ok(name, typeof value === 'number' && Number.isFinite(value), `得到 ${String(value)}`)
}

// ---------------------------------------------------------------------------
// 固定时区（本机 → 太平洋中途岛 UTC-11）：让「本地日 ≠ UTC 日」，
// 这样任何「拿 UTC 日当本地日」的实现都会被这组断言抓住。
// Windows 上 node 尊重 TZ 环境变量（26.x 实测有效）。
// ---------------------------------------------------------------------------
const TZ = 'Pacific/Midway'
process.env.TZ = TZ

const pad = (n) => String(n).padStart(2, '0')
const local = (y, m, d, hh = 0, mm = 0) => new Date(y, m - 1, d, hh, mm, 0, 0).getTime()

// ---------------------------------------------------------------------------
// 构造价表与账本（完全可控，不依赖任何外部数据）
// ---------------------------------------------------------------------------
/** 谷价/峰价故意取不同数字，任何「取错档」都会被金额断言抓住。 */
const PRICES = {
  models: {
    'deepseek-v4-flash': {
      cacheHit: 1, cacheMiss: 11, output: 31, cacheWrite: 1.5,
      offPeak: { cacheHit: 1, cacheMiss: 11, output: 31, cacheWrite: 1.5 },
      peak: { cacheHit: 2, cacheMiss: 22, output: 62, cacheWrite: 3 },
      rateHistory: [{ before: '2026-09-10T04:00:00Z', cacheHit: 7, cacheMiss: 21, output: 41 }],
    },
    'deepseek-v4-pro': {
      cacheHit: 3, cacheMiss: 15, output: 45,
      offPeak: { cacheHit: 3, cacheMiss: 15, output: 45 },
      peak: { cacheHit: 6, cacheMiss: 30, output: 90 },
    },
    'all-zero': { cacheHit: 0, cacheMiss: 0, output: 0 },
  },
  default: { cacheHit: 5, cacheMiss: 50, output: 100, offPeak: { cacheHit: 5, cacheMiss: 50, output: 100 }, peak: { cacheHit: 10, cacheMiss: 100, output: 200 } },
  providers: {
    'known-provider': { models: { 'provider-model': { cacheHit: 0.5, cacheMiss: 4.5, output: 9 } } },
  },
}

const CONFIG = {
  currency: 'CNY',
  symbol: '¥',
  decimals: 4,
  exchangeRate: 7.2,
  pricingCurrency: 'USD',
  peakEnabled: true,
  peakEffectiveAt: '2026-08-01T00:00:00Z',
  peakWindows: [{ start: 1, end: 4 }],
  // 故意留空：本套件的峰档算例落在 UTC 2026-09-15 01:00，
  // 若这里放假期就会把算例本身变成谷档（第 2 节另有专门的假期算例）。
  peakHolidays: [],
  prices: PRICES,
}

/** 造一个日桶。 */
function dayBucket(over = {}) {
  return {
    date: over.date ?? '',
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 1, cost: 0,
    byProviderModel: {},
    ...over,
  }
}

/** 造一个 provider:model 桶。 */
function modelBucket(over = {}) {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 1, cost: 0, ...over }
}

// ===========================================================================
console.log('== 1. 日期工具与窗口边界 ==')
// ===========================================================================
{
  const now = local(2026, 10, 11, 18, 0) // 本地周日
  eq('localDayKey 用本地日（不是 UTC 日）', localDayKey(now), '2026-10-11')
  eq('windowDayKeys(1) = [今日]', windowDayKeys(1, now).join(','), '2026-10-11')

  const w7 = windowDayKeys(7, now)
  eq('windowDayKeys(7) 长度', w7.length, 7)
  eq('windowDayKeys(7) 首日 = 今日-6', w7[0], '2026-10-05')
  eq('windowDayKeys(7) 末日 = 今日', w7[6], '2026-10-11')

  const w30 = windowDayKeys(30, now)
  eq('windowDayKeys(30) 长度', w30.length, 30)
  eq('windowDayKeys(30) 首日', w30[0], '2026-09-12')
  eq('windowDayKeys(30) 末日', w30[29], '2026-10-11')
  eq('windowDayKeys 升序且无重复', new Set(w30).size, 30)

  // 跨月：本地 10-01 往前 7 天要跨到 9 月。
  const crossMonth = windowDayKeys(7, local(2026, 10, 1, 0, 0))
  eq('跨月 7d 首日', crossMonth[0], '2026-09-25')
  eq('跨月 7d 末日', crossMonth[6], '2026-10-01')
  // 跨月（2 月，非闰年 2027）。
  const crossFeb = windowDayKeys(3, local(2027, 3, 1, 12, 0))
  eq('跨 2 月 3d', crossFeb.join(','), '2027-02-27,2027-02-28,2027-03-01')
  // 跨年。
  const crossYear = windowDayKeys(2, local(2027, 1, 1, 9, 0))
  eq('跨年 2d', crossYear.join(','), '2026-12-31,2027-01-01')
  // 本地日首尾（00:00 与 23:59）必须落在同一天。
  eq('本地 00:00 属于当天', localDayKey(local(2026, 10, 11, 0, 0)), '2026-10-11')
  eq('本地 23:59 属于当天', localDayKey(local(2026, 10, 11, 23, 59)), '2026-10-11')

  ok('isDayKey 接受规范键', isDayKey('2026-10-11') === true)
  ok('isDayKey 拒绝脏键', isDayKey('2026-1-1') === false && isDayKey('x') === false && isDayKey(20261011) === false)
}

// ===========================================================================
console.log('== 2. 峰谷判定（UTC 小时 / 周末 / 假期 / 生效时刻）==')
// ===========================================================================
{
  const peak = { enabled: true, effectiveAtMs: Date.parse('2026-08-01T00:00:00Z'), windows: [{ start: 1, end: 4 }], holidays: [] }

  // ⚠ 本文件设了 TZ=Pacific/Midway（UTC-11），所以**本地日 ≠ UTC 日**。
  // 下面每个断言都先说明该时刻换算到 UTC 是什么，避免「以为在测周末、其实落在工作日」。
  //
  // 本地 2026-09-14(周一) 14:00 → UTC 2026-09-15(周二) 01:00 ⇒ 落窗口 [1,4) ⇒ 峰。
  ok('峰：UTC 01:00 落在 [1,4)',
    isPeakHourLike(local(2026, 9, 14, 14, 0), peak) === true)
  // 本地 2026-09-14 09:00 → UTC 2026-09-14(周一) 20:00 ⇒ 窗口外 ⇒ 谷。
  ok('谷：UTC 20:00 不在窗口',
    isPeakHourLike(local(2026, 9, 14, 9, 0), peak) === false)
  // 本地 2026-09-13(周日) 12:00 → UTC 2026-09-13(周日) 23:00 ⇒ 周末 ⇒ 谷。
  ok('谷：UTC 周日恒谷',
    isPeakHourLike(local(2026, 9, 13, 12, 0), peak) === false)
  // 本地 2026-09-20(周日) 14:00 → UTC 2026-09-21 01:00（本可落窗口）⇒ 仍须是谷。
  ok('谷：UTC 周一但本地周日 —— 按 UTC 判定为峰（证明用的是 UTC 日）',
    isPeakHourLike(local(2026, 9, 20, 14, 0), peak) === true)
  // 假期表恒谷：本地 2026-09-15 14:00 → UTC 2026-09-16 01:00，本来落窗口；
  // 把假期表设成 UTC 键 '2026-09-16' 就能证明「假期优先于峰窗口」。
  const withHoliday = { ...peak, holidays: ['2026-09-16'] }
  ok('谷：假期表命中即恒谷',
    isPeakHourLike(local(2026, 9, 15, 14, 0), withHoliday) === false)
  ok('对照：次日同刻非假期则为峰',
    isPeakHourLike(local(2026, 9, 16, 14, 0), withHoliday) === true)
  // 生效时刻之前恒谷：把生效时刻挪到未来。
  const beforeEffective = { ...peak, effectiveAtMs: Date.parse('2027-01-01T00:00:00Z') }
  ok('谷：峰谷生效时刻之前', isPeakHourLike(local(2026, 9, 14, 14, 0), beforeEffective) === false)
  // 开关关闭恒谷。
  ok('谷：peakEnabled=false', isPeakHourLike(local(2026, 9, 14, 14, 0), { ...peak, enabled: false }) === false)
  // 边界：窗口 [1,4) —— UTC 01:00 是峰（左闭），UTC 04:00 是谷（右开）。
  // 本地 14:00 → UTC 01:00；本地 17:00 → UTC 04:00。
  ok('边界：UTC 01:00 为峰（左闭）', isPeakHourLike(local(2026, 9, 14, 14, 0), peak) === true)
  ok('边界：UTC 04:00 为谷（右开）', isPeakHourLike(local(2026, 9, 14, 17, 0), peak) === false)
}

// ===========================================================================
console.log('== 3. 金额公式（逐档精确）==')
// ===========================================================================
{
  // 本地 2026-09-14(周一) 14:00 → UTC 2026-09-15(周二) 01:00 ⇒ 峰档（02:00 也在窗口内）。
  const at = local(2026, 9, 14, 14, 0)
  ok('前置：该时刻确实是峰档', isPeakHourLike(at, { enabled: true, effectiveAtMs: Date.parse('2026-08-01T00:00:00Z'), windows: [{ start: 1, end: 4 }], holidays: [] }))
  const ledger = {
    config: CONFIG,
    days: {
      '2026-09-14': dayBucket({
        date: '2026-09-14',
        cacheRead: 1_000_000,
        output: 5_000_000,
        input: 2_000_000,
        byProviderModel: {
          'deepseek-official:deepseek-v4-flash': modelBucket({
            cacheRead: 1_000_000, output: 5_000_000, input: 2_000_000, cacheWrite: 0,
          }),
        },
      }),
    },
  }
  const save = await computeSavings({ ledger, nowMs: at })
  const w1 = pickWindow(save, 1)
  ok('窗口可用', save.available === true && w1 !== null)
  // 峰档：cacheMiss 22 − cacheHit 2 = 20 ⇒ 1e6 × 20 / 1e6 = 20 USD
  close('峰档节省 = 1e6 × (22−2)/1e6 = $20', w1.savingsUsd, 20)
  // 展示口径 decimals=4 ⇒ ¥144.0000
  close('展示金额 = 20 × 7.2 = ¥144', w1.savingsDisplay, 144)
  // 若把 output 也算进来，$20 会变成 $20 + 5e6×(62−62)/1e6（零）或按输出差价放大；
  // 这里用「严格等于 20」钉死「输出不参与节省」。
  close('输出 token 对节省零贡献（金额严格为 $20）', w1.savingsUsd, 20, 1e-12)
  eq('cacheRead 计数正确', w1.cacheRead, 1_000_000)
  eq('promptTokens = input + write + read', w1.promptTokens, 3_000_000)
  eq('outputTokens 照常上报', w1.outputTokens, 5_000_000)

  // 同一份账本，把时刻挪到谷档（本地 09:00 → UTC 20:00）。
  const atOff = local(2026, 9, 14, 9, 0)
  const off = await computeSavings({ ledger, nowMs: atOff })
  const w1off = pickWindow(off, 1)
  // 谷档：11 − 1 = 10 ⇒ $10
  close('谷档节省 = 1e6 × (11−1)/1e6 = $10', w1off.savingsUsd, 10)
  ok('峰谷确实取到了不同档', w1.savingsUsd > w1off.savingsUsd)
}

// ===========================================================================
console.log('== 4. cacheWrite 不单独计；未定价必须排除 ==')
// ===========================================================================
{
  const at = local(2026, 9, 14, 9, 0) // UTC 20:00 ⇒ 谷档：flash hit 1 / miss 11
  const ledger = {
    config: CONFIG,
    days: {
      '2026-09-14': dayBucket({
        date: '2026-09-14',
        byProviderModel: {
          // cacheWrite 2e6，但价表没有独立写价档 ⇒ 写不产生额外节省。
          'deepseek-official:deepseek-v4-flash': modelBucket({ cacheRead: 1_000_000, cacheWrite: 2_000_000, output: 1_000_000 }),
          // provider 被 providers 表认识、模型无价 ⇒ 必须排除（绝不套 default）。
          'known-provider:not-a-model': modelBucket({ cacheRead: 9_000_000 }),
          // 精确命中 models 但三档全零 ⇒ 上游语义是「priced=true、用这个零价条目」
          //   ⇒ 保留在 pricedBuckets 里，但金额贡献为 0（不虚报，也不误报为未定价）。
          'deepseek-official:all-zero': modelBucket({ cacheRead: 8_000_000 }),
          // provider 不在 providers 表里 ⇒ 上游语义是「未定价」，绝不套 default。
          'mystery-gateway:whatever': modelBucket({ cacheRead: 1_000_000 }),
        },
      }),
    },
  }
  const save = await computeSavings({ ledger, nowMs: at })
  const w1 = pickWindow(save, 1)
  // flash 谷档: 1e6 × (11−1)/1e6 = $10。
  // 全零条目：1e6 × (0−0)/1e6 = $0（在 pricedBuckets 内，但不加钱）。
  // 未定价两项（known-provider 不认识模型 / mystery-gateway 不认识 provider）都不加钱。
  close('cacheWrite 不单独计 + 全零条目不加钱 + 未定价两项排除', w1.savingsUsd, 10)
  eq('cacheRead 全额统计（未定价与全零也计入 token 口径）', w1.cacheRead, 1_000_000 + 9_000_000 + 8_000_000 + 1_000_000)
  eq('未定价两项都被上报', w1.unpricedModels.join(','), 'known-provider:not-a-model,mystery-gateway:whatever')
  eq('未定价 token 被上报', w1.unpricedCacheRead, 10_000_000)
  eq('已定价桶数 = 2（flash + 全零条目）', w1.pricedBuckets, 2)
  // 覆盖率的分子含全零条目（它被计入 pricedKnownTokens），分母是全部 token。
  close('定价覆盖率 = 已定价 token / 全部 token', w1.pricedCoverage, (1_000_000 + 2_000_000 + 8_000_000) / (1_000_000 + 2_000_000 + 9_000_000 + 8_000_000 + 1_000_000))
  finite('金额是有限数', w1.savingsUsd)
}

// ===========================================================================
console.log('== 5. provider 级价表优先于 default ==')
// ===========================================================================
{
  const at = local(2026, 9, 14, 9, 0)
  const ledger = {
    config: CONFIG,
    days: {
      '2026-09-14': dayBucket({
        date: '2026-09-14',
        byProviderModel: {
          'known-provider:provider-model': modelBucket({ cacheRead: 1_000_000 }), // 4.5 − 0.5 = 4 ⇒ $4
        },
      }),
    },
  }
  const ps = new PriceSource(ledger)
  const resolved = ps.entryFor('known-provider:provider-model', at)
  ok('provider 级条目被解析为已定价', resolved.priced === true)
  eq('provider 级条目 identity 正确', resolved.tier.cacheMiss, 4.5)
  eq('不是 default 回落', resolved.isFallback, false)

  const save = await computeSavings({ ledger, nowMs: at })
  close('provider 级价表的金额 = $4', pickWindow(save, 1).savingsUsd, 4)
}

// ===========================================================================
console.log('== 6. rateHistory 的 before 边界 ==')
// ===========================================================================
{
  // rateHistory 条目：2026-09-10T04:00:00Z 之前用 7/21（差分 14）。
  // 本地 09-09 12:00 → UTC 09-09 23:00 < 边界 ⇒ 用 rateHistory。
  const atHist = local(2026, 9, 9, 12, 0)
  // 本地 09-13 12:00 → UTC 09-13 23:00 > 边界，且是周日（谷）⇒ 用 offPeak 差分 10。
  const atBase = local(2026, 9, 13, 12, 0)
  const makeLedger = () => ({
    config: CONFIG,
    days: {
      '2026-09-09': dayBucket({
        date: '2026-09-09',
        byProviderModel: { 'deepseek-official:deepseek-v4-flash': modelBucket({ cacheRead: 1_000_000 }) },
      }),
      '2026-09-13': dayBucket({
        date: '2026-09-13',
        byProviderModel: { 'deepseek-official:deepseek-v4-flash': modelBucket({ cacheRead: 1_000_000 }) },
      }),
    },
  })
  const ledger = makeLedger()
  const a = await computeSavings({ ledger, nowMs: atHist })
  const b = await computeSavings({ ledger, nowMs: atBase })
  close('rateHistory 生效前用历史费率（21−7=14 ⇒ $14）', pickWindow(a, 1).savingsUsd, 14)
  close('rateHistory 失效后用 offPeak（11−1=10 ⇒ $10）', pickWindow(b, 1).savingsUsd, 10)
}

// ===========================================================================
console.log('== 6b. 假期表让峰档退回谷价（端到端）==')
// ===========================================================================
{
  // 本地 2026-09-15 14:00 → UTC 2026-09-16 01:00：本来落峰窗口。
  const atHoliday = local(2026, 9, 15, 14, 0)
  // 本地 2026-09-16 14:00 → UTC 2026-09-17 01:00：同一相位但不是假期。
  const atNormal = local(2026, 9, 16, 14, 0)
  const mk = (holidays) => ({
    config: { ...CONFIG, peakHolidays: holidays },
    days: {
      '2026-09-15': dayBucket({
        date: '2026-09-15',
        byProviderModel: { 'deepseek-official:deepseek-v4-flash': modelBucket({ cacheRead: 1_000_000 }) },
      }),
      '2026-09-16': dayBucket({
        date: '2026-09-16',
        byProviderModel: { 'deepseek-official:deepseek-v4-flash': modelBucket({ cacheRead: 1_000_000 }) },
      }),
    },
  })
  const noHoliday = await computeSavings({ ledger: mk([]), nowMs: atHoliday })
  const withHoliday = await computeSavings({ ledger: mk(['2026-09-16']), nowMs: atHoliday })
  const control = await computeSavings({ ledger: mk(['2026-09-16']), nowMs: atNormal })
  close('无假期表时为峰档 ⇒ $20', pickWindow(noHoliday, 1).savingsUsd, 20)
  close('假期表命中 ⇒ 退回谷价 $10', pickWindow(withHoliday, 1).savingsUsd, 10)
  close('对照：次日非假期 ⇒ 仍是峰档 $20', pickWindow(control, 1).savingsUsd, 20)
}

// ===========================================================================
console.log('== 7. 会话桶优先 / 缺 sessions 回落日桶 ==')
// ===========================================================================
{
  const at = local(2026, 9, 14, 9, 0) // 谷档（UTC 20:00）
  // 会话 A 落在谷档（本地 09:00 → UTC 20:00），
  // 会话 B 落在峰档（本地 14:00 → UTC 次日 01:00）。
  const sessionAAt = local(2026, 9, 14, 9, 0)
  const sessionBAt = local(2026, 9, 14, 14, 0)
  ok('前置：A 为谷档', isPeakHourLike(sessionAAt, { enabled: true, effectiveAtMs: Date.parse('2026-08-01T00:00:00Z'), windows: [{ start: 1, end: 4 }], holidays: [] }) === false)
  ok('前置：B 为峰档', isPeakHourLike(sessionBAt, { enabled: true, effectiveAtMs: Date.parse('2026-08-01T00:00:00Z'), windows: [{ start: 1, end: 4 }], holidays: [] }) === true)

  const ledger = {
    config: CONFIG,
    days: {
      '2026-09-14': dayBucket({
        date: '2026-09-14',
        // 日桶故意写一个会算错的读数，用来证明「会话桶优先」而不是「日桶」。
        byProviderModel: { 'deepseek-official:deepseek-v4-flash': modelBucket({ cacheRead: 999_000_000 }) },
        sessions: [
          {
            id: 'session-a', at: sessionAAt,
            byProviderModel: { 'deepseek-official:deepseek-v4-flash': modelBucket({ cacheRead: 1_000_000 }) },
          },
          {
            id: 'session-b', at: sessionBAt,
            byProviderModel: { 'deepseek-official:deepseek-v4-flash': modelBucket({ cacheRead: 1_000_000 }) },
          },
        ],
      }),
    },
  }
  const save = await computeSavings({ ledger, nowMs: at })
  const w1 = pickWindow(save, 1)
  // A 谷档 $10 + B 峰档 $20 = $30；日桶的 999e6 必须被忽略。
  close('会话桶优先：$10（谷）+ $20（峰）= $30', w1.savingsUsd, 30)
  eq('cacheRead 来自会话桶（不是日桶）', w1.cacheRead, 2_000_000)
  eq('会话数被统计', w1.sessions, 2)
  eq('无日级回落', w1.dayFallbackDays, 0)
  eq('perDay 标 session 粒度', w1.perDay[0].granularity, 'session')

  // 去掉 sessions ⇒ 回落日桶，并如实标注。
  const noSessions = {
    config: CONFIG,
    days: {
      '2026-09-14': dayBucket({
        date: '2026-09-14',
        byProviderModel: { 'deepseek-official:deepseek-v4-flash': modelBucket({ cacheRead: 1_000_000 }) },
      }),
    },
  }
  const fallback = await computeSavings({ ledger: noSessions, nowMs: at })
  const wf = pickWindow(fallback, 1)
  eq('缺 sessions 时标 day 粒度', wf.perDay[0].granularity, 'day')
  eq('日级回落天数被上报', wf.dayFallbackDays, 1)
  close('日级回落金额 = $10', wf.savingsUsd, 10)
}

// ===========================================================================
console.log('== 8. 模型名归一化（真实账本里的脏拼写）==')
// ===========================================================================
{
  const at = local(2026, 9, 14, 9, 0)
  const keys = [
    'deepseek:deepseek-v4-flash',
    'deepseek: deepseek-v4-flash',
    'deepseek:DeepSeek-V4-Flash',
    'deepseek:Deepseek-V4-Flash',
  ]
  const buckets = {}
  for (const k of keys) buckets[k] = modelBucket({ cacheRead: 1_000_000 })
  const ledger = { config: CONFIG, days: { '2026-09-14': dayBucket({ date: '2026-09-14', byProviderModel: buckets }) } }
  const save = await computeSavings({ ledger, nowMs: at })
  const w1 = pickWindow(save, 1)
  eq('四种拼写都算出金额（不拆行、不漏价）', w1.pricedBuckets, keys.length)
  close('四种拼写金额一致：4 × $10 = $40', w1.savingsUsd, 40)
  eq('没有未定价上报', w1.unpricedModels.length, 0)
}

// ===========================================================================
console.log('== 9. 退化输入：绝不 NaN / Infinity / 抛错 ==')
// ===========================================================================
{
  const at = local(2026, 9, 14, 9, 0)

  // (a) 账本缺失
  const missing = await computeSavings({ ledger: null, nowMs: at })
  eq('账本缺失 → available=false', missing.available, false)
  eq('账本缺失 → 原因', missing.reason, 'ledger-missing')
  eq('账本缺失 → 窗口为空', Array.isArray(missing.windows) && missing.windows.length === 0, true)
  ok('账本缺失 → 渲染不抛错', typeof renderSavingsMarkdown(missing) === 'string')

  // (b) 空 days
  const empty = await computeSavings({ ledger: { config: CONFIG, days: {} }, nowMs: at })
  ok('空账本 → 窗口存在但金额为 0', empty.windows.length === 3 && empty.windows.every((w) => w.savingsUsd === 0))
  ok('空账本 → 不 NaN', empty.windows.every((w) => Number.isFinite(w.savingsUsd) && Number.isFinite(w.savingsDisplay)))
  eq('空账本 → 覆盖率是 null（不是 NaN）', empty.windows[0].pricedCoverage, null)
  eq('空账本 → available=false（没有用量）', empty.available, false)

  // (c) 脏数值：负数 / 字符串 / NaN / Infinity / null
  const dirty = {
    config: CONFIG,
    days: {
      '2026-09-14': dayBucket({
        date: '2026-09-14',
        byProviderModel: {
          'deepseek-official:deepseek-v4-flash': modelBucket({
            cacheRead: 'abc', input: null, output: Number.NaN, cacheWrite: -5,
          }),
          'deepseek-official:deepseek-v4-pro': modelBucket({
            cacheRead: Number.POSITIVE_INFINITY, input: -1, output: '12',
          }),
        },
      }),
    },
  }
  const dirtySave = await computeSavings({ ledger: dirty, nowMs: at })
  const wd = pickWindow(dirtySave, 1)
  finite('脏数值 → 金额有限', wd.savingsUsd)
  finite('脏数值 → cacheRead 有限', wd.cacheRead)
  finite('脏数值 → promptTokens 有限', wd.promptTokens)
  eq('脏 cacheRead 一律当 0', wd.cacheRead, 0)

  // (d) config 完全没有
  const noConfig = { days: { '2026-09-14': dayBucket({ date: '2026-09-14' }) } }
  const nc = await computeSavings({ ledger: noConfig, nowMs: at })
  ok('config 缺失 → 不抛错且金额 0', nc.windows.length === 3 && nc.windows.every((w) => w.savingsUsd === 0))
  ok('config 缺失 → 展示口径回落到默认 CNY/¥', nc.display.symbol === '¥' && nc.display.currency === 'CNY')
  finite('config 缺失 → 展示金额有限', nc.windows[0].savingsDisplay)

  // (e) prices 缺失
  const noPrices = { config: { ...CONFIG, prices: undefined }, days: { '2026-09-14': dayBucket({ date: '2026-09-14', byProviderModel: { 'a:b': modelBucket({ cacheRead: 1e6 }) } }) } }
  const np = await computeSavings({ ledger: noPrices, nowMs: at })
  eq('价表缺失 → available=false', np.available, false)
  eq('价表缺失 → 原因', np.reason, 'price-table-missing')
  eq('价表缺失 → 金额 0（不虚报）', np.windows[0].savingsUsd, 0)
  ok('价表缺失 → 该桶被上报为未定价', np.windows[0].unpricedModels.includes('a:b'))

  // (f) 只有窗口外的数据 ⇒ 金额 0
  const outside = {
    config: CONFIG,
    days: { '2026-01-01': dayBucket({ date: '2026-01-01', byProviderModel: { 'deepseek-official:deepseek-v4-flash': modelBucket({ cacheRead: 1e9 }) } }) },
  }
  const out = await computeSavings({ ledger: outside, nowMs: at })
  eq('窗口外数据不计入', pickWindow(out, 1).savingsUsd, 0)
  eq('窗口外数据 presentDays = 0', pickWindow(out, 1).presentDays, 0)

  // (g) 除零：全零账本下 coverge/hitRate 类比值不得是 NaN
  ok('除零不产生 NaN', out.windows.every((w) => w.pricedCoverage === null || Number.isFinite(w.pricedCoverage)))
}

// ===========================================================================
console.log('== 10. 多窗口聚合与去重 ==')
// ===========================================================================
{
  const at = local(2026, 10, 11, 18, 0)
  const days = {}
  // 造 40 天数据，每天 1 个桶，cacheRead 1e6，谷档差分 10 ⇒ 每天 $10。
  for (let i = 0; i < 40; i++) {
    const d = new Date(2026, 9, 11 - i)
    const key = localDayKey(d.getTime())
    days[key] = dayBucket({
      date: key,
      byProviderModel: { 'deepseek-official:deepseek-v4-flash': modelBucket({ cacheRead: 1_000_000 }) },
      sessions: [{
        id: `s-${key}`, at: d.getTime(),
        byProviderModel: { 'deepseek-official:deepseek-v4-flash': modelBucket({ cacheRead: 1_000_000 }) },
      }],
    })
  }
  const save = await computeSavings({ ledger: { config: CONFIG, days }, nowMs: at })
  const w1 = pickWindow(save, 1)
  const w7 = pickWindow(save, 7)
  const w30 = pickWindow(save, 30)
  eq('三个窗口都在', [w1, w7, w30].every((w) => w !== null), true)
  eq('1d 天数', w1.presentDays, 1)
  eq('7d 天数', w7.presentDays, 7)
  eq('30d 天数', w30.presentDays, 30)
  eq('30d 天数不超过窗口（40 天数据只取 30 天）', w30.days.length, 30)
  eq('7d cacheRead', w7.cacheRead, 7_000_000)
  eq('30d cacheRead', w30.cacheRead, 30_000_000)
  // 注意：10-11 本地日，历史日按**该日本地日末**取档，可能是周末（谷）或工作日峰谷不定，
  // 所以金额只断言「正数且随窗口单调增加」，不敢写死未核实的档位。
  ok('金额随窗口单调不减', w1.savingsUsd <= w7.savingsUsd && w7.savingsUsd <= w30.savingsUsd)
  ok('金额为正', w30.savingsUsd > 0)
  const sumDays = w7.perDay.reduce((acc, d) => acc + d.savingsUsd, 0)
  close('7d 金额 = 其 perDay 之和', w7.savingsUsd, sumDays)
  eq('未定价模型跨窗口去重', save.unpricedModels.length, 0)
}

// ===========================================================================
console.log('== 11. 渲染工具 ==')
// ===========================================================================
{
  eq('formatMoney 用配置精度', formatMoney(1234.5678, { symbol: '¥', decimals: 4 }), '¥1234.5678')
  eq('formatMoney 处理 NaN', formatMoney(Number.NaN, { symbol: '¥', decimals: 2 }), '¥0.00')
  eq('formatMoney 处理 undefined', formatMoney(undefined, { symbol: '$', decimals: 0 }), '$0')
  eq('formatMoney 处理 null display', formatMoney(5, null), '¥5.00')
  eq('formatTokens 千分位', formatTokens(1706714368), '1,706,714,368')
  eq('formatTokens 处理 NaN', formatTokens(Number.NaN), '0')

  const at = local(2026, 9, 14, 9, 0)
  const ledger = {
    config: CONFIG,
    days: { '2026-09-14': dayBucket({ date: '2026-09-14', byProviderModel: { 'deepseek-official:deepseek-v4-flash': modelBucket({ cacheRead: 1_000_000 }) } }) },
  }
  const save = await computeSavings({ ledger, nowMs: at })
  const md = renderSavingsMarkdown(save)
  ok('markdown 含标题', md.includes('## 省下的钱'))
  ok('markdown 含今日/7 天/30 天三行', md.includes('今日') && md.includes('近 7 天') && md.includes('近 30 天'))
  ok('markdown 含公式说明', md.includes('缓存读 token × (未命中价 − 命中价)'))
  ok('markdown 不含 NaN', !md.includes('NaN') && !md.includes('Infinity') && !md.includes('undefined'))

  // 降级路径也必须能渲染。
  const mdMissing = renderSavingsMarkdown(await computeSavings({ ledger: null, nowMs: at }))
  ok('不可用时的 markdown 也不含 NaN', !mdMissing.includes('NaN') && mdMissing.includes('—'))
}

// ===========================================================================
console.log('== 12. 账本读取与缓存（真实文件路径）==')
// ===========================================================================
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cache-tuner-verify-'))
  const previousHome = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = dir
    const file = join(dir, 'storages', 'cost-meter', 'ledger.json')
    mkdirSync(join(dir, 'storages', 'cost-meter'), { recursive: true })

    // (a) 文件不存在 ⇒ null，不抛错
    eq('账本不存在 → null', readLedger(Date.now()), null)

    // (b) 正常读取
    const payload = { config: CONFIG, days: { '2026-09-14': dayBucket({ date: '2026-09-14' }) } }
    writeFileSync(file, JSON.stringify(payload), 'utf8')
    const first = readLedger(Date.now())
    ok('账本能被读取', first !== null && first.config.currency === 'CNY')

    // (c) 内容变了但 mtime/size 相同（用同长度不同内容）⇒ 命中缓存
    const same = { config: { ...CONFIG, currency: 'USD' }, days: {} }
    const json = JSON.stringify(same)
    const padded = json.length === JSON.stringify(payload).length ? json : JSON.stringify({ ...same, pad: 'x'.repeat(0) })
    if (padded.length === JSON.stringify(payload).length) {
      writeFileSync(file, padded, 'utf8')
      const cached = readLedger(Date.now())
      eq('文件未变（mtime/size 同）时命中缓存', cached.config.currency, 'CNY')
    }

    // (d) 坏 JSON ⇒ null，不抛错
    writeFileSync(file, '{ not json', 'utf8')
    eq('坏 JSON → null', readLedger(Date.now()), null)

    // (e) 路径来自 DSH_HOME
    const viaCompute = await computeSavings({ nowMs: Date.now() })
    eq('computeSavings 在无账本时降级', viaCompute.available, false)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不影响判定 */ }
  }
}

// ===========================================================================
console.log('== 13. 展示口径（币种 / 汇率 / 精度）==')
// ===========================================================================
{
  const at = local(2026, 9, 14, 9, 0)
  const build = (over) => ({
    config: { ...CONFIG, ...over },
    days: { '2026-09-14': dayBucket({ date: '2026-09-14', byProviderModel: { 'deepseek-official:deepseek-v4-flash': modelBucket({ cacheRead: 1_000_000 }) } }) },
  })

  const usdOnly = await computeSavings({ ledger: build({ exchangeRate: 1, currency: 'USD', symbol: '$' }), nowMs: at })
  close('汇率 1 时展示金额 = USD 金额', pickWindow(usdOnly, 1).savingsDisplay, pickWindow(usdOnly, 1).savingsUsd)

  const badRate = await computeSavings({ ledger: build({ exchangeRate: 0 }), nowMs: at })
  eq('汇率 0 → 回落为 1（不把金额清零）', badRate.display.exchangeRate, 1)

  const badRate2 = await computeSavings({ ledger: build({ exchangeRate: 'x' }), nowMs: at })
  eq('汇率非法 → 回落为 1', badRate2.display.exchangeRate, 1)

  const badDecimals = await computeSavings({ ledger: build({ decimals: 99 }), nowMs: at })
  eq('精度越界 → 夹到 8', badDecimals.display.decimals, 8)
  const negDecimals = await computeSavings({ ledger: build({ decimals: -3 }), nowMs: at })
  eq('精度为负 → 夹到 0', negDecimals.display.decimals, 0)

  // 展示币种以 config 为准（prices.currency 是 undefined，绝不能去读它）。
  const ledgerWithPriceCurrency = build({})
  ledgerWithPriceCurrency.config.prices = { ...PRICES, currency: 'USD' }
  const pc = await computeSavings({ ledger: ledgerWithPriceCurrency, nowMs: at })
  eq('展示币种读 config.currency（不读 prices.currency）', pc.display.currency, 'CNY')
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
console.log('')
if (failures.length === 0) {
  console.log(`✅ verify-savings: 全部通过（${passed} 条断言）`)
  process.exit(0)
}
console.log(`❌ verify-savings: ${failures.length} 条失败 / 共 ${passed + failures.length} 条`)
for (const item of failures) console.log(`   - ${item}`)
process.exit(1)
