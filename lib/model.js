/**
 * ============================================================================
 * dsh-cache-tuner —— 纯逻辑层（pure logic）
 * ============================================================================
 *
 * 【为什么单独一个文件】
 *   这个文件不碰 cordis、不碰 HTTP、不碰文件系统，只做纯粹的输入→输出计算。
 *   好处有两个：
 *     1. `lib/verify.mjs` 可以直接 import 它做真实验证，不需要跑起整个 DSH；
 *     2. 宿主半侧（lib/index.js）只负责「取数据、喂进来、把结果广播出去」。
 *
 * 【它负责的三件事】
 *   A. 数据口径：promptTokens / hitRate / savedTokens 的定义与累加。
 *   B. 归因算法：对一次 prompt 装配结果做逐部件 sha1 指纹，并与上一次对比，
 *      得出「到底是谁变了」的中文描述。
 *   C. 设置净化与建议生成：坏值一律丢弃回落默认；由断点数据推出可执行建议。
 *
 * 【只依赖 node 内建模块】—— 不 import 任何 @deepseek-ai/*。
 * ============================================================================
 */
import { createHash } from 'node:crypto'

/** 每个会话最多保留多少条步记录（防止无限增长）。 */
export const MAX_STEPS_PER_SESSION = 500

/** 最多同时跟踪多少个会话（超出后淘汰最久未活跃的）。 */
export const MAX_SESSIONS = 50

/** 每个会话最多保留多少条断点记录。 */
export const MAX_BREAKS_PER_SESSION = 100

/** 全局断点环最多保留多少条。 */
export const MAX_BREAKS_GLOBAL = 200

/** 设置默认值（也是 sanitizeSettings 的兜底基准）。 */
export const DEFAULT_SETTINGS = Object.freeze({
  /** 总开关：关掉后不采集、不归因、不注册路由之外的动作。 */
  enabled: true,
  /**
   * 抑制动态运行上下文（默认关）。
   * 打开会调用 ctx.systemPrompt.suppressRuntimeContext()，把「当前时间」这类
   * 每次请求都变的 context 整体移除 —— 这是最常见的断点来源。
   * 代价：模型不再知道实时事实（当前时间、工作区状态等）。
   */
  suppressRuntimeContext: false,
  /**
   * 工具集稳定化（默认 true，但当前 DSH 版本下「不生效」）。
   * 原因见 lib/index.js 里的 capability 探测说明：DSH 的工具 provider 是
   * 「追加」语义且默认已按名字典序排序，再注册一个只会把工具复制一份。
   */
  stableTools: true,
  /** 每会话保留步数上限。 */
  maxStepsPerSession: MAX_STEPS_PER_SESSION,
  /** 跟踪会话数上限。 */
  maxSessions: MAX_SESSIONS,
  /** 每会话断点保留上限。 */
  maxBreaksPerSession: MAX_BREAKS_PER_SESSION,
})

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 非负整数收敛：NaN / Infinity / 负数 / 非数字一律变 0。 */
function toCount(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.round(n)
}

/** 把 0..1 的比率格式化成中文百分比。 */
export function formatPercent(rate) {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return '—'
  return `${(rate * 100).toFixed(1)}%`
}

/**
 * 环状写入：把 item 推进数组，超过 max 就从头丢弃。
 * 直接改原数组并返回它（宿主侧对同一数组持有引用）。
 */
export function pushCapped(array, item, max) {
  array.push(item)
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : array.length
  while (array.length > limit) array.shift()
  return array
}

/**
 * 有上限的 LRU 写入：写入 key，并把 key 挪到 Map 末尾（最新）。
 * 超出 max 时淘汰最旧的键，额外返回被淘汰的键名（没有则返回 null）。
 */
export function touchCapped(map, key, value, max) {
  if (map.has(key)) map.delete(key)
  map.set(key, value)
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : map.size
  if (map.size <= limit) return null
  const oldest = map.keys().next()
  if (oldest.done === true) return null
  map.delete(oldest.value)
  return oldest.value
}

/** 码位序比较：与机器 locale 无关，保证任何机器上结果一致。 */
function compareNames(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

/** 取两个普通对象的键并集，按码位序排序。 */
function unionKeys(a, b) {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])
  return [...keys].sort(compareNames)
}

// ---------------------------------------------------------------------------
// A. 数据口径
// ---------------------------------------------------------------------------

/** 一个空的聚合累加器。 */
export function emptyAggregate() {
  return {
    steps: 0,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    promptTokens: 0,
    savedTokens: 0,
  }
}

