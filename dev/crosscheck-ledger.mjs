/**
 * 交叉验证：本插件的金额引擎 vs 用 cost-meter 计价函数做的独立复算。
 *
 * 为什么要这个脚本：
 *   `lib/verify-savings.mjs` 只验证「引擎自身口径自洽」（用合成价表）。
 *   但引擎还必须与**账本真实计价**一致 —— 否则我们算的钱和账单对不上。
 *   这个脚本就做这件事：读同一份真实账本，两条独立路径各算一遍，比对到 1e-6。
 *
 * 依赖（缺任何一个都会明确报错退出）：
 *   - cost-meter 账本：$DSH_HOME/storages/cost-meter/ledger.json
 *   - cost-meter 计价模块：<profile>/node_modules/dsh-cost-meter/lib/pricing.js
 *
 * 用法：
 *   node dev/crosscheck-ledger.mjs
 *   DSH_HOME=/path/to/.dsh DSH_PROFILE_DIR=/path/to/profile node dev/crosscheck-ledger.mjs
 *
 * ⚠ 这是开发期工具，不是产品代码；它读取的是你本机的真实账本（只读）。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as S from '../lib/savings.js'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const PROFILE_DIR = process.env.DSH_PROFILE_DIR ?? join(DSH_HOME, 'profiles', 'desktop')
const LEDGER = join(DSH_HOME, 'storages', 'cost-meter', 'ledger.json')
const PRICING = join(PROFILE_DIR, 'node_modules', 'dsh-cost-meter', 'lib', 'pricing.js')

let P
try {
  P = await import(pathToFileURL(PRICING).href)
} catch (error) {
  console.error(`✗ 载入 cost-meter 计价模块失败：${PRICING}`)
  console.error(`  ${String(error?.message ?? error)}`)
  console.error('  提示：设 DSH_PROFILE_DIR 指向装了 dsh-cost-meter 的 profile。')
  process.exit(1)
}

let L
try {
  L = JSON.parse(readFileSync(LEDGER, 'utf8'))
} catch (error) {
  console.error(`✗ 读取账本失败：${LEDGER}`)
  console.error(`  ${String(error?.message ?? error)}`)
  process.exit(1)
}

const cfg = L.config
const nowMs = Date.now()
const today = S.localDayKey(nowMs)
const dayEnd = (k) => {
  const [y, m, d] = k.split('-').map(Number)
  return new Date(y, m - 1, d, 23, 59, 59, 999).getTime()
}
const peak = {
  enabled: cfg.peakEnabled === true,
  effectiveAtMs: Date.parse(cfg.peakEffectiveAt),
  windows: cfg.peakWindows,
  holidays: cfg.peakHolidays,
}

/** 独立复算：完全走 cost-meter 的 providerPriceEntryFor + tierFor。 */
function independent(n) {
  let usd = 0, cacheRead = 0, unpriced = 0, seen = 0, pricedTok = 0
  const unpricedModels = new Set()
  for (const date of S.windowDayKeys(n, nowMs)) {
    const day = L.days?.[date]
    if (!day) continue
    const at = date === today ? nowMs : dayEnd(date)
    const buckets = []
    const sessions = Array.isArray(day.sessions) ? day.sessions : []
    if (sessions.length > 0) {
      for (const s of sessions) {
        const sat = Number.isFinite(Number(s.at)) && Number(s.at) > 0 ? Number(s.at) : at
        for (const [k, b] of Object.entries(s.byProviderModel ?? {})) buckets.push([k, b, sat])
      }
    } else {
      for (const [k, b] of Object.entries(day.byProviderModel ?? {})) buckets.push([k, b, at])
    }
    for (const [k, b, bat] of buckets) {
      const i = k.indexOf(':')
      const provider = i < 0 ? '' : k.slice(0, i)
      const model = i < 0 ? k : k.slice(i + 1)
      const r = P.providerPriceEntryFor(provider, model, cfg.prices)
      const read = Number(b.cacheRead) || 0
      seen += read + (Number(b.input) || 0) + (Number(b.cacheWrite) || 0)
      cacheRead += read
      if (r === null || r === undefined || r.priced !== true) {
        unpriced += read
        unpricedModels.add(k)
        continue
      }
      pricedTok += read + (Number(b.input) || 0) + (Number(b.cacheWrite) || 0)
      const tier = P.tierFor(P.normalizePrice(r.entry), bat, peak)
      usd += read * Math.max(0, tier.cacheMiss - tier.cacheHit) / 1e6
    }
  }
  return { usd, cacheRead, unpriced, coverage: seen > 0 ? pricedTok / seen : null, unpricedModels: [...unpricedModels].sort() }
}

console.log('=== 基线 ===')
console.log('now local =', new Date(nowMs).toString(), '| today =', today)
console.log('ledger    =', LEDGER)
console.log('days last =', Object.keys(L.days).sort().at(-1), '| count', Object.keys(L.days).length)

console.log('\n=== A. 插件 computeSavings ===')
const save = await S.computeSavings({ nowMs })
console.log('available =', save.available, '| source =', save.source)
console.log('display   =', JSON.stringify(save.display))
for (const w of save.windows) {
  console.log(`[${w.window}d] ${w.from}..${w.to} present=${w.presentDays} cacheRead=${w.cacheRead} USD=${w.savingsUsd.toFixed(6)} ${save.display.symbol}${w.savingsDisplay.toFixed(4)} coverage=${w.pricedCoverage === null ? 'null' : (w.pricedCoverage * 100).toFixed(2) + '%'}`)
}

console.log('\n=== B. 独立复算（cost-meter pricing.js + tierFor）===')
for (const n of [1, 7, 30]) {
  const r = independent(n)
  console.log(`[${n}d] cacheRead=${r.cacheRead} USD=${r.usd.toFixed(6)} CNY=¥${(r.usd * cfg.exchangeRate).toFixed(4)} coverage=${r.coverage === null ? 'null' : (r.coverage * 100).toFixed(2) + '%'} unpriced=${r.unpriced}`)
}

console.log('\n=== C. 一致性判定（相对误差 < 1e-6 为通过）===')
let allOk = true
for (const n of [1, 7, 30]) {
  const a = save.windows.find((w) => w.window === n)
  const b = independent(n)
  const rel = Math.abs(a.savingsUsd - b.usd) / (b.usd || 1)
  const readOk = a.cacheRead === b.cacheRead
  const covOk = (a.pricedCoverage === null && b.coverage === null)
    || Math.abs((a.pricedCoverage ?? 0) - (b.coverage ?? 0)) < 1e-9
  const ok = rel < 1e-6 && readOk && covOk
  if (!ok) allOk = false
  console.log(`[${n}d] plugin=$${a.savingsUsd.toFixed(9)} independent=$${b.usd.toFixed(9)} rel=${rel.toExponential(2)} cacheReadMatch=${readOk} coverageMatch=${covOk} => ${ok ? 'PASS' : 'FAIL'}`)
  if (!ok && a.unpricedModels.join() !== b.unpricedModels.join()) {
    console.log(`      plugin unpriced : ${a.unpricedModels.join(', ') || '(none)'}`)
    console.log(`      independent     : ${b.unpricedModels.join(', ') || '(none)'}`)
  }
}
console.log(allOk ? '\n✅ ALL CONSISTENT' : '\n❌ MISMATCH')
process.exit(allOk ? 0 : 1)
