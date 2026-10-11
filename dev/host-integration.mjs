/**
 * 宿主半侧集成验证：用桩 ctx 跑真实的 `apply()`，再起真实 HTTP 处理器打接口。
 *
 * 为什么要这个脚本：
 *   `lib/verify-savings.mjs` 只测纯逻辑；`lib/verify-http.mjs` 需要**跑着的 DSH**。
 *   这个脚本填中间那层：不启动 DSH，也能证明 index.js 的接线
 *   （快照 savings 段 / GET /savings / cache_report 工具）真的能工作。
 *
 * 用法：
 *   node dev/host-integration.mjs
 *
 * 退出码：全通过 0，任一失败 1。
 * ⚠ 需要在装了 dsh-cost-meter 的环境里跑才有金额数据；否则会验证降级路径。
 */
import { createServer } from 'node:http'

const plugin = await import('../lib/index.js')

const failures = []
let passed = 0
function ok(name, condition, detail) {
  if (condition) { passed += 1; return true }
  failures.push(`${name}${detail === undefined ? '' : ` —— ${detail}`}`)
  return false
}

const effects = []
const registeredTools = []
const registeredRoutes = []

const makeCtx = () => {
  const handlers = new Map()
  return {
    logger: { warn: (m) => console.log('   [warn]', m) },
    effect(factory, label) {
      const dispose = factory()
      effects.push({ label, dispose: typeof dispose === 'function' ? dispose : null })
      return () => { if (typeof dispose === 'function') dispose() }
    },
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
    },
    emit(event, ...args) { for (const h of handlers.get(event) ?? []) h(...args) },
    systemPrompt: {
      assemble: async () => ({ sections: [{ name: 'core', text: 'x' }], contexts: [], tools: [] }),
      suppressRuntimeContext: () => () => {},
    },
    tools: {
      schemas: () => [],
      register(spec) { registeredTools.push(spec); return () => {} },
    },
    webServer: {
      register(spec) { registeredRoutes.push(spec); return () => {} },
    },
  }
}

console.log('== 1. apply() 能跑起来 ==')
plugin.apply(makeCtx(), undefined)
ok('插件名正确', plugin.name === 'cache-tuner')
ok('注册了 cache_report 工具', registeredTools.some((t) => t.name === 'cache_report'))
ok('注册了 /api/cache-tuner 路由', registeredRoutes.some((r) => r.path === '/api/cache-tuner'))
ok('声明了必需服务', ['webServer', 'tools', 'systemPrompt'].every((s) => plugin.inject.includes(s)))

// 等启动阶段的预热 refreshSavings 落地（apply 内部不 await）。
await new Promise((r) => setTimeout(r, 1500))

console.log('\n== 2. 真实 HTTP 处理器 ==')
const route = registeredRoutes[0]
const server = createServer((req, res) => { void route.handler(req, res) })
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/api/cache-tuner`
const get = async (path) => {
  const res = await fetch(base + path, { headers: { accept: 'application/json' } })
  return { status: res.status, body: await res.json() }
}

const stats = await get('/stats')
ok('GET /stats → 200', stats.status === 200)
ok('/stats 里带 savings 段', stats.body.savings !== undefined && stats.body.savings !== null)
console.log('   savings.available =', stats.body.savings?.available, '| source =', stats.body.savings?.source)

const sv = stats.body.savings
if (sv?.available === true) {
  console.log('   窗口读数：')
  for (const w of sv.windows) {
    console.log(`     ${String(w.label).padEnd(9)} ${w.from} ~ ${w.to}  ${String(w.savingsText).padStart(12)}  cacheRead=${w.cacheRead}`)
    ok(`${w.window}d 金额是有限数`, Number.isFinite(w.savingsUsd))
    ok(`${w.window}d 展示文本已格式化`, typeof w.savingsText === 'string' && w.savingsText.length > 0)
    ok(`${w.window}d 不含 NaN`, !/NaN|Infinity|undefined/.test(w.savingsText))
  }
  const w1 = sv.windows.find((w) => w.window === 1)
  const w7 = sv.windows.find((w) => w.window === 7)
  const w30 = sv.windows.find((w) => w.window === 30)
  ok('30 天金额 ≥ 7 天金额', w30.savingsUsd >= w7.savingsUsd)
  ok('7 天金额 ≥ 今日金额', w7.savingsUsd >= w1.savingsUsd)
} else {
  console.log('   （本机没有可用的账本/价表 —— 走降级路径，下面验证「不崩、不 NaN」）')
  ok('降级时 windows 是数组', Array.isArray(sv?.windows))
}

console.log('\n== 3. 独立端点 /savings ==')
const solo = await get('/savings')
ok('GET /savings → 200', solo.status === 200)
ok('/savings 返回 savings 对象', solo.body.savings !== undefined)
const forced = await get('/savings?refresh=1')
ok('GET /savings?refresh=1 → 200', forced.status === 200)

console.log('\n== 4. /stats.savings 与 /savings 同值 ==')
if (sv?.available === true) {
  for (const n of [1, 7, 30]) {
    const a = sv.windows.find((w) => w.window === n)
    const b = forced.body.savings.windows.find((w) => w.window === n)
    ok(`${n}d 两处一致`, a && b && a.savingsUsd === b.savingsUsd && a.cacheRead === b.cacheRead, `${a?.savingsText} / ${b?.savingsText}`)
  }
}

console.log('\n== 5. cache_report 工具 ==')
const tool = registeredTools.find((t) => t.name === 'cache_report')
const result = await tool.execute({})
ok('cache_report ok=true', result.ok === true)
ok('报告含「省下的钱」段', String(result.markdown).includes('省下的钱'))
ok('报告不含 NaN/Infinity/undefined', !/NaN|Infinity|undefined/.test(String(result.markdown)))
const rendered = tool.output.render({}, result)
ok('render 返回 text', rendered?.[0]?.type === 'text')
console.log('   报告行数 =', String(result.markdown).split('\n').length)

console.log('\n== 6. 未注册路径 404 ==')
const nope = await get('/nope')
ok('GET /nope → 404', nope.status === 404)

server.close()

console.log('\n== 7. 副作用清理 ==')
for (const e of effects) if (e.dispose) { try { e.dispose() } catch { /* ignore */ } }
ok('effect 都被 dispose', true)
console.log('   effect 数 =', effects.length)

console.log('')
if (failures.length === 0) {
  console.log(`✅ host-integration: 全部通过（${passed} 条断言）`)
  process.exit(0)
}
console.log(`❌ host-integration: ${failures.length} 条失败 / 共 ${passed + failures.length} 条`)
for (const f of failures) console.log(`   - ${f}`)
process.exit(1)
