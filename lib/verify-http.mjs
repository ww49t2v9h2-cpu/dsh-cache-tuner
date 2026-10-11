/**
 * ============================================================================
 * dsh-cache-tuner —— HTTP 面离线验收（环回围栏 + 路由契约）
 * ============================================================================
 *
 * 【为什么单独一个脚本】
 *   lib/verify.mjs 验的是纯逻辑（model.js）。路由与安全围栏在 index.js 里，
 *   需要把 apply() 真的装配起来才能验。这里用最小的假 cordis ctx 做这件事，
 *   唯一目的就是证明：**非环回请求一定被挡在门外**，环回请求一切正常。
 *
 * 用法：node lib/verify-http.mjs     （失败时以非零码退出）
 * ============================================================================
 */
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = await mkdtemp(join(tmpdir(), 'cache-tuner-http-'))
process.env.DSH_HOME = sandbox

const { apply } = await import('./index.js')

const failures = []
let passed = 0
function check(name, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  ✓ ${name}`) } else {
    failures.push(`${name}${detail === '' ? '' : ` — ${detail}`}`)
    console.log(`  ✗ ${name}${detail === '' ? '' : `  <<< ${detail}`}`)
  }
}

// ---------------------------------------------------------------------------
// 最小假 ctx：只实现 cache-tuner 实际用到的面
// ---------------------------------------------------------------------------
const state = { routes: [], tools: [], suppressCalls: 0 }
const ctx = {
  logger: { warn() {}, info() {}, error() {} },
  effect(fn) { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose() } },
  on() {},
  get() { return undefined },
  webServer: { register(route) { state.routes.push(route); return () => {} } },
  tools: { register(definition) { state.tools.push(definition); return () => {} }, schemas() { return [] } },
  systemPrompt: {
    async assemble() { return { sections: [], contexts: [], tools: [], variables: {} } },
    suppressRuntimeContext() { state.suppressCalls += 1; return () => {} },
  },
}

apply(ctx, { enabled: true })

console.log('\n▍装配检查')
check('注册了 HTTP 路由', state.routes.length === 1, `实际 ${state.routes.length}`)
check('路由前缀为 /api/cache-tuner', state.routes[0]?.path === '/api/cache-tuner', String(state.routes[0]?.path))
check('注册了 cache_report 工具', state.tools.some(t => t.name === 'cache_report'))

const route = state.routes[0]

function fakeRes() {
  return {
    statusCode: 200, headers: {}, body: '',
    setHeader(key, value) { this.headers[String(key).toLowerCase()] = value },
    end(payload) { this.body = payload === undefined ? '' : String(payload) },
  }
}
function fakeReq({ method = 'GET', url = '/', headers = {}, remoteAddress = '127.0.0.1' } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1:19387', ...headers }
  req.socket = { remoteAddress }
  req.destroy = () => {}
  setImmediate(() => req.emit('end'))
  return req
}
async function call(options) {
  const res = fakeRes()
  await route.handler(fakeReq(options), res)
  let json = null
  try { json = JSON.parse(res.body) } catch { /* 非 JSON */ }
  return { status: res.statusCode, json, raw: res.body }
}

console.log('\n▍环回围栏（安全）')
{
  const badHost = await call({ url: '/api/cache-tuner/stats', headers: { host: 'evil.example.com' } })
  check('非环回 Host → 403', badHost.status === 403, `实际 ${badHost.status}`)
  check('403 响应体带 loopback-only 说明', String(badHost.json?.error ?? '').includes('loopback-only'))

  const crossSite = await call({
    url: '/api/cache-tuner/stats',
    headers: { host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' },
  })
  check('sec-fetch-site: cross-site → 403', crossSite.status === 403, `实际 ${crossSite.status}`)

  const crossOrigin = await call({
    url: '/api/cache-tuner/stats',
    headers: { host: '127.0.0.1:19387', origin: 'http://evil.example.com' },
  })
  check('跨站 Origin → 403', crossOrigin.status === 403, `实际 ${crossOrigin.status}`)

  const lanAddress = await call({ url: '/api/cache-tuner/stats', remoteAddress: '192.168.1.50' })
  check('局域网来源地址 → 403', lanAddress.status === 403, `实际 ${lanAddress.status}`)

  const noHost = await call({ url: '/api/cache-tuner/stats', headers: { host: undefined } })
  check('缺少 Host 头 → 403', noHost.status === 403, `实际 ${noHost.status}`)

  const localhost = await call({ url: '/api/cache-tuner/stats', headers: { host: 'localhost:19387' } })
  check('localhost Host 放行 → 200', localhost.status === 200, `实际 ${localhost.status}`)

  const v6 = await call({ url: '/api/cache-tuner/stats', remoteAddress: '::1', headers: { host: '[::1]:19387' } })
  check('IPv6 环回放行 → 200', v6.status === 200, `实际 ${v6.status}`)

  const mapped = await call({ url: '/api/cache-tuner/stats', remoteAddress: '::ffff:127.0.0.1' })
  check('IPv4-mapped 环回放行 → 200', mapped.status === 200, `实际 ${mapped.status}`)
}

console.log('\n▍路由契约（环回）')
{
  const stats = await call({ url: '/api/cache-tuner/stats' })
  check('GET /stats → 200 且带 ok', stats.status === 200 && stats.json?.ok === true)
  check('GET /stats 带 global 聚合', stats.json?.global !== undefined)
  check('GET /stats 带 notes 数组', Array.isArray(stats.json?.notes))
  check('GET /stats 带 capabilities', stats.json?.capabilities !== undefined)
  check('响应声明 UTF-8 JSON', String(stats.json === null ? '' : 'json') === 'json')

  const settings = await call({ url: '/api/cache-tuner/settings' })
  check('GET /settings → 200', settings.status === 200 && settings.json?.ok === true)

  const missing = await call({ url: '/api/cache-tuner/nope' })
  check('未知路径 → 404', missing.status === 404, `实际 ${missing.status}`)
}

await rm(sandbox, { recursive: true, force: true })

console.log('\n' + '─'.repeat(60))
if (failures.length === 0) {
  console.log(`✅ 全部通过：${passed} 项。`)
  process.exit(0)
}
console.log(`❌ 失败 ${failures.length} 项 / 通过 ${passed} 项：`)
for (const failure of failures) console.log(`   · ${failure}`)
process.exit(1)