/**
 * 把一次 TokenUsage 累加进聚合器（原地修改并返回）。
 *
 * 口径（与需求一致）：
 *   promptTokens = inputTokens + cacheWriteTokens + cacheReadTokens
 *   savedTokens ≈ cacheReadTokens（缓存命中的输入远比新输入便宜）
 */
export function applyUsage(acc, usage) {
  const input = toCount(usage?.inputTokens)
  const cacheWrite = toCount(usage?.cacheWriteTokens)
  const cacheRead = toCount(usage?.cacheReadTokens)
  const output = toCount(usage?.outputTokens)
  const promptTokens = input + cacheWrite + cacheRead

  acc.steps += 1
  acc.input += input
  acc.cacheWrite += cacheWrite
  acc.cacheRead += cacheRead
  acc.output += output
  acc.promptTokens += promptTokens
  acc.savedTokens += cacheRead
  return acc
}

/**
 * 把聚合器收尾成对外 payload：补上 hitRate。
 * hitRate = cacheRead / promptTokens；分母为 0 时返回 null（而不是 NaN）。
 */
export function finalizeAggregate(acc) {
  const source = acc ?? emptyAggregate()
  const promptTokens = toCount(source.promptTokens)
  const cacheRead = toCount(source.cacheRead)
  return {
    steps: toCount(source.steps),
    promptTokens,
    cacheRead,
    cacheWrite: toCount(source.cacheWrite),
    input: toCount(source.input),
    output: toCount(source.output),
    savedTokens: toCount(source.savedTokens),
    hitRate: promptTokens > 0 ? cacheRead / promptTokens : null,
  }
}

/**
 * 生成一条步记录（对外展示用）。
 * provider/model 取自会话的 requestHeader()，取不到就留空串。
 */
export function makeStepRow(usage, meta = {}) {
  const input = toCount(usage?.inputTokens)
  const cacheWrite = toCount(usage?.cacheWriteTokens)
  const cacheRead = toCount(usage?.cacheReadTokens)
  const output = toCount(usage?.outputTokens)
  const promptTokens = input + cacheWrite + cacheRead
  return {
    at: Number.isFinite(meta.at) ? meta.at : Date.now(),
    turn: toCount(meta.turn),
    step: toCount(meta.step),
    provider: typeof meta.provider === 'string' ? meta.provider : '',
    model: typeof meta.model === 'string' ? meta.model : '',
    input,
    cacheRead,
    cacheWrite,
    output,
    promptTokens,
    savedTokens: cacheRead,
    hitRate: promptTokens > 0 ? cacheRead / promptTokens : null,
  }
}

// ---------------------------------------------------------------------------
// B. 归因算法
// ---------------------------------------------------------------------------

/** sha1 十六进制摘要（node:crypto）。 */
export function sha1(text) {
  return createHash('sha1').update(String(text ?? ''), 'utf8').digest('hex')
}

/**
 * 确定性 JSON 序列化：对象键一律排序后再输出。
 * 这样「同样的参数、只是键顺序不同」不会被误判成变化（避免假断点）。
 * 遇到循环引用返回 "[circular]" 占位，绝不抛错。
 */
export function stableStringify(value) {
  const seen = new Set()
  const walk = (node) => {
    if (node === null || typeof node !== 'object') {
      if (typeof node === 'number' && !Number.isFinite(node)) return 'null'
      if (typeof node === 'bigint') return JSON.stringify(String(node))
      if (typeof node === 'function') return '"[function]"'
      if (typeof node === 'undefined') return '"[undefined]"'
      return JSON.stringify(node)
    }
    if (seen.has(node)) return '"[circular]"'
    seen.add(node)
    let out
    if (Array.isArray(node)) {
      out = `[${node.map(walk).join(',')}]`
    } else {
      const keys = Object.keys(node).sort(compareNames)
      out = `{${keys.map((key) => `${JSON.stringify(key)}:${walk(node[key])}`).join(',')}}`
    }
    seen.delete(node)
    return out
  }
  try {
    return walk(value)
  } catch {
    return '"[unserializable]"'
  }
}

/**
 * 对一次 assemble() 的结果做逐部件指纹。
 *
 * 返回：
 *   sections: { [分区名]: sha1(文本) }
 *   contexts: { [上下文名]: sha1(文本) }
 *   tools:    { [工具名]: sha1(名字 + 描述 + 参数 JSON) }
 *
 * 说明：需求给的工具指纹口径是「name + parameters」，这里额外把 description
 * 也纳入哈希 —— 工具描述变了同样会让整段工具前缀失效，只哈希 name+parameters
 * 会漏报这类真实断点。
 */
