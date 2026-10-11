/**
 * ============================================================================
 * dsh-cache-tuner —— 节省金额引擎（savings.js）
 * ============================================================================
 *
 * 【这个文件解决什么问题】
 *   前面的 model.js 只回答「命中率是多少、是谁把前缀弄断了」，全部是 token 口径。
 *   但用户真正想知道的是**钱**：今天靠缓存省了多少、7 天省了多少、30 天省了多少。
 *   本文件补上这一层：把历史 token 用量按**实时单价**折成金额。
 *
 * 【钱是怎么省出来的（唯一公式）】
 *   同 1 个输入 token，走缓存和不走缓存是**两个价**：
 *       cacheHit  （命中缓存，最便宜）
 *       cacheMiss （没命中，现算，最贵）
 *   所以：
 *       节省(USD) = Σ 各桶 cacheReadTokens × (cacheMiss − cacheHit) / 1e6
 *   直觉：这些 token 本来要按 cacheMiss 全价买，实际只按 cacheHit 付了。
 *
 *   ⚠ 两个刻意的口径决定（都写在 README 里）：
 *   1. **output token 不算节省**：缓存只作用于输入侧，输出侧没有折扣，
 *      把它算进来是虚报。
 *   2. **cacheWrite 不单独计**：DeepSeek 的价表没有独立的 cacheWrite 档，
 *      计价函数回落到 cacheHit 价，所以「写缓存」相对全价没有额外折扣可算。
 *      只有开放式 provider（例如 openai）给了 cacheWrite 档才需要区别对待。
 *
 * 【价格从哪来（优先级）】
 *   1. **profile 里安装的 dsh-cost-meter/lib/pricing.js** —— 权威价表，
 *      带 provider 级价格与 sourceUrl/checkedAt 溯源信息。用 file URL 动态 import，
 *      失败**不报错**，静默降级到第 2 级。
 *   2. **cost-meter 账本 ledger.json 里的 config.prices** —— 同一套价表的快照，
 *      永远可用（账本是本机的真实计费来源）。
 *   两者都拿不到 → `available: false`，界面显示「—」，绝不显示 NaN。
 *
 * 【用量从哪来】
 *   cost-meter 的账本 ledger.json 的 `days` 字段：
 *       days["2026-10-11"] = { date, input, output, cacheRead, ..., cost,
 *                              byProviderModel: { "provider:model": {…} },
 *                              sessions: [ { id, at, byProviderModel: {…} }, … ] }
 *   优先级：`days[d].sessions[].byProviderModel`（会话×日粒度）
 *   → 回落到 `days[d].byProviderModel`（日粒度，标 granularity: 'day'）。
 *
 *   为什么优先会话桶：账本的最小粒度就是「会话×日」，没有逐次调用时间戳。
 *   峰谷价依赖**调用发生的时刻**，所以只要一个会话里跨了峰谷边界，
 *   按「当天取一个时刻」整日套同一档就会有系统性偏差。按每个会话自己的
 *   `at` 取档能把这份偏差压掉。日桶是兜底，此时报 `granularity: 'day'`
 *   让上层如实告知用户。
 *
 * 【只依赖 node 内建模块 + 一个可选的第三方价表】
 *   - 不 import 任何 `@deepseek-ai/*`（与插件既有边界纪律一致）。
 *   - `dsh-cost-meter` 走**绝对文件路径**动态 import，不是包名解析，
 *     所以缺包时只是一次失败的 import，不会让插件起不来。
 * ============================================================================
 */
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 账本缓存：避免每次 HTTP 请求都重新解析 500 KB JSON。 */
const LEDGER_CACHE_MS = 5000

/** 窗口定义：1 天（今日）/ 7 天 / 30 天，均为**含今日**的日历窗口。 */
export const SAVINGS_WINDOWS = Object.freeze([1, 7, 30])

// ---------------------------------------------------------------------------
// 基础路径与安全读取
// ---------------------------------------------------------------------------

/** $DSH_HOME（缺省 ~/.dsh）。 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv : join(homedir(), '.dsh')
}

/** cost-meter 账本路径。 */
export function ledgerPath() {
  return join(dshHome(), 'storages', 'cost-meter', 'ledger.json')
}

