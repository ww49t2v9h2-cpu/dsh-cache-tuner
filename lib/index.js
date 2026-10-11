/**
 * ============================================================================
 * dsh-cache-tuner —— 宿主半侧（host half）
 * ============================================================================
 *
 * 【这个插件解决什么问题】
 *   DeepSeek 对「命中前缀缓存」的输入 token 收费极低，对未命中的输入 token
 *   收费很高。也就是说：**提示词前缀越稳定，越省钱**。
 *   配套插件 dsh-whale-girl-pet 已经在自己的计费界面里"显示"了缓存命中率，
 *   本插件补上缺的另一半：把「命中率突然掉了」变成
 *   「是 section "app:web-surface" 又变了」这种可执行的因果结论。
 *
 * 【它做四件事】
 *   1. 采集：监听 session/event，把每一步的 usage 归集成全局/会话两级统计。
 *   2. 归因：在 step/start 与 request/header(change) 时调用 systemPrompt.assemble()，
 *      对 sections / contexts / tools 逐部件算 sha1 指纹，与上一次对比，
 *      精确指出「谁变了」，并把变化分成两类：
 *        · 前缀变化（section / tools）—— 真正位于系统提示词前缀，一变其后全废；
 *        · 尾部变化（context）—— 运行上下文以尾部用户消息下发，代价小得多。
 *   3. 省 token：提供 suppressRuntimeContext 开关（默认关）。注意它省的是
 *      token，不是缓存——本插件不会把它说成提升命中率的手段。
 *   4. 暴露：/api/cache-tuner/* HTTP 接口 + cache_report 工具，供浏览器半侧与模型读取。
 *
 * 【边界纪律】
 *   - 只 import node:* 内建模块与相对 ./x.js，绝不 import @deepseek-ai/*。
 *   - 所有监听器绝不向事件总线抛异常：整段包在 try/catch 里（session/event 是
 *     fire-and-forget 的观察者，出错只会被记日志，但主动不抛更干净）。
 *   - 一切计数器都有上限，绝不无限增长。
 * ============================================================================
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isLoopbackRequest } from './loopback.js'
import {
  computeSavings,
  pickWindow,
  renderSavingsMarkdown,
} from './savings.js'
import {
  DEFAULT_SETTINGS,
  MAX_BREAKS_GLOBAL,
  MAX_SESSIONS,
  MAX_STEPS_PER_SESSION,
  applyUsage,
  buildNotes,
  diffFingerprints,
  emptyAggregate,
  finalizeAggregate,
  fingerprintAssembly,
  formatPercent,
  makeStepRow,
  pushCapped,
  sanitizeSettings,
  touchCapped,
} from './model.js'

/** Cordis 插件名（必须等于 cordis.patch.yml 里的行 id，也等于客户端 exports.name）。 */
export const name = 'cache-tuner'

/** 需要注入的服务：HTTP 载体 + 工具注册表 + 提示词装配注册表。 */
export const inject = ['webServer', 'tools', 'systemPrompt']

/** 路由前缀。 */
const ROUTE_PREFIX = '/api/cache-tuner'

/** 请求体上限：1 MB。 */
const MAX_BODY_BYTES = 1024 * 1024

/** 设置落盘位置：$DSH_HOME/storages/cache-tuner/settings.json。 */
function settingsFile() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'storages', 'cache-tuner', 'settings.json')
}

/**
 * 宿主插件主体。
 * @param {object} ctx - 宿主 cordis 上下文。
 * @param {object} [config] - cordis.patch.yml 里这一行的 config（作为默认值）。
 */