export function fingerprintAssembly(assembly) {
  const sections = {}
  const contexts = {}
  const tools = {}

  for (const section of assembly?.sections ?? []) {
    if (section === null || typeof section !== 'object') continue
    if (typeof section.name !== 'string' || section.name === '') continue
    sections[section.name] = sha1(typeof section.text === 'string' ? section.text : String(section.text ?? ''))
  }
  for (const context of assembly?.contexts ?? []) {
    if (context === null || typeof context !== 'object') continue
    if (typeof context.name !== 'string' || context.name === '') continue
    contexts[context.name] = sha1(typeof context.text === 'string' ? context.text : String(context.text ?? ''))
  }
  for (const tool of assembly?.tools ?? []) {
    if (tool === null || typeof tool !== 'object') continue
    if (typeof tool.name !== 'string' || tool.name === '') continue
    const material = `${tool.name}\u0000${typeof tool.description === 'string' ? tool.description : ''}\u0000${stableStringify(tool.parameters ?? null)}`
    tools[tool.name] = sha1(material)
  }

  return { sections, contexts, tools }
}

/**
 * 对比两次指纹，得出「谁变了」。
 *
 * 【重要口径】变化分两类，代价差一个数量级：
 *   - **前缀变化**（section / tools）：这些东西真正位于系统提示词前缀里，
 *     一变，其后全部内容一起失去缓存。这是真金白银的断点。
 *   - **尾部变化**（context）：`systemPrompt.context()` 注册的动态运行上下文
 *     是以「尾部用户消息」下发的（"Current runtime context…"），不在前缀里，
 *     只影响尾巴那一小段。代价远小于前缀变化——不要把它当成缓存杀手。
 *
 * 返回：
 *   changed: 中文描述数组，例如 ['尾部 context "time" 文本变化', 'tools: 新增 foo']
 *   kinds:   各类变化的计数 {section, context, tool, prefix, tail}
 *   prefix:  是否发生了前缀变化（section 或 tools）
 *   empty:   是否无变化
 */
export function diffFingerprints(prev, next) {
  const before = {
    sections: prev?.sections ?? {},
    contexts: prev?.contexts ?? {},
    tools: prev?.tools ?? {},
  }
  const after = {
    sections: next?.sections ?? {},
    contexts: next?.contexts ?? {},
    tools: next?.tools ?? {},
  }

  const changed = []
  const kinds = { section: 0, context: 0, tool: 0, prefix: 0, tail: 0 }

  // 顺序固定为 section → context → tool，保证输出稳定可测。
  for (const name of unionKeys(before.sections, after.sections)) {
    const a = before.sections[name]
    const b = after.sections[name]
    if (a === undefined) { changed.push(`新增 section "${name}"`); kinds.section += 1; continue }
    if (b === undefined) { changed.push(`移除 section "${name}"`); kinds.section += 1; continue }
    if (a !== b) { changed.push(`section "${name}" 文本变化`); kinds.section += 1 }
  }
  for (const name of unionKeys(before.contexts, after.contexts)) {
    const a = before.contexts[name]
    const b = after.contexts[name]
    if (a === undefined) { changed.push(`尾部 context "${name}" 新增`); kinds.context += 1; continue }
    if (b === undefined) { changed.push(`尾部 context "${name}" 移除`); kinds.context += 1; continue }
    if (a !== b) { changed.push(`尾部 context "${name}" 文本变化`); kinds.context += 1 }
  }
  for (const name of unionKeys(before.tools, after.tools)) {
    const a = before.tools[name]
    const b = after.tools[name]
    if (a === undefined) { changed.push(`tools: 新增 ${name}`); kinds.tool += 1; continue }
    if (b === undefined) { changed.push(`tools: 移除 ${name}`); kinds.tool += 1; continue }
    if (a !== b) { changed.push(`tools: ${name} 定义变化`); kinds.tool += 1 }
  }

  kinds.prefix = kinds.section + kinds.tool
  kinds.tail = kinds.context

  return { changed, kinds, prefix: kinds.prefix > 0, empty: changed.length === 0 }
}

// ---------------------------------------------------------------------------
// C. 设置净化与建议
// ---------------------------------------------------------------------------

/**
 * 净化设置对象：只认识白名单里的键，类型不对就丢弃（保留 base 的原值），
 * 数字越界就夹紧到区间内。永远返回一个完整可用的设置对象。
 */