/**
 * 定位 profile 里安装的 dsh-cost-meter 价表文件。
 * 依次尝试：DSH_PROFILE_DIR → profiles/desktop → node_modules/dsh-cost-meter/lib/pricing.js。
 * 全部不存在时返回 ''（调用方降级，不抛错）。
 */
export function profilePricingPath() {
  const candidates = []
  const profileDir = process.env.DSH_PROFILE_DIR
  if (typeof profileDir === 'string' && profileDir.trim() !== '') {
    candidates.push(join(profileDir, 'node_modules', 'dsh-cost-meter', 'lib', 'pricing.js'))
  }
  candidates.push(join(dshHome(), 'profiles', 'desktop', 'node_modules', 'dsh-cost-meter', 'lib', 'pricing.js'))
  candidates.push(join(dshHome(), 'profiles', 'web', 'node_modules', 'dsh-cost-meter', 'lib', 'pricing.js'))
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch { /* 继续试下一个 */ }
  }
  return ''
}

// ---------------------------------------------------------------------------
// 数值与档位
// ---------------------------------------------------------------------------

/** 收敛成非负有限数；NaN / Infinity / 负数 / 非数字一律 0。 */
function num(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n
}

/** 把 'YYYY-MM-DD' 的本地日末（23:59:59.999）转成毫秒。 */
function dayEndMs(key) {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d, 23, 59, 59, 999).getTime()
}

/** 毫秒 → 宿主**本地**日历日键 'YYYY-MM-DD'（与 cost-meter store.js 同一口径）。 */
export function localDayKey(ms) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 是否形如 'YYYY-MM-DD'（严格，防止脏键污染日期运算）。 */
export function isDayKey(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

/**
 * 含今日的日历窗口：返回按时间升序的日期键数组。
 * n=1 → [今日]；n=7 → [今天-6 … 今天]。**不是**「最近 7 个有数据的日子」。
 */
export function windowDayKeys(n, nowMs) {
  const size = Math.max(1, Math.floor(num(n) || 1))
  const base = new Date(nowMs)
  const out = []
  for (let i = size - 1; i >= 0; i--) {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() - i)
    out.push(localDayKey(d.getTime()))
  }
  return out
}

/**
 * 峰谷判定：与 dsh-cost-meter/lib/pricing.js 的 isPeakHour 同口径。
 *
 *   - 生效时刻之前（peakEnabled 关或未到 peakEffectiveAt）恒为谷价；
 *   - 周末恒为谷价；
 *   - 假期表里的日期恒为谷价；
 *   - 否则看 UTC 小时是否落在任一 [start, end) 窗口内。
 *
 * 注意：窗口用的是 **UTC 小时**（DSH 官方口径），不是本地小时。
 */
export function isPeakHourLike(atMs, peak) {
  if (peak?.enabled !== true) return false
  const effectiveAt = Number(peak.effectiveAtMs)
  if (Number.isFinite(effectiveAt) && atMs < effectiveAt) return false
  const d = new Date(atMs)
  const day = d.getUTCDay()
  if (day === 0 || day === 6) return false
  const holidays = Array.isArray(peak.holidays) ? peak.holidays : []
  if (holidays.length > 0) {
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
    if (holidays.includes(key)) return false
  }
  const hour = d.getUTCHours()
  const windows = Array.isArray(peak.windows) ? peak.windows : []
  for (const w of windows) {
    const start = Number(w?.start)
    const end = Number(w?.end)
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    if (hour >= start && hour < end) return true
  }
  return false
}

/** 一个价表条目在某时刻的三档单价（USD / 1M token）。 */
function tierFromEntry(entry, atMs, peak) {
  const base = pickRateSet(entry, atMs)
  const isPeak = isPeakHourLike(atMs, peak)
  const set = isPeak && base.peak ? base.peak : (base.offPeak ?? base)
  const cacheHit = num(set.cacheHit)
  const cacheMiss = num(set.cacheMiss)
  const output = num(set.output)
  const cacheWrite = Number.isFinite(Number(set.cacheWrite)) && Number(set.cacheWrite) >= 0
    ? num(set.cacheWrite)
    : cacheHit
  return { cacheHit, cacheMiss, output, cacheWrite, isPeak }
}

/**
 * 取该时刻适用的费率组：优先历史上在生效的 rateHistory 条目，
 * 否则用条目自身的 offPeak/peak 或顶层三档。
 */
