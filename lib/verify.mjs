#!/usr/bin/env node
/**
 * ============================================================================
 * dsh-cache-tuner —— 纯逻辑验证脚本
 * ============================================================================
 *
 * 这是一个**普通 node 脚本**：不用任何测试框架（没有 mocha / jest / vitest），
 * 只 import 同目录的 ./model.js，把里面的纯函数逐个跑一遍真实断言。
 *
 * 运行：  node lib/verify.mjs
 * 退出码：全部通过 = 0；有任何一条失败 = 1（方便接进 CI / 安装前的自检）。
 *
 * 覆盖范围：
 *   1. sha1 / stableStringify 的确定性与容错
 *   2. 指纹生成与「谁变了」的归因 diff
 *   3. 数据口径：promptTokens / hitRate / savedTokens
 *   4. 设置净化：坏类型丢弃、数字夹紧
 *   5. 建议生成：由断点数据推出可执行建议
 *   6. 环状写入 / LRU 淘汰的上限纪律
 *   7. 一个端到端场景：time 上下文每步都变 → 应当被精确归因
 * ============================================================================
 */
import {
  DEFAULT_SETTINGS,
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
  sha1,
  stableStringify,
  touchCapped,
} from './model.js'

// ---------------------------------------------------------------------------
// 极简断言工具
// ---------------------------------------------------------------------------
let passed = 0
const failures = []
let currentGroup = '（未分组）'

function group(title) {
  currentGroup = title
  console.log(`\n▍${title}`)
}

/** 把任意值渲染成可读字符串（JSON.stringify 对 undefined 返回 undefined）。 */
function show(value) {
  if (typeof value === 'undefined') return 'undefined'
  try {
    const text = JSON.stringify(value)
    return typeof text === 'string' ? text : String(value)
  } catch {
    return String(value)
  }
}