export function apply(ctx, config) {
  let options = sanitizeSettings(config, DEFAULT_SETTINGS)

  // -------------------------------------------------------------------------
  // 状态（全部有上限）
  // -------------------------------------------------------------------------
  /** 全局聚合器。 */
  const globalAgg = emptyAggregate()
  /** sessionId -> { agg, steps: [], breaks: [], cursor: {turn, step}, lastActiveAt }（LRU 上限 maxSessions）。 */
  const sessions = new Map()
  /** sessionId -> Agent（assemble 的 scope key），LRU 上限。 */
  const scopes = new Map()
  /** sessionId -> 上一次的部件指纹。 */
  const fingerprints = new Map()
  /** 全局断点环（跨会话，最近 N 条）。 */
  const globalBreaks = []
  /** 最近产出过 usage 的会话 —— 客户端不带 session 参数时默认看它。 */
  let lastActiveSessionId = ''
  /** 归因调度状态：sessionId -> { busy, queued, lastKey }。 */
  const fingerprintState = new Map()

  /**
   * stableTools 能力探测结果。
   *
   * 结论（已在 DSH 0.2.0-rc.2 的实现里逐行核对）：
   *   工具 provider 是**追加**语义，`assemble()` 里
   *     const providers = [...global.toolProviders.values(), ...scopeLayers.flatMap(...)]
   *     for (const provider of providers) { ... collected.push(...schemas) }
   *   全程**没有按名字去重**；而工具注册表自己已经注册了
   *     ctx.systemPrompt.tools(context => this.wireSchemas(context.scope))
   *   返回全量可见工具。我们再注册一个「返回同样 schema」的 provider，
   *   只会把每个工具原样复制一份塞进提示词 —— 那是**加倍**提示词长度，
   *   既毁缓存又浪费钱，与插件目标完全相反。
   *   另外 `orderTools()` 在 toolOrder 未配置时本来就 `tools.sort(compareToolNames)`
   *   —— 工具已经是按名字典序确定的，稳定化的收益本来就是零。
   * 因此：stableTools 默认**不注册**，并在 capabilities 里如实上报。
   */
  const stableToolsProbe = { checked: false, supported: false, reason: '尚未探测。' }
  let stableToolsProbed = false

  // -------------------------------------------------------------------------
  // 节省金额（今日 / 近 7 天 / 近 30 天）
  //
  // 口径：把 cost-meter 账本里的历史 token 用量，按**实时单价**折成金额。
  //   节省 = Σ 缓存读 token × (未命中价 − 命中价) / 1e6
  // 细节与边界全部在 lib/savings.js 里，这里只负责「算一次、缓存、广播」。
  //
  // 为什么快照要同步可用：buildSnapshot() 是同步函数（HTTP 与工具共用）。
  // 所以这里维护一份缓存，路由进来时先 refresh（有 TTL），快照读缓存。
  // 账本缺失 / 价表缺失时 savings = null，界面显示「—」，绝不显示 NaN。
  // -------------------------------------------------------------------------
  /** 最近一次成功算出的节省结果。 */
  let savingsCache = null
  /** 飞行中的刷新 Promise（合并并发调用）。 */
  let savingsInflight = null
  /** 上次刷新的时刻。 */
  let savingsAt = 0
  /** 节省快照的重算间隔：5 秒（与客户端轮询一致）。 */
  const SAVINGS_TTL_MS = 5000

  /** 重算一次节省快照。失败时保留上一次结果，绝不抛错。 */
  const refreshSavings = async (force = false) => {
    if (!force && savingsCache !== null && Date.now() - savingsAt < SAVINGS_TTL_MS) return savingsCache
    if (savingsInflight !== null) return savingsInflight
    savingsInflight = (async () => {
      try {
        const next = await computeSavings({})
        savingsCache = next
        savingsAt = Date.now()
      } catch (error) {
        ctx.logger?.warn?.(`cache-tuner: 计算节省金额失败：${String(error?.message ?? error)}`)
      } finally {
        savingsInflight = null
      }
      return savingsCache
    })()
    return savingsInflight
  }

  /** 把节省结果压成快照里的紧凑形态（带展示用的已格式化金额）。 */
  const savingsPayload = () => {
    if (savingsCache === null) {
      return { available: false, reason: 'not-computed', windows: [] }
    }
    const display = savingsCache.display
    const windows = (savingsCache.windows ?? []).map((w) => ({
      window: w.window,
      label: w.label,
      from: w.from,
      to: w.to,
      presentDays: w.presentDays,
      sessions: w.sessions,
      cacheRead: w.cacheRead,
      promptTokens: w.promptTokens,
      outputTokens: w.outputTokens,
      savingsUsd: w.savingsUsd,
      savingsDisplay: w.savingsDisplay,
      savingsText: `${display.symbol}${Number(w.savingsDisplay).toFixed(display.decimals)}`,
      pricedCoverage: w.pricedCoverage,
      dayFallbackDays: w.dayFallbackDays,
      unpricedModels: w.unpricedModels,
      unpricedCacheRead: w.unpricedCacheRead,
    }))
    return {
      available: savingsCache.available === true,
      reason: savingsCache.reason,
      source: savingsCache.source,
      display,
      peak: savingsCache.peak,
      generatedAt: savingsCache.generatedAt,
      unpricedModels: savingsCache.unpricedModels ?? [],
      windows,
    }
  }

  // -------------------------------------------------------------------------
  // 设置持久化
  // -------------------------------------------------------------------------
  const persist = async () => {
    try {
      const file = settingsFile()
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, JSON.stringify(options, null, 2), 'utf8')
    } catch (error) {
      ctx.logger?.warn?.(`cache-tuner: 设置写盘失败：${String(error?.message ?? error)}`)
    }
  }

  const restore = async () => {
    try {
      const raw = await readFile(settingsFile(), 'utf8')
      options = sanitizeSettings(JSON.parse(raw), options)
    } catch {
      // 首次运行没有文件：保持默认。
    }
  }

  // -------------------------------------------------------------------------
  // 省 token 开关：抑制动态运行上下文（默认关）
  // 口径提醒：运行的上下文是以「尾部用户消息」下发的，不在系统提示词前缀里，
  // 所以打开它**省的是提示词 token，不是缓存**。设置页与 README 都按这个口径写。
  // -------------------------------------------------------------------------
  /** 当前持有的抑制器 disposer；null 表示未抑制。 */
  let suppressDisposer = null

  const applySuppression = () => {
    const wanted = options.suppressRuntimeContext === true && options.enabled !== false
    try {
      if (wanted && suppressDisposer === null) {
        suppressDisposer = ctx.systemPrompt.suppressRuntimeContext()
      } else if (!wanted && suppressDisposer !== null) {
        const dispose = suppressDisposer
        suppressDisposer = null
        dispose()
      }
    } catch (error) {
      suppressDisposer = null
      ctx.logger?.warn?.(`cache-tuner: 切换运行上下文抑制失败：${String(error?.message ?? error)}`)
    }
  }

  // 插件卸载时把抑制器还回去，避免留下全局副作用。
  ctx.effect(() => () => {
    if (suppressDisposer !== null) {
      const dispose = suppressDisposer
      suppressDisposer = null
      try { dispose() } catch { /* 卸载路径，忽略 */ }
    }
  }, 'cache-tuner: runtime-context suppressor cleanup')

  // -------------------------------------------------------------------------
  // 稳定器 2：工具集稳定化 —— 能力探测（只读，不改运行时）
  // -------------------------------------------------------------------------
  /**
   * 只读探测：装配一次全局视图，看工具注册表已经提供的 schema 是否已经
   * 全部出现在装配结果里。若是，则说明基础 provider 已经覆盖全量工具，
   * 我们再注册一个必然造成重复 —— 判定为不支持。
   */
  const probeStableTools = async () => {
    if (stableToolsProbed) return
    stableToolsProbed = true
    try {
      const assembly = await ctx.systemPrompt.assemble({})
      const assembledNames = new Set(
        (assembly?.tools ?? [])
          .map((tool) => (typeof tool?.name === 'string' ? tool.name : ''))
          .filter((value) => value !== ''),
      )
      const visible = ctx.tools.schemas()
      const missing = visible
        .map((tool) => (typeof tool?.name === 'string' ? tool.name : ''))
        .filter((value) => value !== '' && !assembledNames.has(value))

      if (visible.length > 0 && missing.length === 0) {
        stableToolsProbe.supported = false
        stableToolsProbe.reason = '工具注册表已提供全量工具，且装配结果的工具列表是按名称典序确定的；再注册一个稳定化 provider 只会把每个工具复制一份（provider 为追加语义、不按名去重），因此本版本不注册。'
      } else if (missing.length > 0) {
        stableToolsProbe.supported = false
        stableToolsProbe.reason = `装配结果缺少 ${missing.length} 个可见工具（${missing.slice(0, 5).join('、')}），注册稳定化 provider 仍不安全，已跳过。`
      } else {
        stableToolsProbe.supported = false
        stableToolsProbe.reason = '当前作用域下取不到可见工具集，无法安全地注册稳定化 provider，已跳过。'
      }
    } catch (error) {
      stableToolsProbe.supported = false
      stableToolsProbe.reason = `探测失败（${String(error?.message ?? error)}），为安全起见不注册。`
    } finally {
      stableToolsProbe.checked = true
    }
  }

  // -------------------------------------------------------------------------
  // 采集与归因
  // -------------------------------------------------------------------------
  /** 取（或建）一个会话的统计记录。 */
  const sessionRecord = (sessionId) => {
    let record = sessions.get(sessionId)
    if (record === undefined) {
      record = {
        id: sessionId,
        agg: emptyAggregate(),
        steps: [],
        breaks: [],
        cursor: { turn: 0, step: 0 },
        lastActiveAt: 0,
      }
    } else {
      sessions.delete(sessionId)
    }
    sessions.set(sessionId, record)
    // LRU 淘汰最久未活跃的会话。
    const limit = Number.isFinite(options.maxSessions) ? options.maxSessions : MAX_SESSIONS
    while (sessions.size > Math.max(5, limit)) {
      const oldest = sessions.keys().next()
      if (oldest.done === true) break
      if (oldest.value === sessionId) break
      sessions.delete(oldest.value)
    }
    return record
  }

  /** 记录一条断点（同时进会话环与全局环）。 */
  const pushBreak = (record, entry) => {
    const limit = Number.isFinite(options.maxBreaksPerSession) ? options.maxBreaksPerSession : 100
    pushCapped(record.breaks, entry, limit)
    pushCapped(globalBreaks, entry, MAX_BREAKS_GLOBAL)
  }

  /**
   * 装配一次提示词并做指纹对比 —— 本插件的核心归因步骤。
   * 任何异常都被吞掉：指纹是尽力而为的，绝不能影响正常请求。
   */
  const runFingerprint = async (sessionId, reason) => {
    const state = fingerprintState.get(sessionId) ?? { busy: false, queued: null, lastKey: '' }
    const record = sessionRecord(sessionId)
    const key = `${record.cursor.turn}:${record.cursor.step}:${reason}`
    if (state.busy) {
      state.queued = reason
      fingerprintState.set(sessionId, state)
      return
    }
    if (key === state.lastKey) return
    state.busy = true
    state.lastKey = key
    fingerprintState.set(sessionId, state)

    try {
      const scope = scopes.get(sessionId)
      let assembly
      if (scope !== undefined && scope !== null) {
        // 会话作用域可用：能覆盖 scoped 分区/上下文，归因最完整。
        assembly = await ctx.systemPrompt.assemble({ agent: scope, scope })
      } else {
        // 拿不到 scope 时退化为全局视图（只覆盖全局提示词），不抛错。
        assembly = await ctx.systemPrompt.assemble({})
      }
      const snapshot = fingerprintAssembly(assembly)
      const previous = fingerprints.get(sessionId)
      touchCapped(fingerprints, sessionId, snapshot, Math.max(5, options.maxSessions))

      if (previous !== undefined) {
        const diff = diffFingerprints(previous, snapshot)
        if (!diff.empty) {
          pushBreak(record, {
            at: Date.now(),
            sessionId,
            turn: record.cursor.turn,
            step: record.cursor.step,
            reason,
            changed: diff.changed,
            kinds: diff.kinds,
            // 前缀变化（section/tools）才是真断点；尾部 context 变化代价小得多。
            prefix: diff.prefix,
          })
        }
      }
    } catch (error) {
      // 装配失败（例如其它插件注册了会抛错的 provider）：静默降级。
      ctx.logger?.warn?.(`cache-tuner: 提示词装配失败，本轮跳过归因：${String(error?.message ?? error)}`)
    } finally {
      state.busy = false
      const queued = state.queued
      state.queued = null
      fingerprintState.set(sessionId, state)
      if (queued !== null && queued !== undefined && options.enabled) {
        // 飞行中又有新信号：让出一次事件循环后再跑，避免堆积。
        Promise.resolve().then(() => runFingerprint(sessionId, queued)).catch(() => {})
      }
    }
  }

  const scheduleFingerprint = (sessionId, reason) => {
    if (options.enabled === false || sessionId === '') return
    // 不 await：session/event 是 fire-and-forget 的观察者。
    Promise.resolve()
      .then(() => runFingerprint(sessionId, reason))
      .catch(() => { /* 已在内部处理 */ })
  }

  /** 处理一条会话事件（同步部分必须极快）。 */
  const handleEvent = (session, event) => {
    const sessionId = String(session?.id ?? '')
    if (sessionId === '') return
    const type = event?.type
    const data = event?.data
    if (data === null || typeof data !== 'object') return

    if (type === 'assistant/message') {
      const usage = data.usage
      if (usage === null || typeof usage !== 'object') return
      const record = sessionRecord(sessionId)
      if (Number.isFinite(data.turn)) record.cursor.turn = Number(data.turn)
      if (Number.isFinite(data.step)) record.cursor.step = Number(data.step)

      // provider / model 从会话的请求头取，取不到留空串。
      let provider = ''
      let model = ''
      try {
        const header = session?.requestHeader?.()
        if (header !== null && typeof header === 'object' && header.config !== null && typeof header.config === 'object') {
          if (typeof header.config.provider === 'string') provider = header.config.provider
          if (typeof header.config.model === 'string') model = header.config.model
        }
      } catch { /* 取不到就算了 */ }

      const row = makeStepRow(usage, {
        at: Number.isFinite(event?.time) ? event.time : Date.now(),
        turn: data.turn,
        step: data.step,
        provider,
        model,
      })
      applyUsage(record.agg, usage)
      applyUsage(globalAgg, usage)
      const limit = Number.isFinite(options.maxStepsPerSession) ? options.maxStepsPerSession : MAX_STEPS_PER_SESSION
      pushCapped(record.steps, row, limit)
      record.lastActiveAt = Date.now()
      lastActiveSessionId = sessionId
      return
    }

    if (type === 'step/start' || type === 'turn/start') {
      const record = sessionRecord(sessionId)
      if (Number.isFinite(data.turn)) record.cursor.turn = Number(data.turn)
      if (Number.isFinite(data.step)) record.cursor.step = Number(data.step)
      record.lastActiveAt = Date.now()
      scheduleFingerprint(sessionId, 'step/start')
      return
    }

    if (type === 'request/header') {
      if (data.reason === 'change') {
        const record = sessionRecord(sessionId)
        record.lastActiveAt = Date.now()
        scheduleFingerprint(sessionId, 'change')
      }
      return
    }
  }

  ctx.on('session/event', (session, event) => {
    if (options.enabled === false) return
    try {
      handleEvent(session, event)
    } catch (error) {
      // 观察者绝不向事件总线抛异常。
      ctx.logger?.warn?.(`cache-tuner: 处理会话事件失败：${String(error?.message ?? error)}`)
    }
  })

  // 会话作用域登记：agent 对象本身就是 ScopeKey，assemble({ scope }) 需要它。
  ctx.on('agent/created', (payload) => {
    try {
      const agent = payload?.agent
      if (agent === null || typeof agent !== 'object') return
      const id = String(agent.id ?? '')
      if (id === '') return
      touchCapped(scopes, id, agent, Math.max(8, options.maxSessions))
    } catch { /* 忽略 */ }
  })

  ctx.on('agent/disposed', (payload) => {
    try {
      const id = String(payload?.agent?.id ?? '')
      if (id !== '') scopes.delete(id)
    } catch { /* 忽略 */ }
  })

  ctx.on('session/disposed', (session) => {
    try {
      const id = String(session?.id ?? '')
      if (id === '') return
      scopes.delete(id)
      fingerprints.delete(id)
      fingerprintState.delete(id)
      if (lastActiveSessionId === id) lastActiveSessionId = ''
    } catch { /* 忽略 */ }
  })

  // -------------------------------------------------------------------------
  // 快照（HTTP 与工具共用同一份渲染逻辑）
  // -------------------------------------------------------------------------
  /** 组装一次完整快照。 */
  const buildSnapshot = (requestedSessionId) => {
    const sessionId = requestedSessionId !== '' && sessions.has(requestedSessionId)
      ? requestedSessionId
      : (lastActiveSessionId !== '' && sessions.has(lastActiveSessionId) ? lastActiveSessionId : '')

    const record = sessionId !== '' ? sessions.get(sessionId) : undefined
    const sessionAgg = finalizeAggregate(record?.agg ?? emptyAggregate())
    const breaks = record !== undefined ? [...record.breaks] : [...globalBreaks]
    const capabilities = {
      scope: sessionId !== '' && scopes.has(sessionId),
      stableTools: { supported: stableToolsProbe.supported, checked: stableToolsProbe.checked, reason: stableToolsProbe.reason },
      suppressRuntimeContext: { active: suppressDisposer !== null },
    }

    return {
      at: Date.now(),
      sessionId,
      global: finalizeAggregate(globalAgg),
      session: {
        ...sessionAgg,
        id: sessionId,
        steps: record !== undefined ? [...record.steps] : [],
      },
      breaks: breaks.slice(-50).reverse(),
      notes: buildNotes({
        options,
        breaks,
        hitRate: sessionAgg.hitRate !== null ? sessionAgg.hitRate : finalizeAggregate(globalAgg).hitRate,
        steps: sessionAgg.steps,
        capabilities,
      }),
      capabilities,
      settings: { ...options },
      // 省钱读数：今日 / 近 7 天 / 近 30 天（按实时单价折算）。
      savings: savingsPayload(),
      recentSessions: [...sessions.values()]
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
        .slice(0, 10)
        .map((item) => ({
          id: item.id,
          steps: item.agg.steps,
          hitRate: finalizeAggregate(item.agg).hitRate,
          promptTokens: item.agg.promptTokens,
          breaks: item.breaks.length,
          lastActiveAt: item.lastActiveAt,
        })),
    }
  }

  /** 把快照渲染成给模型看的中文 markdown（cache_report 工具用）。 */
  const renderReport = () => {
    const snapshot = buildSnapshot('')
    const { global, session, notes, capabilities, savings } = snapshot
    const lines = []
    lines.push('# 前缀缓存命中报告')
    lines.push('')
    lines.push('## 全局累计（本进程内存，重启归零）')
    lines.push(`- 步数：${global.steps}`)
    lines.push(`- 提示词 token：${global.promptTokens}（其中缓存读 ${global.cacheRead} / 缓存写 ${global.cacheWrite} / 新输入 ${global.input}）`)
    lines.push(`- 命中率：${global.hitRate === null ? '—（暂无数据）' : formatPercent(global.hitRate)}`)
    lines.push(`- 估算省下的输入 token：${global.savedTokens}`)
    lines.push(`- 输出 token：${global.output}`)
    lines.push('')
    // 金额口径的读数来自 cost-meter 账本的历史用量，与本进程内存计数器是两套口径。
    if (savings !== undefined && savings !== null) {
      lines.push(renderSavingsMarkdown(savingsCache ?? savings, {
        note: '本段来自 cost-meter 账本的历史用量，与上面的「本进程内存计数器」不是同一口径。',
      }))
      lines.push('')
    }
    if (snapshot.sessionId !== '') {
      lines.push(`## 当前会话 ${snapshot.sessionId}`)
      lines.push(`- 步数：${session.steps.length}；命中率：${session.hitRate === null ? '—' : formatPercent(session.hitRate)}`)
      lines.push(`- 提示词 token：${session.promptTokens}；缓存读：${session.cacheRead}`)
      lines.push('')
    }
    lines.push(`## 最近缓存断点（共记录 ${snapshot.breaks.length} 条）`)
    if (snapshot.breaks.length === 0) {
      lines.push('- 暂无')
    } else {
      for (const item of snapshot.breaks.slice(0, 8)) {
        lines.push(`- turn ${item.turn} / step ${item.step}（${item.reason}）：${item.changed.join('、')}`)
      }
    }
    lines.push('')
    lines.push('## 建议')
    for (const note of notes) lines.push(`- ${note}`)
    lines.push('')
    lines.push(`## 能力状态`)
    lines.push(`- 会话作用域归因：${capabilities.scope ? '可用' : '不可用（退化为全局提示词指纹）'}`)
    lines.push(`- 运行上下文抑制：${capabilities.suppressRuntimeContext.active ? '已开启' : '未开启'}`)
    lines.push(`- 工具集稳定化：未注册 —— ${capabilities.stableTools.reason}`)
    return lines.join('\n')
  }

  // -------------------------------------------------------------------------
  // 工具：cache_report
  // -------------------------------------------------------------------------
  ctx.effect(() => ctx.tools.register({
    name: 'cache_report',
    description: [
      '生成 DeepSeek 前缀缓存命中报告：全局与会话的命中率、提示词/缓存读/缓存写 token、估算省下的 token，',
      '**今日 / 近 7 天 / 近 30 天按实时单价折算的节省金额**，',
      '以及最近几次缓存断点的**因果归因**（到底哪个 section / context / 工具发生了变化），',
      '并给出可执行的调优建议。用于排查「为什么这一轮没有命中缓存」以及「怎么改才能省钱」。',
    ].join(''),
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, markdown: { type: 'string' } },
        required: ['ok', 'markdown'],
        additionalProperties: true,
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.markdown ?? '') }],
    },
    isConcurrencySafe: () => true,
    async execute() {
      let markdown = ''
      try {
        // 先算一次金额（带 TTL 缓存），保证首次调用也拿得到今日/7 天/30 天读数。
        await refreshSavings()
        markdown = renderReport()
      } catch (error) {
        return { ok: false, markdown: `生成缓存报告失败：${String(error?.message ?? error)}` }
      }
      return { ok: true, markdown }
    },
  }), 'cache-tuner: cache_report tool')

  // -------------------------------------------------------------------------
  // HTTP 接口
  // -------------------------------------------------------------------------
  const sendJson = (res, status, body) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(body))
  }

  const readBody = (req) => new Promise((resolve) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) { req.destroy(); resolve(null); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim() === '') { resolve({}); return }
      try { resolve(JSON.parse(raw)) } catch { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })

  /** 把请求路径归一化成前缀之后的相对路径（兼容前缀被剥离/保留两种实现）。 */
  const routePath = (req) => {
    let pathname = '/'
    try { pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname } catch { /* 保持默认 */ }
    const at = pathname.indexOf(ROUTE_PREFIX)
    const tail = at >= 0 ? pathname.slice(at + ROUTE_PREFIX.length) : pathname
    return tail === '' ? '/' : tail
  }

  const queryParam = (req, key) => {
    try {
      return new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get(key) ?? ''
    } catch {
      return ''
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      // 安全围栏：webServer 没有请求级网关，路由必须自己挡非环回来源。
      if (!isLoopbackRequest(req)) {
        sendJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
        return
      }
      try {
        const path = routePath(req)
        const method = (req.method ?? 'GET').toUpperCase()

        if (method === 'GET' && path === '/stats') {
          await probeStableTools()
          // 金额快照有 5 秒 TTL：客户端轮询时不会每次重算。
          await refreshSavings()
          const requested = queryParam(req, 'session').trim()
          sendJson(res, 200, { ok: true, ...buildSnapshot(requested) })
          return
        }

        if (method === 'GET' && path === '/savings') {
          // 单独一个端点：省得为了看钱而拉整份 stats。
          const force = queryParam(req, 'refresh') === '1'
          await refreshSavings(force)
          sendJson(res, 200, { ok: true, savings: savingsPayload() })
          return
        }

        if (method === 'GET' && path === '/settings') {
          sendJson(res, 200, {
            ok: true,
            settings: { ...options },
            defaults: { ...DEFAULT_SETTINGS },
            capabilities: {
              stableTools: { supported: stableToolsProbe.supported, checked: stableToolsProbe.checked, reason: stableToolsProbe.reason },
              suppressRuntimeContext: { active: suppressDisposer !== null },
            },
          })
          return
        }

        if (method === 'POST' && path === '/settings') {
          const body = await readBody(req)
          if (body === null) { sendJson(res, 400, { ok: false, error: 'invalid-json' }); return }
          options = sanitizeSettings(body, options)
          applySuppression()
          await persist()
          sendJson(res, 200, {
            ok: true,
            settings: { ...options },
            capabilities: {
              stableTools: { supported: stableToolsProbe.supported, checked: stableToolsProbe.checked, reason: stableToolsProbe.reason },
              suppressRuntimeContext: { active: suppressDisposer !== null },
            },
          })
          return
        }

        if (method === 'POST' && path === '/reset') {
          globalAgg.steps = 0
          globalAgg.input = 0
          globalAgg.cacheRead = 0
          globalAgg.cacheWrite = 0
          globalAgg.output = 0
          globalAgg.promptTokens = 0
          globalAgg.savedTokens = 0
          sessions.clear()
          fingerprints.clear()
          fingerprintState.clear()
          globalBreaks.length = 0
          lastActiveSessionId = ''
          sendJson(res, 200, { ok: true, at: Date.now() })
          return
        }

        sendJson(res, 404, { ok: false, error: 'not-found', path })
      } catch (error) {
        try {
          sendJson(res, 500, { ok: false, error: 'internal', message: String(error?.message ?? error) })
        } catch { /* 响应已经发出去就算了 */ }
      }
    },
  }), 'cache-tuner: /api/cache-tuner routes')

  // -------------------------------------------------------------------------
  // 启动收尾
  // -------------------------------------------------------------------------
  // 读回持久化设置，然后按设置同步一次稳定器（不阻塞装配）。
  restore()
    .then(() => { applySuppression() })
    .catch(() => { applySuppression() })

  // 预热一次金额快照：这样第一次打开设置页/侧边栏就有读数，不必等一轮轮询。
  refreshSavings(true).catch(() => { /* 已在内部降级 */ })
}