function pickRateSet(entry, atMs) {
  const history = Array.isArray(entry?.rateHistory) ? entry.rateHistory : []
  for (const item of history) {
    const before = Date.parse(item?.before)
    if (Number.isFinite(before) && atMs < before) return item
  }
  if (entry?.offPeak || entry?.peak) {
    return { offPeak: entry.offPeak, peak: entry.peak, cacheHit: entry.cacheHit, cacheMiss: entry.cacheMiss, output: entry.output }
  }
  return entry ?? {}
}

// ---------------------------------------------------------------------------
// 价格源（profile 权威价表 → 账本价表快照）
// ---------------------------------------------------------------------------

/**
 * 价格源：把「怎么把 provider:model 换成单价」这件事实测出来并缓存。
 * 全部失败时 available=false，上层显示「—」。
 */
export class PriceSource {
  /**
   * @param {object} ledger - 已解析的账本（提供 config.prices 兜底 + config 展示口径）。
   */
  constructor(ledger) {
    const cfg = ledger?.config ?? {}
    this.display = {
      currency: typeof cfg.currency === 'string' ? cfg.currency : 'CNY',
      symbol: typeof cfg.symbol === 'string' ? cfg.symbol : '¥',
      decimals: Number.isFinite(Number(cfg.decimals)) ? Math.max(0, Math.min(8, Math.floor(Number(cfg.decimals)))) : 2,
      exchangeRate: Number.isFinite(Number(cfg.exchangeRate)) && Number(cfg.exchangeRate) > 0 ? Number(cfg.exchangeRate) : 1,
      pricingCurrency: typeof cfg.pricingCurrency === 'string' ? cfg.pricingCurrency : 'USD',
    }
    this.peak = {
      enabled: cfg.peakEnabled === true,
      effectiveAtMs: Date.parse(cfg.peakEffectiveAt),
      windows: Array.isArray(cfg.peakWindows) ? cfg.peakWindows : [],
      holidays: Array.isArray(cfg.peakHolidays) ? cfg.peakHolidays : [],
    }
    this.ledgerPrices = cfg.prices ?? null
    this.profileModule = undefined
    this.pricingPath = ''
    this.available = this.ledgerPrices !== null
    this.source = this.ledgerPrices !== null ? 'ledger' : 'none'
  }

  /**
   * 尝试加载 profile 里的权威计价函数（异步，一次性）。失败静默降级。
   *
   * ⚠ 这里**只借它的函数，不借它的表**。实测（_probe/t4b-diagnose.mjs）：
   * `DEFAULT_PRICE_TABLE` 只含 `{models, default}`，**没有 `providers` 层**；
   * provider 级价格在另一个导出 `DEFAULT_PROVIDER_PRICE_TABLE` 里。
   * 用模块自带的表会把 `paratra-1:Qwen3.8-Max` 这类 provider 级定价误判成「未定价」
   * （实测 30 天窗口少算 ¥2.85）。账本的 `config.prices` 是 cost-meter 自己
   * 合并后**正在使用**的完整表（models + default + providers），
   * 它与账本 `cost` 字段同源，是唯一正确的口径 —— 所以价表只用账本那份，
   * 模块只提供 `providerPriceEntryFor` / `normalizePrice` 这两个函数。
   *
   * @returns {Promise<boolean>} 是否加载到 provider 级解析函数。
   */
  async upgradeFromProfile() {
    if (this.profileModule !== undefined) return true
    const file = profilePricingPath()
    if (file === '') return false
    try {
      const mod = await import(pathToFileURL(file).href)
      if (mod !== null && typeof mod === 'object' && typeof mod.providerPriceEntryFor === 'function') {
        this.profileModule = mod
        this.pricingPath = file
        this.source = 'profile+ledger'
        this.available = this.ledgerPrices !== null
        return true
      }
    } catch {
      // 价表缺失 / 上游签名漂移：都只是降级，不是错误。
    }
    return false
  }

  /** 当前生效的价表：恒为账本里正在使用的那份（含 providers 层）。 */
  get prices() {
    return this.ledgerPrices
  }