function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    const message = String(error?.message ?? error)
    failures.push({ group: currentGroup, name, message })
    console.log(`  ✗ ${name}`)
    console.log(`      ${message}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertEqual(actual, expected, label = '值不相等') {
  const a = show(actual)
  const b = show(expected)
  if (a !== b) throw new Error(`${label}：期望 ${b}，实际 ${a}`)
}

function assertIncludes(haystack, needle, label = '未包含期望的片段') {
  const text = Array.isArray(haystack) ? haystack.join('\n') : String(haystack ?? '')
  if (!text.includes(needle)) throw new Error(`${label}：${show(needle)} 不在 ${show(text)} 中`)
}

// ---------------------------------------------------------------------------
// 1. 指纹基础工具
// ---------------------------------------------------------------------------
group('1. 指纹基础工具（sha1 / stableStringify）')

test('sha1 对已知输入给出标准摘要', () => {
  assertEqual(sha1('abc'), 'a9993e364706816aba3e25717850c26c9cd0d89d', 'sha1("abc")')
  assertEqual(sha1(''), 'da39a3ee5e6b4b0d3255bfef95601890afd80709', 'sha1("")')
})

test('sha1 对 null/undefined/数字都不抛错且结果稳定', () => {
  assertEqual(sha1(null), sha1(''), 'sha1(null) 应等于 sha1("")')
  assertEqual(sha1(undefined), sha1(''), 'sha1(undefined) 应等于 sha1("")')
  assertEqual(sha1(42), sha1('42'), 'sha1(42) 应等于 sha1("42")')
})

test('stableStringify 与对象键的书写顺序无关', () => {
  const a = stableStringify({ b: 1, a: 2, c: { z: 1, y: 2 } })
  const b = stableStringify({ c: { y: 2, z: 1 }, a: 2, b: 1 })
  assertEqual(a, b, '键顺序不同不应产生不同字符串')
})

test('stableStringify 保留数组顺序（数组顺序是有意义的）', () => {
  assert(stableStringify([1, 2]) !== stableStringify([2, 1]), '数组顺序不同应当产生不同字符串')
})

test('stableStringify 遇到循环引用不抛错', () => {
  const node = { name: 'x' }
  node.self = node
  const text = stableStringify(node)
  assertIncludes(text, '[circular]', '循环引用应降级为占位符')
})

test('stableStringify 处理非法数字与 undefined', () => {
  assertIncludes(stableStringify({ n: Number.NaN }), 'null', 'NaN 应降级为 null')
  assertIncludes(stableStringify({ n: Number.POSITIVE_INFINITY }), 'null', 'Infinity 应降级为 null')
  assertIncludes(stableStringify({ u: undefined }), '[undefined]', 'undefined 应有占位符')
})

// ---------------------------------------------------------------------------
// 2. 指纹生成
// ---------------------------------------------------------------------------
group('2. 指纹生成（fingerprintAssembly）')

const baseAssembly = () => ({
  sections: [
    { name: 'base', text: '你是 DeepSeek Harness 助手。' },
    { name: 'tools-guide', text: '工具使用说明。' },
  ],
  contexts: [
    { name: 'time', text: '当前时间 2026-10-07T12:00:00+08:00' },
    { name: 'workspace', text: '工作目录 /home/user/project' },
  ],
  tools: [
    { name: 'read', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
    { name: 'write', description: '写文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  ],
})

test('逐部件生成指纹，键为部件名', () => {
  const fp = fingerprintAssembly(baseAssembly())
  assertEqual(Object.keys(fp.sections).sort(), ['base', 'tools-guide'], 'sections 键')
  assertEqual(Object.keys(fp.contexts).sort(), ['time', 'workspace'], 'contexts 键')
  assertEqual(Object.keys(fp.tools).sort(), ['read', 'write'], 'tools 键')
  for (const name of Object.keys(fp.sections)) {
    assert(/^[0-9a-f]{40}$/.test(fp.sections[name]), `sections["${name}"] 应是 40 位十六进制 sha1`)
  }
})

test('工具参数只是键顺序不同 → 指纹不变（不产生假断点）', () => {
  const a = fingerprintAssembly({
    tools: [{ name: 'read', description: 'd', parameters: { type: 'object', properties: { p: { type: 'string' } } } }],
  })
  const b = fingerprintAssembly({
    tools: [{ name: 'read', description: 'd', parameters: { properties: { p: { type: 'string' } }, type: 'object' } }],
  })
  assertEqual(a.tools.read, b.tools.read, '参数键顺序不应影响工具指纹')
})

test('缺字段 / 类型不对的条目被安全跳过', () => {
  const fp = fingerprintAssembly({
    sections: [null, { text: '没有名字' }, { name: 'good', text: 'ok' }],
    contexts: [{ name: '', text: 'x' }, { name: 'c', text: 'y' }],
    tools: [{ name: 'ok-tool', description: 'd', parameters: {} }, 'not-an-object'],
  })
  assertEqual(Object.keys(fp.sections), ['good'], 'sections 只保留合法项')
  assertEqual(Object.keys(fp.contexts), ['c'], 'contexts 只保留合法项')
  assertEqual(Object.keys(fp.tools), ['ok-tool'], 'tools 只保留合法项')
})

test('assemble() 返回空/undefined 时不抛错', () => {
  const fp = fingerprintAssembly(undefined)
  assertEqual(fp, { sections: {}, contexts: {}, tools: {} }, '空输入应得到空指纹')
  assertEqual(diffFingerprints(undefined, undefined).empty, true, '空指纹对比应为「无变化」')
})

// ---------------------------------------------------------------------------
// 3. 归因 diff —— 本插件的核心
// ---------------------------------------------------------------------------
group('3. 归因 diff（diffFingerprints）')

test('完全相同的两次装配 → 无变化', () => {
  const diff = diffFingerprints(fingerprintAssembly(baseAssembly()), fingerprintAssembly(baseAssembly()))
  assertEqual(diff.empty, true, 'empty')
  assertEqual(diff.changed, [], 'changed')
})

test('context 文本变化 → 精确指出是哪个 context（并标为尾部）', () => {
  const before = fingerprintAssembly(baseAssembly())
  const next = baseAssembly()
  next.contexts[0].text = '当前时间 2026-10-07T12:00:05+08:00'
  const diff = diffFingerprints(before, fingerprintAssembly(next))
  assertEqual(diff.changed, ['尾部 context "time" 文本变化'], 'changed')
  assertEqual(diff.kinds, { section: 0, context: 1, tool: 0, prefix: 0, tail: 1 }, 'kinds')
  assertEqual(diff.prefix, false, '纯 context 变化不算前缀断点')
})

test('工具新增 → tools: 新增 <名字>', () => {
  const before = fingerprintAssembly(baseAssembly())
  const next = baseAssembly()
  next.tools.push({ name: 'foo', description: '新工具', parameters: { type: 'object' } })
  const diff = diffFingerprints(before, fingerprintAssembly(next))
  assertEqual(diff.changed, ['tools: 新增 foo'], 'changed')
  assertEqual(diff.kinds.tool, 1, 'kinds.tool')
})

test('工具移除 → tools: 移除 <名字>', () => {
  const before = fingerprintAssembly(baseAssembly())
  const next = baseAssembly()
  next.tools = next.tools.filter((tool) => tool.name !== 'write')
  const diff = diffFingerprints(before, fingerprintAssembly(next))
  assertEqual(diff.changed, ['tools: 移除 write'], 'changed')
})

test('工具描述变化 → tools: <名字> 定义变化', () => {
  const before = fingerprintAssembly(baseAssembly())
  const next = baseAssembly()
  next.tools[0].description = '读文件（描述改了）'
  const diff = diffFingerprints(before, fingerprintAssembly(next))
  assertEqual(diff.changed, ['tools: read 定义变化'], 'changed')
})

test('section 文本变化 → section "<名字>" 文本变化', () => {
  const before = fingerprintAssembly(baseAssembly())
  const next = baseAssembly()
  next.sections[1].text = '工具使用说明（改了）。'
  const diff = diffFingerprints(before, fingerprintAssembly(next))
  assertEqual(diff.changed, ['section "tools-guide" 文本变化'], 'changed')
})

test('同时多处变化时输出顺序稳定（section → context → tool）', () => {
  const before = fingerprintAssembly(baseAssembly())
  const next = baseAssembly()
  next.sections[0].text = '改了'
  next.contexts[0].text = '也改了'
  next.tools.push({ name: 'zzz', description: 'd', parameters: {} })
  const diff = diffFingerprints(before, fingerprintAssembly(next))
  assertEqual(diff.changed, [
    'section "base" 文本变化',
    '尾部 context "time" 文本变化',
    'tools: 新增 zzz',
  ], 'changed 顺序')
  assertEqual(diff.kinds, { section: 1, context: 1, tool: 1, prefix: 2, tail: 1 }, 'kinds')
  assertEqual(diff.prefix, true, '含 section/tool 变化即为前缀断点')
})

test('新增 / 移除 section 与 context 都能被识别', () => {
  const before = fingerprintAssembly(baseAssembly())
  const next = baseAssembly()
  next.sections.push({ name: 'extra', text: '新分区' })
  next.contexts = []
  const diff = diffFingerprints(before, fingerprintAssembly(next))
  assertEqual(diff.changed, [
    '新增 section "extra"',
    '尾部 context "time" 移除',
    '尾部 context "workspace" 移除',
  ], 'changed')
})

// ---------------------------------------------------------------------------
// 4. 数据口径
// ---------------------------------------------------------------------------
group('4. 数据口径（token / hitRate）')

test('promptTokens = inputTokens + cacheWriteTokens + cacheReadTokens', () => {
  const row = makeStepRow({ inputTokens: 100, cacheWriteTokens: 200, cacheReadTokens: 700, outputTokens: 50 })
  assertEqual(row.promptTokens, 1000, 'promptTokens')
  assertEqual(row.hitRate, 0.7, 'hitRate = 700/1000')
  assertEqual(row.savedTokens, 700, 'savedTokens ≈ cacheRead')
})

test('缺少 cache 字段时按 0 处理，不产生 NaN', () => {
  const row = makeStepRow({ inputTokens: 30, outputTokens: 5 })
  assertEqual(row.promptTokens, 30, 'promptTokens')
  assertEqual(row.cacheRead, 0, 'cacheRead')
  assertEqual(row.hitRate, 0, 'hitRate 应为 0（分母 30 > 0）')
})

test('usage 完全缺失 / 全是坏值时 hitRate 为 null（而不是 NaN）', () => {
  assertEqual(makeStepRow(undefined).hitRate, null, 'undefined usage')
  assertEqual(makeStepRow({ inputTokens: -5, cacheReadTokens: Number.NaN }).hitRate, null, '负数/NaN 全部归零')
  assertEqual(makeStepRow({ inputTokens: -5 }).promptTokens, 0, '负 token 应归零')
})

test('finalizeAggregate 在分母为 0 时给出 null 命中率', () => {
  const empty = finalizeAggregate(emptyAggregate())
  assertEqual(empty.hitRate, null, 'hitRate')
  assertEqual(empty.steps, 0, 'steps')
  assertEqual(empty.promptTokens, 0, 'promptTokens')
})

test('多次 usage 累加后命中率按总量计算（不是各步平均）', () => {
  const acc = emptyAggregate()
  applyUsage(acc, { inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10 })
  applyUsage(acc, { inputTokens: 0, cacheReadTokens: 9000, cacheWriteTokens: 0, outputTokens: 10 })
  const out = finalizeAggregate(acc)
  assertEqual(out.steps, 2, 'steps')
  assertEqual(out.promptTokens, 10000, 'promptTokens')
  assertEqual(out.cacheRead, 9000, 'cacheRead')
  assertEqual(out.hitRate, 0.9, 'hitRate 应为 9000/10000')
  assertEqual(out.savedTokens, 9000, 'savedTokens')
  assertEqual(out.output, 20, 'output')
})

test('finalizeAggregate 输出包含对外承诺的全部字段', () => {
  const out = finalizeAggregate(emptyAggregate())
  for (const key of ['steps', 'promptTokens', 'cacheRead', 'cacheWrite', 'output', 'hitRate', 'savedTokens']) {
    assert(Object.prototype.hasOwnProperty.call(out, key), `缺少字段 ${key}`)
  }
})

test('formatPercent 对 null / NaN 给出占位符', () => {
  assertEqual(formatPercent(0.9732), '97.3%', 'formatPercent(0.9732)')
  assertEqual(formatPercent(1), '100.0%', 'formatPercent(1)')
  assertEqual(formatPercent(null), '—', 'formatPercent(null)')
  assertEqual(formatPercent(Number.NaN), '—', 'formatPercent(NaN)')
})

test('真实计费场景：首轮冷启动 + 随后 9 轮各命中 99%', () => {
  const acc = emptyAggregate()
  // 第 1 轮：提示词 10000，全部是新输入（其中 5000 写进前缀缓存），完全没有命中。
  applyUsage(acc, { inputTokens: 5000, cacheWriteTokens: 5000, cacheReadTokens: 0, outputTokens: 100 })
  // 第 2~10 轮：提示词同样是 10000，其中 9900 命中缓存。
  for (let i = 0; i < 9; i += 1) {
    applyUsage(acc, { inputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 9900, outputTokens: 60 })
  }
  const out = finalizeAggregate(acc)
  assertEqual(out.steps, 10, 'steps')
  assertEqual(out.promptTokens, 100000, 'promptTokens = 10 轮 × 10000')
  assertEqual(out.cacheRead, 89100, 'cacheRead = 9 × 9900')
  assertEqual(out.savedTokens, 89100, 'savedTokens ≈ cacheRead')
  // 整体命中率按总量算：89100 / 100000 = 0.891（不是各轮 99% 的简单平均）。
  assert(Math.abs(out.hitRate - 0.891) < 1e-12, `整体命中率应为 0.891，实际 ${out.hitRate}`)
  assert(out.hitRate < 0.99, '整体命中率必然低于单轮命中率，因为首轮是冷的')
})

// ---------------------------------------------------------------------------
// 5. 设置净化
// ---------------------------------------------------------------------------
group('5. 设置净化（sanitizeSettings）')

test('非对象输入回落到默认值', () => {
  assertEqual(sanitizeSettings(null), { ...DEFAULT_SETTINGS }, 'null')
  assertEqual(sanitizeSettings('nope'), { ...DEFAULT_SETTINGS }, 'string')
  assertEqual(sanitizeSettings([1, 2]), { ...DEFAULT_SETTINGS }, 'array')
})

test('布尔字段只接受真正的 boolean，坏类型保留基准值', () => {
  const out = sanitizeSettings({ enabled: 'yes', suppressRuntimeContext: 1, stableTools: 0 }, DEFAULT_SETTINGS)
  assertEqual(out.enabled, true, 'enabled 应保留基准值 true')
  assertEqual(out.suppressRuntimeContext, false, 'suppressRuntimeContext 应保留基准值 false')
  assertEqual(out.stableTools, true, 'stableTools 应保留基准值 true')
})

test('合法布尔值被采纳', () => {
  const out = sanitizeSettings({ enabled: false, suppressRuntimeContext: true }, DEFAULT_SETTINGS)
  assertEqual(out.enabled, false, 'enabled')
  assertEqual(out.suppressRuntimeContext, true, 'suppressRuntimeContext')
})

test('数字字段越界被夹紧到区间内', () => {
  const out = sanitizeSettings({ maxStepsPerSession: 999999, maxSessions: 1, maxBreaksPerSession: -10 }, DEFAULT_SETTINGS)
  assertEqual(out.maxStepsPerSession, 2000, 'maxStepsPerSession 上限 2000')
  assertEqual(out.maxSessions, 5, 'maxSessions 下限 5')
  assertEqual(out.maxBreaksPerSession, 10, 'maxBreaksPerSession 下限 10')
})

test('数字字段被取整，NaN/"abc" 等坏值被丢弃', () => {
  const out = sanitizeSettings({ maxStepsPerSession: 123.7, maxSessions: 'abc', maxBreaksPerSession: Number.NaN }, DEFAULT_SETTINGS)
  assertEqual(out.maxStepsPerSession, 124, 'maxStepsPerSession 应四舍五入')
  assertEqual(out.maxSessions, DEFAULT_SETTINGS.maxSessions, 'maxSessions 坏值应回落')
  assertEqual(out.maxBreaksPerSession, DEFAULT_SETTINGS.maxBreaksPerSession, 'maxBreaksPerSession 坏值应回落')
})

test('未知键被丢弃（净化结果里不会夹带私货）', () => {
  const out = sanitizeSettings({ enabled: true, evil: '<script>', __proto__: { polluted: true } }, DEFAULT_SETTINGS)
  assertEqual(Object.keys(out).sort(), [
    'enabled', 'maxBreaksPerSession', 'maxSessions', 'maxStepsPerSession', 'stableTools', 'suppressRuntimeContext',
  ], '净化后的键集合应恰好是白名单')
  assertEqual(out.evil, undefined, 'evil 应被丢弃')
})

test('净化永远返回完整对象（即使基准值也不完整）', () => {
  const out = sanitizeSettings({}, {})
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    assert(Object.prototype.hasOwnProperty.call(out, key), `缺少字段 ${key}`)
  }
})

// ---------------------------------------------------------------------------
// 6. 建议生成
// ---------------------------------------------------------------------------
group('6. 建议生成（buildNotes）')

/** 造一条断点记录。 */
function makeBreak(kinds, changed) {
  return { turn: 1, step: 1, reason: 'step/start', changed, kinds }
}

test('没有变化 → 明确说暂未记录', () => {
  const notes = buildNotes({ options: DEFAULT_SETTINGS, breaks: [], hitRate: null, steps: 0 })
  assertIncludes(notes, '暂未记录到提示词变化', 'notes')
})

test('只有尾部 context 变化 → 明确说明前缀稳定，且不把它说成缓存杀手', () => {
  const breaks = [
    makeBreak({ section: 0, context: 1, tool: 0 }, ['尾部 context "time" 文本变化']),
    makeBreak({ section: 0, context: 1, tool: 0 }, ['尾部 context "time" 文本变化']),
    makeBreak({ section: 0, context: 1, tool: 0 }, ['尾部 context "time" 文本变化']),
  ]
  const notes = buildNotes({ options: { ...DEFAULT_SETTINGS, suppressRuntimeContext: false }, breaks, hitRate: 0.2, steps: 10 })
  assertIncludes(notes, '另有 3 处是 context 变化', 'notes 应带上计数')
  assertIncludes(notes, '不在系统提示词前缀里', 'notes 应说明尾部语义')
  assertIncludes(notes, '系统提示词前缀是稳定的', 'notes 应给出前缀稳定结论')
  assertIncludes(notes, '省 token', 'notes 应把 suppressRuntimeContext 说成省 token 而非提命中率')
  if (notes.join('\n').includes('可考虑打开 suppressRuntimeContext（代价')) {
    throw new Error('不应再出现"提命中率"口径的旧建议：' + JSON.stringify(notes))
  }
})

test('抑制已开且只有尾部变化 → 明确它省的是 token 不是缓存', () => {
  const breaks = [makeBreak({ section: 0, context: 2, tool: 0 }, ['尾部 context "time" 文本变化'])]
  const notes = buildNotes({ options: { ...DEFAULT_SETTINGS, suppressRuntimeContext: true }, breaks, hitRate: 0.5, steps: 6 })
  assertIncludes(notes, '它省的是提示词 token，不是缓存', 'notes')
})

test('工具集变化 → 给出「不要在会话中途增删工具」的建议', () => {
  const breaks = [makeBreak({ section: 0, context: 0, tool: 3 }, ['tools: 新增 foo'])]
  const notes = buildNotes({ options: DEFAULT_SETTINGS, breaks, hitRate: 0.4, steps: 8 })
  assertIncludes(notes, '避免在会话中途增删工具', 'notes')
})

test('拿不到会话作用域 → 明确标注归因降级', () => {
  const notes = buildNotes({
    options: DEFAULT_SETTINGS,
    breaks: [],
    hitRate: 0.5,
    steps: 3,
    capabilities: { scope: false },
  })
  assertIncludes(notes, '未能获取会话作用域', 'notes')
})

test('高命中率 → 给出「前缀已经相当稳定」的正反馈', () => {
  const notes = buildNotes({ options: DEFAULT_SETTINGS, breaks: [], hitRate: 0.92, steps: 30 })
  assertIncludes(notes, '已经相当稳定', 'notes')
})

test('低命中率且样本足够 → 提示检查前缀稳定性', () => {
  const notes = buildNotes({ options: DEFAULT_SETTINGS, breaks: [], hitRate: 0.05, steps: 20 })
  assertIncludes(notes, '偏低', 'notes')
})

test('样本过少 → 明确说明还不足以判断趋势', () => {
  const notes = buildNotes({ options: DEFAULT_SETTINGS, breaks: [], hitRate: 0.05, steps: 2 })
  assertIncludes(notes, '还不足以判断趋势', 'notes')
})

test('坏数据（kinds 缺失 / 元素为 null）不会让建议生成崩溃', () => {
  const notes = buildNotes({ options: DEFAULT_SETTINGS, breaks: [null, {}, { kinds: 'x' }], hitRate: 0.5, steps: 4 })
  assert(Array.isArray(notes) && notes.length > 0, '仍应产出建议')
})

// ---------------------------------------------------------------------------
// 7. 上限纪律
// ---------------------------------------------------------------------------
group('7. 上限纪律（pushCapped / touchCapped）')

test('pushCapped 超出上限时丢弃最旧的', () => {
  const list = []
  for (let i = 0; i < 10; i += 1) pushCapped(list, i, 3)
  assertEqual(list, [7, 8, 9], '应只保留最后 3 条')
})

test('pushCapped 上限非法时不丢数据', () => {
  const list = []
  pushCapped(list, 1, 0)
  pushCapped(list, 2, Number.NaN)
  assertEqual(list, [1, 2], '非法上限应视为不限制')
})

test('touchCapped 超出上限时淘汰最旧的键并返回它', () => {
  const map = new Map()
  assertEqual(touchCapped(map, 'a', 1, 2), null, '未超限时返回 null')
  touchCapped(map, 'b', 2, 2)
  assertEqual(touchCapped(map, 'c', 3, 2), 'a', '应淘汰最旧的 a')
  assertEqual([...map.keys()], ['b', 'c'], '剩余键')
})

test('touchCapped 重复写入同一键会把它刷新到最新（LRU 语义）', () => {
  const map = new Map()
  touchCapped(map, 'a', 1, 2)
  touchCapped(map, 'b', 2, 2)
  touchCapped(map, 'a', 3, 2)
  assertEqual(touchCapped(map, 'c', 4, 2), 'b', 'a 被刷新后，应淘汰 b')
  assertEqual(map.get('a'), 3, 'a 的值应被更新')
})

// ---------------------------------------------------------------------------
// 8. 端到端：一个真实断点场景
// ---------------------------------------------------------------------------
group('8. 端到端场景：time 上下文每步都变')

test('每步只有 time 变化 → 每步恰好产生一条断点，且归因指向 time', () => {
  const record = { breaks: [] }
  let previous = null

  const tick = (timeText, turn) => {
    const assembly = {
      sections: [{ name: 'base', text: '你是助手。' }],
      contexts: [
        { name: 'time', text: timeText },
        { name: 'workspace', text: '工作目录 C:\\work' },
      ],
      tools: [{ name: 'read', description: '读文件', parameters: { type: 'object' } }],
    }
    const snapshot = fingerprintAssembly(assembly)
    if (previous !== null) {
      const diff = diffFingerprints(previous, snapshot)
      if (!diff.empty) {
        record.breaks.push({ turn, step: 1, reason: 'step/start', changed: diff.changed, kinds: diff.kinds, prefix: diff.prefix })
      }
    }
    previous = snapshot
  }

  tick('2026-10-07T12:00:00+08:00', 1)
  tick('2026-10-07T12:00:05+08:00', 2)
  tick('2026-10-07T12:00:10+08:00', 3)
  tick('2026-10-07T12:00:15+08:00', 4)

  assertEqual(record.breaks.length, 3, '第 1 步建立基线，之后 3 步各产生 1 条断点')
  for (const item of record.breaks) {
    assertEqual(item.changed, ['尾部 context "time" 文本变化'], '每一步的归因都应当只指向 time')
    assertEqual(item.kinds, { section: 0, context: 1, tool: 0, prefix: 0, tail: 1 }, 'kinds')
    assertEqual(item.prefix, false, '纯尾部变化不是前缀断点')
  }

  const notes = buildNotes({
    options: { ...DEFAULT_SETTINGS, suppressRuntimeContext: false },
    breaks: record.breaks,
    hitRate: 0.35,
    steps: 4,
    capabilities: { scope: true },
  })
  assertIncludes(notes, '系统提示词前缀是稳定的', '端到端结论应指出前缀没被破坏')
  assertIncludes(notes, '省 token', '端到端建议应保持"省 token 而非提命中率"的口径')
})

test('前缀完全稳定 → 零断点，并且不会被误报', () => {
  const record = { breaks: [] }
  let previous = null
  for (let i = 0; i < 5; i += 1) {
    const snapshot = fingerprintAssembly({
      sections: [{ name: 'base', text: '你是助手。' }],
      contexts: [{ name: 'workspace', text: '工作目录 C:\\work' }],
      tools: [{ name: 'read', description: '读文件', parameters: { type: 'object' } }],
    })
    if (previous !== null) {
      const diff = diffFingerprints(previous, snapshot)
      if (!diff.empty) record.breaks.push(diff)
    }
    previous = snapshot
  }
  assertEqual(record.breaks.length, 0, '稳定前缀不应产生任何断点')
})

test('打开 suppressRuntimeContext 后 context 消失 → 尾部变化停止，且不算前缀断点', () => {
  const withTime = () => fingerprintAssembly({
    sections: [{ name: 'base', text: '你是助手。' }],
    contexts: [{ name: 'time', text: '12:00:00' }],
    tools: [],
  })
  // 模拟 suppressRuntimeContext：assemble() 里的 contexts 变成空数组。
  const suppressed = () => fingerprintAssembly({
    sections: [{ name: 'base', text: '你是助手。' }],
    contexts: [],
    tools: [],
  })

  const first = diffFingerprints(withTime(), suppressed())
  assertEqual(first.changed, ['尾部 context "time" 移除'], '抑制生效的那一步会产生一次「尾部 context 移除」')
  assertEqual(first.prefix, false, '移除运行上下文不是前缀断点')

  const second = diffFingerprints(suppressed(), suppressed())
  assertEqual(second.empty, true, '抑制之后前缀稳定，不再产生变化')
})

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
console.log('\n' + '─'.repeat(64))
if (failures.length === 0) {
  console.log(`✅ 全部通过：${passed} 项断言组，0 失败。`)
  process.exit(0)
} else {
  console.log(`❌ 失败 ${failures.length} 项 / 通过 ${passed} 项：`)
  for (const item of failures) {
    console.log(`   · [${item.group}] ${item.name}`)
    console.log(`     ${item.message}`)
  }
  process.exit(1)
}