export function sanitizeSettings(input, base = DEFAULT_SETTINGS) {
  const out = {
    enabled: base?.enabled !== false,
    suppressRuntimeContext: base?.suppressRuntimeContext === true,
    stableTools: base?.stableTools !== false,
    maxStepsPerSession: toCount(base?.maxStepsPerSession) || MAX_STEPS_PER_SESSION,
    maxSessions: toCount(base?.maxSessions) || MAX_SESSIONS,
    maxBreaksPerSession: toCount(base?.maxBreaksPerSession) || MAX_BREAKS_PER_SESSION,
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return out

  const bool = (key) => { if (typeof input[key] === 'boolean') out[key] = input[key] }
  const clamp = (key, min, max) => {
    const value = Number(input[key])
    if (Number.isFinite(value)) {
      out[key] = Math.min(max, Math.max(min, Math.round(value)))
    }
  }

  bool('enabled')
  bool('suppressRuntimeContext')
  bool('stableTools')
  clamp('maxStepsPerSession', 50, 2000)
  clamp('maxSessions', 5, 200)
  clamp('maxBreaksPerSession', 10, 500)

  return out
}

/**
 * 由断点数据 + 命中率推出「下一步该做什么」的中文建议。
 * 这个函数的输出会原样出现在 /stats 的 notes 字段里。
 */
export function buildNotes(input = {}) {
  const options = input.options ?? DEFAULT_SETTINGS
  const breaks = Array.isArray(input.breaks) ? input.breaks : []
  const notes = []
  const recent = breaks.slice(-10)

  const counts = { section: 0, context: 0, tool: 0 }
  for (const item of recent) {
    const kinds = item?.kinds
    if (kinds === null || typeof kinds !== 'object') continue
    counts.section += toCount(kinds.section)
    counts.context += toCount(kinds.context)
    counts.tool += toCount(kinds.tool)
  }
  const total = counts.section + counts.context + counts.tool

  if (total > 0) {
    // 1) 前缀断点 —— 真正花钱的一类，先说。
    if (counts.tool > 0) {
      notes.push(`有 ${counts.tool} 处来自工具集变化：工具定义位于系统提示词前缀里，任何增删改都会让其后内容一起失去缓存，请避免在会话中途增删工具。`)
    }
    if (counts.section > 0) {
      notes.push(`有 ${counts.section} 处来自 section 文本变化：检查是否有插件在按请求改写系统提示词分区（前缀一变，其后全部失效）。`)
    }
    // 2) 尾部变化 —— 代价小得多，不要和前缀断点混为一谈。
    if (counts.context > 0) {
      notes.push(`另有 ${counts.context} 处是 context 变化：运行上下文以「尾部用户消息」下发，不在系统提示词前缀里，只影响尾巴那一小段，代价远小于前缀断点。`)
      if (options.suppressRuntimeContext === true) {
        notes.push('suppressRuntimeContext 已开启：它省的是提示词 token，不是缓存——不要指望它把命中率拉上去。')
      } else {
        notes.push('若目标是省 token（而非提命中率），可考虑打开 suppressRuntimeContext；代价是模型不再知道当前时间、工作区状态等实时事实。')
      }
    }
    // 3) 结论：区分"真断点"和"只是尾巴在动"。
    if (counts.section + counts.tool === 0) {
      notes.push('结论：目前记录到的变化全部落在尾部，系统提示词前缀是稳定的——命中率没有因为提示词改写而受损。')
    }
  } else if (breaks.length > 0) {
    notes.push(`已记录 ${breaks.length} 次变化，但没有一次能归因到具体的 section / context / 工具。`)
  } else {
    notes.push('暂未记录到提示词变化。')
  }

  // 命中率层面的建议。
  const hitRate = input.hitRate
  const steps = toCount(input.steps)
  if (typeof hitRate === 'number' && Number.isFinite(hitRate)) {
    const pct = formatPercent(hitRate)
    if (hitRate >= 0.8) {
      notes.push(`当前命中率 ${pct}，提示词前缀已经相当稳定。`)
    } else if (hitRate < 0.3 && steps >= 5) {
      notes.push(`当前命中率 ${pct}（共 ${steps} 步），偏低：确认同一会话内提示词前缀是否稳定，以及是否频繁切换 provider / model。`)
    } else if (steps < 5) {
      notes.push(`当前命中率 ${pct}，样本只有 ${steps} 步，还不足以判断趋势。`)
    }
  } else if (steps === 0) {
    notes.push('还没有采集到任何带 usage 的步，暂时算不出命中率。')
  }

  // 能力降级提示。
  if (input.capabilities?.scope === false) {
    notes.push('⚠ 当前未能获取会话作用域，指纹只覆盖全局提示词：会话级 scoped 分区与上下文未纳入归因。')
  }

  return notes
}