  /**
   * 'provider:model' → { priced, tier, isFallback }。
   * priced=false 表示这个模型没有权威单价，**必须排除**，绝不能套默认价。
   */
  entryFor(key, atMs) {
    const prices = this.prices
    if (prices === null || prices === undefined) return { priced: false, reason: 'no-price-table' }
    const at = key.indexOf(':')
    const provider = at < 0 ? '' : key.slice(0, at)
    const model = at < 0 ? key : key.slice(at + 1)

    // 1) 有权威模块就用它的 provider 级解析（含归一化与 providers 表）。
    if (this.profileModule !== undefined && typeof this.profileModule.providerPriceEntryFor === 'function') {
      try {
        const resolved = this.profileModule.providerPriceEntryFor(provider, model, prices)
        if (resolved !== null && resolved !== undefined && resolved.priced === true) {
          const entry = typeof this.profileModule.normalizePrice === 'function'
            ? (this.profileModule.normalizePrice(resolved.entry) ?? resolved.entry)
            : resolved.entry
          return {
            priced: true,
            tier: tierFromEntry(entry, atMs, this.peak),
            isFallback: Object.is(resolved.entry, prices.default),
            provider,
            model,
          }
        }
        if (resolved !== null && resolved !== undefined && resolved.priced === false) {
          return { priced: false, reason: 'unpriced-model', provider, model }
        }
      } catch { /* 落到下面的内置解析 */ }
    }

    // 2) 内置解析：provider 精确 → models 精确 → models 归一化 → default。
    const hit = this.lookupBuiltin(prices, provider, model)
    if (hit === null) return { priced: false, reason: 'unpriced-model', provider, model }
    return {
      priced: true,
      tier: tierFromEntry(hit.entry, atMs, this.peak),
      isFallback: hit.isDefault,
      provider,
      model,
    }
  }

  /**
   * 无第三方模块时的内置解析。
   *
   * 语义用 `_probe/t4e-upstream-edges.mjs` 对 cost-meter 的 `providerPriceEntryFor`
   * 逐例实测钉死（价表 = {models: {exact-nz, all-zero}, default, providers: {known-provider}}）：
   *
   *   known-provider:provider-model → priced=true,  用 provider 表条目
   *   known-provider:not-a-model    → priced=false（provider 被认识但模型无价）
   *   deepseek-official:exact-nz    → priced=true,  用 models 精确条目
   *   deepseek-official:all-zero    → priced=true,  **用全零条目本身**（不回落 default）
   *   deepseek-official:unknown     → priced=true,  回落 default
   *   mystery-gateway:whatever      → priced=false（provider 不在 providers 表里 ⇒ 未定价）
   *
   * 三个容易写错的点：
   *   1. 「精确命中 models」即使三档全零也要**原样返回**，不能当成「未定价」去回落 default
   *      —— 上游就是这么做的，我们若改写会与账本自己的 cost 字段打架。
   *   2. provider **不在** `providers` 表里时，上游返回 priced=false，**不套 default**。
   *      这一点很反直觉（`priceEntryFor` 会套 default），但 provider 级解析更保守：
   *      不认识这个 provider 就等于「不知道它怎么收费」，宁可报未定价也不虚报金额。
   *   3. 因此「回落 default」在本实现里只在价表**完全没有 providers 层**时才发生
   *      （那种价表下我们无从判断 provider 是否被认识，只能按 models 表宽松处理）。
   */
  lookupBuiltin(prices, provider, model) {
    const models = prices?.models ?? {}
    const fallback = prices?.default
    const providers = prices?.providers
    const hasProvidersLayer = providers !== null && typeof providers === 'object'

    // 1) provider 表里该 provider 的模型（大小写敏感精确匹配）。
    const bucket = hasProvidersLayer ? providers[provider]?.models : undefined
    if (bucket !== null && typeof bucket === 'object' && Object.hasOwn(bucket, model)) {
      const entry = bucket[model]
      if (entry !== null && typeof entry === 'object') return { entry, isDefault: false }
    }
    // 2) 全局 models 表精确匹配（全零也原样返回，见上面第 1 点）。
    if (Object.hasOwn(models, model)) {
      const entry = models[model]
      if (entry !== null && typeof entry === 'object') return { entry, isDefault: false }
    }
    // 3) 归一化匹配：'deepseek: deepseek-v4-pro' / 'Deepseek-V4-Pro' 这类真实拼写。
    const norm = normalizeModelName(model)
    for (const candidate of Object.keys(models)) {
      const entry = models[candidate]
      if (normalizeModelName(candidate) === norm && entry !== null && typeof entry === 'object') {
        return { entry, isDefault: false }
      }
    }
    // 4) 兜底：有 providers 层时，只有**被该层认识的** provider 才允许用 default；
    //    不认识的 provider ⇒ 未定价（见上面第 2 点）。
    if (hasProvidersLayer && !Object.hasOwn(providers, provider)) return null
    if (fallback !== null && typeof fallback === 'object' && !isZeroEntry(fallback)) {
      return { entry: fallback, isDefault: true }
    }
    return null
  }
}

/** 去掉空白/破折号/下划线/点并转小写，用于模型名归一化匹配。 */
function normalizeModelName(value) {
  return String(value ?? '').toLowerCase().replace(/[\s\-_.]+/g, '')
}

/** 全零价目视为「未定价」（pricing.js:771 同口径）。 */
function isZeroEntry(entry) {
  if (entry === null || typeof entry !== 'object') return true
  const hit = num(entry.cacheHit)
  const miss = num(entry.cacheMiss)
  const out = num(entry.output)
  return hit === 0 && miss === 0 && out === 0
}

// ---------------------------------------------------------------------------
// 账本读取
// ---------------------------------------------------------------------------

/**
 * 读取并解析账本（带 5 秒缓存；mtime/size 都没变就复用）。
 * 任何失败都返回 null —— 调用方降级显示「—」，绝不抛错。
 */
export function readLedger(nowMs = Date.now()) {
  const file = ledgerPath()
  let stat = null
  try {
    stat = statSync(file)
  } catch {
    return null
  }
  const stamp = `${stat.mtimeMs}:${stat.size}`
  if (readLedger.cache !== undefined
    && readLedger.cache !== null
    && readLedger.cache.stamp === stamp
    && nowMs - readLedger.cache.at < LEDGER_CACHE_MS) {
    return readLedger.cache.ledger
  }
  let ledger = null
  try {
    ledger = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  const wrapper = { stamp, at: nowMs, ledger }
  readLedger.cache = wrapper
  return ledger
}

// ---------------------------------------------------------------------------
// 窗口节省计算
// ---------------------------------------------------------------------------

/**
 * 计算一个窗口（含今日的日历窗口）的节省金额。
 *
 * @param {number} n - 窗口天数（1 / 7 / 30）。
 * @param {object} input
 * @param {object} input.ledger - 已解析账本（null 表示无数据源）。
 * @param {PriceSource} input.priceSource - 价格源。
 * @param {number} input.nowMs - 「现在」的毫秒时间戳（决定今日与窗口边界）。
 * @returns {object} 窗口结果（含 token 明细与金额，绝不含 NaN）。
 */
export function windowSavings(n, { ledger, priceSource, nowMs }) {
  const days = windowDayKeys(n, nowMs)
  const today = localDayKey(nowMs)
  const display = priceSource?.display ?? { currency: 'CNY', symbol: '¥', decimals: 2, exchangeRate: 1 }

  let usd = 0
  let cacheRead = 0
  let cacheReadPriced = 0
  let promptTokens = 0
  let outputTokens = 0
  let pricedBuckets = 0
  let unpricedCacheRead = 0
  let unpricedTokens = 0
  let pricedKnownTokens = 0
  let seenTokens = 0
  let sessions = 0
  let presentDays = 0
  let dayFallbackDays = 0
  const unpricedModels = new Set()
  const perDay = []

  for (const date of days) {
    const day = ledger?.days?.[date]
    if (day === null || day === undefined || typeof day !== 'object') {
      perDay.push({ date, present: false, savingsUsd: 0, cacheRead: 0, sessions: 0 })
      continue
    }
    presentDays++
    const atMs = date === today ? nowMs : dayEndMs(date)

    // 会话桶优先（能按每个会话自己的发生时刻取峰谷档），日桶兜底。
    const sessionList = Array.isArray(day.sessions) ? day.sessions : []
    const buckets = []
    let granularity = 'session'
    if (sessionList.length > 0) {
      for (const session of sessionList) {
        if (session === null || typeof session !== 'object') continue
        // 会话桶用**它自己的发生时刻**取峰谷档。
        // 这里刻意**不做** `Math.min(session.at, nowMs)` 之类的夹紧：
        // 夹紧会把「今天晚些时候真实发生在峰段的会话」拉回当前时刻的档位，
        // 从而系统性低估金额（实测：把 $30 算成 $20）。没有可复现的收益，故不夹。
        const sessionAt = Number.isFinite(Number(session.at)) && Number(session.at) > 0
          ? Number(session.at)
          : atMs
        const map = session.byProviderModel
        if (map === null || typeof map !== 'object') continue
        for (const [key, bucket] of Object.entries(map)) buckets.push({ key, bucket, atMs: sessionAt })
        sessions++
      }
    } else {
      granularity = 'day'
      dayFallbackDays++
      const map = day.byProviderModel
      if (map !== null && typeof map === 'object') {
        for (const [key, bucket] of Object.entries(map)) buckets.push({ key, bucket, atMs })
      }
    }

    let dayUsd = 0
    let dayCacheRead = 0
    let dayPrompt = 0
    let dayOutput = 0
    for (const { key, bucket, atMs: bucketAt } of buckets) {
      if (bucket === null || typeof bucket !== 'object') continue
      const reads = num(bucket.cacheRead)
      const input = num(bucket.input)
      const writes = num(bucket.cacheWrite)
      const output = num(bucket.output)
      dayCacheRead += reads
      dayPrompt += input + writes + reads
      dayOutput += output
      seenTokens += reads + input + writes

      const resolved = priceSource.entryFor(key, bucketAt)
      if (resolved.priced !== true) {
        unpricedModels.add(key)
        unpricedCacheRead += reads
        unpricedTokens += reads + input + writes
        continue
      }
      pricedBuckets++
      pricedKnownTokens += reads + input + writes
      cacheReadPriced += reads
      // 唯一公式：这些 token 本该按全价买，实际按命中价付了。
      dayUsd += reads * Math.max(0, resolved.tier.cacheMiss - resolved.tier.cacheHit) / 1e6
    }

    usd += dayUsd
    cacheRead += dayCacheRead
    promptTokens += dayPrompt
    outputTokens += dayOutput
    perDay.push({
      date,
      present: true,
      granularity,
      savingsUsd: dayUsd,
      cacheRead: dayCacheRead,
      promptTokens: dayPrompt,
      sessions: granularity === 'session' ? sessionList.length : 0,
    })
  }

  const usdRounded = Number.isFinite(usd) ? usd : 0
  return {
    window: n,
    label: n === 1 ? '今日' : `近 ${n} 天`,
    from: days[0],
    to: days[days.length - 1],
    days,
    presentDays,
    dayFallbackDays,
    sessions,
    cacheRead,
    cacheReadPriced,
    promptTokens,
    outputTokens,
    pricedBuckets,
    unpricedModels: [...unpricedModels].sort(),
    /** 未定价模型覆盖的 token 量：金额不完整时如实告知规模。 */
    unpricedCacheRead,
    unpricedTokens,
    /** 定价覆盖率（按 token 计），1 表示全部用量都有权威单价。 */
    pricedCoverage: seenTokens > 0 ? pricedKnownTokens / seenTokens : null,
    savingsUsd: usdRounded,
    savingsDisplay: usdRounded * display.exchangeRate,
    perDay,
  }
}

/**
 * 计算三个窗口（今日 / 近 7 天 / 近 30 天）的节省汇总。
 *
 * @param {object} [input]
 * @param {number} [input.nowMs] - 「现在」；默认 Date.now()。
 * @param {object} [input.ledger] - 直接注入账本（测试用）。
 * @param {PriceSource} [input.priceSource] - 直接注入价格源（测试用）。
 * @returns {Promise<object>} { available, reason, source, display, windows:[1d,7d,30d] }
 */
export async function computeSavings(input = {}) {
  const nowMs = Number.isFinite(Number(input.nowMs)) ? Number(input.nowMs) : Date.now()
  const ledger = input.ledger !== undefined ? input.ledger : readLedger(nowMs)

  if (ledger === null || ledger === undefined) {
    return {
      available: false,
      reason: 'ledger-missing',
      source: 'none',
      pricingPath: '',
      display: { currency: 'CNY', symbol: '¥', decimals: 2, exchangeRate: 1, pricingCurrency: 'USD' },
      peak: { enabled: false, windows: [] },
      generatedAt: nowMs,
      windows: [],
      unpricedModels: [],
    }
  }

  const priceSource = input.priceSource ?? new PriceSource(ledger)
  // 借 profile 里 dsh-cost-meter 的 provider 级解析函数；失败只是降级到内置解析。
  if (input.priceSource === undefined) await priceSource.upgradeFromProfile()

  const windows = SAVINGS_WINDOWS.map((n) => windowSavings(n, { ledger, priceSource, nowMs }))
  const unpricedModels = new Set()
  for (const w of windows) for (const m of w.unpricedModels) unpricedModels.add(m)

  return {
    available: priceSource.available === true && windows.some((w) => w.cacheRead > 0),
    reason: priceSource.available === true ? 'ok' : 'price-table-missing',
    source: priceSource.source,
    pricingPath: priceSource.pricingPath,
    display: priceSource.display,
    peak: { enabled: priceSource.peak.enabled, windows: priceSource.peak.windows },
    generatedAt: nowMs,
    windows,
    unpricedModels: [...unpricedModels].sort(),
  }
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

/** 按展示币种格式化金额（负数/NaN 一律显示 0）。 */
export function formatMoney(value, display) {
  const n = Number(value)
  const safe = Number.isFinite(n) ? n : 0
  const decimals = Number.isFinite(Number(display?.decimals)) ? Math.max(0, Math.min(8, Math.floor(Number(display.decimals)))) : 2
  const symbol = typeof display?.symbol === 'string' && display.symbol !== '' ? display.symbol : '¥'
  return `${symbol}${safe.toFixed(decimals)}`
}

/** 千分位整数。 */
export function formatTokens(value) {
  const n = Math.round(num(value))
  return n.toLocaleString('en-US')
}

/** 取指定天数的窗口（找不到返回 null）。 */
export function pickWindow(savings, n) {
  const list = Array.isArray(savings?.windows) ? savings.windows : []
  return list.find((w) => w.window === n) ?? null
}

/**
 * 渲染「节省金额」段落（中文 markdown），供 cache_report 工具与 HTTP 复用。
 */
export function renderSavingsMarkdown(savings, options = {}) {
  const display = savings?.display ?? { symbol: '¥', decimals: 2, currency: 'CNY', exchangeRate: 1 }
  const lines = []
  lines.push('## 省下的钱（按实时单价折算）')
  if (savings === null || savings === undefined || savings.available !== true) {
    const why = savings?.reason === 'ledger-missing'
      ? '读不到 cost-meter 账本（storages/cost-meter/ledger.json），无法折算金额。'
      : '取不到权威价表，无法折算金额。'
    lines.push(`- —（${why}）`)
    return lines.join('\n')
  }
  lines.push('')
  lines.push('| 窗口 | 日期范围 | 缓存读 token | 省下 |')
  lines.push('| --- | --- | --- | --- |')
  for (const n of SAVINGS_WINDOWS) {
    const w = pickWindow(savings, n)
    if (w === null) continue
    const label = n === 1 ? '今日' : `近 ${n} 天`
    lines.push(`| ${label} | ${w.from} ~ ${w.to} | ${formatTokens(w.cacheRead)} | **${formatMoney(w.savingsDisplay, display)}** |`)
  }
  const w7 = pickWindow(savings, 7)
  if (w7 !== null && (w7.unpricedModels.length > 0 || w7.pricedCoverage !== null)) {
    lines.push('')
    if (w7.unpricedModels.length > 0) {
      lines.push(`- 口径提示：有 ${w7.unpricedModels.length} 个模型没有权威单价，其用量已**排除**在金额之外，因此实际节省不低于上表。`)
    }
    if (w7.dayFallbackDays > 0) {
      lines.push(`- 口径提示：近 7 天中有 ${w7.dayFallbackDays} 天缺少会话级时间戳，按整日单档估算。`)
    }
  }
  lines.push('')
  lines.push(`- 公式：` + '`节省 = Σ 缓存读 token × (未命中价 − 命中价) / 1e6`；输出 token 无折扣，不计入。')
  const sourceLabel = savings.source === 'profile+ledger'
    ? 'cost-meter 账本里正在使用的完整价表（models + providers 两层，由 profile 内 dsh-cost-meter 的 providerPriceEntryFor 解析）'
    : 'cost-meter 账本价表快照（内置解析）'
  lines.push(`- 单价来源：${sourceLabel}，单位 USD / 1M token；展示按汇率 ${display.exchangeRate} 折 ${display.currency}。`)
  if (options.note !== undefined && options.note !== '') lines.push(`- ${options.note}`)
  return lines.join('\n')
}
