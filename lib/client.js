/**
 * ============================================================================
 * dsh-cache-tuner —— 浏览器半侧（client half）
 * ============================================================================
 *
 * 【形态】
 *   官方规定的客户端 bundle：window.__ModuleLoader__.load({ id, factory })。
 *   React 由 DSH 外壳提供（require('react')），本文件零构建、零打包、零额外依赖。
 *
 * 【它挂两个地方】
 *   1. settings.section —— 「缓存命中」设置页：
 *      命中率、累计 token、逐步命中率柱状图、断点归因列表、两个开关。
 *      挂载期间每 5 秒轮询一次 /api/cache-tuner/stats，卸载时清理定时器。
 *   2. sidebar.footer.action —— 侧边栏底部的小读数（♻ 97%），详情放在 title 里。
 *
 * 【样式】
 *   单次注入一个 <style data-dsh-cache-tuner>，类名统一 .dsh-ct- 前缀。
 *   只用中性色 rgba(127,127,127,...) / currentColor + 绿/琥珀强调色，
 *   因此浅色与深色主题下都可用；不使用任何未经核实的 CSS 变量。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-cache-tuner',

  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const react = require('react')
    const { useCallback, useEffect, useState, useSyncExternalStore } = react
    const h = react.createElement

    /** 接口前缀（与宿主半侧的路由一致）。 */
    const API = '/api/cache-tuner'

    /** 轮询间隔：5 秒。 */
    const POLL_MS = 5000

    /**
     * 客户端侧的默认值：只在「宿主设置还没读回来」时用于渲染，
     * 保证开关不会先闪成错误的状态。真实值以宿主返回的 settings 为准。
     */
    const CLIENT_DEFAULTS = { enabled: true, suppressRuntimeContext: false, stableTools: true }

    // -------------------------------------------------------------------------
    // 格式化
    // -------------------------------------------------------------------------
    function fmtNum(value) {
      const n = Number(value)
      if (!Number.isFinite(n)) return '—'
      return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    }

    function fmtPct(rate) {
      if (typeof rate !== 'number' || !Number.isFinite(rate)) return '—'
      return `${(rate * 100).toFixed(1)}%`
    }

    /** 按宿主给的展示口径格式化金额；拿不到就退回「—」，绝不显示 NaN。 */
    function fmtMoney(value, display) {
      const n = Number(value)
      if (!Number.isFinite(n)) return '—'
      const decimals = Number.isFinite(Number(display?.decimals))
        ? Math.max(0, Math.min(8, Math.floor(Number(display.decimals))))
        : 2
      const symbol = typeof display?.symbol === 'string' && display.symbol !== '' ? display.symbol : '¥'
      return `${symbol}${n.toFixed(decimals)}`
    }

    // -------------------------------------------------------------------------
    // 共享统计 store
    //
    // 两个挂载点共用同一条轮询：第一个订阅者出现时启动，最后一个离开时停止。
    // 这样即使两个组件同时挂着，也只会有一个 5 秒定时器。
    // -------------------------------------------------------------------------
    function createStatsStore() {
      let state = { loading: true, error: '', data: null }
      let sessionId = ''
      let timer = null
      let inflight = false
      const listeners = new Set()

      const emit = () => {
        for (const listener of [...listeners]) {
          try { listener() } catch (error) { console.error('[cache-tuner] listener failed:', error) }
        }
      }

      const load = async () => {
        if (inflight) return
        inflight = true
        try {
          const url = sessionId === '' ? `${API}/stats` : `${API}/stats?session=${encodeURIComponent(sessionId)}`
          const response = await fetch(url, { headers: { accept: 'application/json' } })
          if (!response.ok) throw new Error(`stats ${response.status}`)
          const data = await response.json()
          state = { loading: false, error: '', data }
        } catch (error) {
          // 宿主还没起来 / 接口不可用：保留上一次数据，只记录错误，不阻塞界面。
          state = { loading: false, error: String(error?.message ?? error), data: state.data }
        } finally {
          inflight = false
          emit()
        }
      }

      const start = () => {
        if (timer !== null) return
        void load()
        timer = setInterval(() => { void load() }, POLL_MS)
      }

      const stop = () => {
        if (timer === null) return
        clearInterval(timer)
        timer = null
      }

      return {
        subscribe(listener) {
          listeners.add(listener)
          start()
          return () => {
            listeners.delete(listener)
            if (listeners.size === 0) stop()
          }
        },
        get: () => state,
        refresh: load,
        selectSession(next) {
          const value = typeof next === 'string' ? next : ''
          if (value === sessionId) return
          sessionId = value
          state = { ...state, loading: true }
          emit()
          void load()
        },
        getSession: () => sessionId,
      }
    }

    /** 拉取设置。 */
    async function fetchSettings() {
      const response = await fetch(`${API}/settings`, { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`settings ${response.status}`)
      return response.json()
    }

    /** 写设置。 */
    async function saveSettings(patch) {
      const response = await fetch(`${API}/settings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!response.ok) throw new Error(`settings ${response.status}`)
      return response.json()
    }

    /** 清空计数器。 */
    async function resetCounters() {
      const response = await fetch(`${API}/reset`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      if (!response.ok) throw new Error(`reset ${response.status}`)
      return response.json()
    }

    // -------------------------------------------------------------------------
    // 样式注入（只注入一次）
    // -------------------------------------------------------------------------
    const CSS = `
.dsh-ct-page { display: flex; flex-direction: column; gap: 16px; max-width: 760px; font-size: 13px; line-height: 1.6; }
.dsh-ct-cards { display: flex; flex-wrap: wrap; gap: 10px; }
.dsh-ct-card {
  flex: 1 1 120px; min-width: 110px; padding: 8px 10px; border-radius: 8px;
  border: 1px solid rgba(127,127,127,.28); background: rgba(127,127,127,.07);
}
.dsh-ct-card-label { font-size: 11px; opacity: .68; }
.dsh-ct-card-value { font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; }
.dsh-ct-card-value[data-tone="good"] { color: rgb(82,196,26); }
.dsh-ct-card-value[data-tone="warn"] { color: rgb(230,162,60); }
.dsh-ct-card-value[data-tone="bad"] { color: rgb(214,102,86); }
.dsh-ct-card-sub { font-size: 11px; opacity: .6; }
.dsh-ct-block { display: flex; flex-direction: column; gap: 6px; }
.dsh-ct-block > h4 { margin: 0; font-size: 13px; font-weight: 600; }
.dsh-ct-chart {
  display: flex; align-items: flex-end; gap: 2px; height: 64px; padding: 4px 6px;
  border: 1px solid rgba(127,127,127,.25); border-radius: 8px; background: rgba(127,127,127,.06);
}
.dsh-ct-bar { flex: 1 1 0; min-width: 2px; border-radius: 2px 2px 0 0; background: rgba(127,127,127,.45); }
.dsh-ct-bar[data-tone="good"] { background: rgba(82,196,26,.8); }
.dsh-ct-bar[data-tone="warn"] { background: rgba(230,162,60,.85); }
.dsh-ct-bar[data-tone="bad"] { background: rgba(214,102,86,.85); }
.dsh-ct-legend { display: flex; gap: 12px; font-size: 11px; opacity: .68; flex-wrap: wrap; }
.dsh-ct-breaks { display: flex; flex-direction: column; gap: 6px; }
.dsh-ct-break {
  padding: 6px 8px; border-radius: 8px; border: 1px solid rgba(127,127,127,.25);
  background: rgba(127,127,127,.06);
}
.dsh-ct-break-head { font-size: 11px; opacity: .68; margin-bottom: 3px; }
.dsh-ct-break-body { display: flex; flex-wrap: wrap; gap: 4px; }
.dsh-ct-chip {
  display: inline-flex; align-items: center; padding: 1px 7px; border-radius: 999px;
  border: 1px solid rgba(230,162,60,.5); background: rgba(230,162,60,.12); font-size: 11px;
}
.dsh-ct-notes { display: flex; flex-direction: column; gap: 4px; }
.dsh-ct-note { opacity: .82; padding-left: 13px; text-indent: -13px; }
.dsh-ct-empty { opacity: .6; font-size: 12px; }
.dsh-ct-form { display: flex; flex-direction: column; gap: 10px; }
.dsh-ct-check { display: flex; align-items: flex-start; gap: 8px; }
.dsh-ct-check input { margin-top: 4px; }
.dsh-ct-check .dsh-ct-hint { display: block; font-size: 11px; opacity: .68; }
.dsh-ct-check[data-disabled="true"] { opacity: .55; }
.dsh-ct-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-ct-btn {
  border: 1px solid rgba(127,127,127,.4); background: transparent; color: inherit;
  border-radius: 6px; padding: 3px 10px; cursor: pointer; font-size: 12px;
}
.dsh-ct-btn:hover { background: rgba(127,127,127,.16); }
.dsh-ct-btn:disabled { opacity: .5; cursor: default; }
.dsh-ct-select {
  padding: 3px 6px; border-radius: 6px; border: 1px solid rgba(127,127,127,.4);
  background: rgba(127,127,127,.08); color: inherit; max-width: 260px;
}
.dsh-ct-status { font-size: 12px; opacity: .75; }
.dsh-ct-badge {
  display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 999px;
  border: 1px solid rgba(127,127,127,.35); background: rgba(127,127,127,.1);
  color: inherit; cursor: pointer; font-size: 12px; font-variant-numeric: tabular-nums;
}
.dsh-ct-badge:hover { background: rgba(127,127,127,.2); }
.dsh-ct-badge-dot { width: 7px; height: 7px; border-radius: 50%; background: rgba(127,127,127,.6); }
.dsh-ct-badge[data-tone="good"] .dsh-ct-badge-dot { background: rgb(82,196,26); }
.dsh-ct-badge[data-tone="warn"] .dsh-ct-badge-dot { background: rgb(230,162,60); }
.dsh-ct-badge[data-tone="bad"] .dsh-ct-badge-dot { background: rgb(214,102,86); }
`

    function adoptStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-dsh-cache-tuner]') !== null) return
      const style = document.createElement('style')
      style.setAttribute('data-dsh-cache-tuner', '')
      style.textContent = CSS
      document.head.appendChild(style)
    }

    // -------------------------------------------------------------------------
    // 命中率 → 色调
    // -------------------------------------------------------------------------
    function toneOf(rate) {
      if (typeof rate !== 'number' || !Number.isFinite(rate)) return 'none'
      if (rate >= 0.6) return 'good'
      if (rate >= 0.3) return 'warn'
      return 'bad'
    }

    // -------------------------------------------------------------------------
    // 组件
    // -------------------------------------------------------------------------
    function MetricCard(props) {
      return h('div', { className: 'dsh-ct-card' },
        h('div', { className: 'dsh-ct-card-label' }, props.label),
        h('div', { className: 'dsh-ct-card-value', 'data-tone': props.tone ?? 'none' }, props.value),
        props.sub !== undefined ? h('div', { className: 'dsh-ct-card-sub' }, props.sub) : null,
      )
    }

    /** 逐步命中率柱状图（纯 div，不引任何图表库）。 */
    function StepChart(props) {
      const steps = Array.isArray(props.steps) ? props.steps : []
      if (steps.length === 0) return h('div', { className: 'dsh-ct-empty' }, '还没有采集到步数据。')
      const recent = steps.slice(-60)
      return h('div', null,
        h('div', { className: 'dsh-ct-chart' },
          ...recent.map((row, index) => {
            const rate = row?.hitRate
            const finite = typeof rate === 'number' && Number.isFinite(rate)
            const height = finite ? Math.max(3, Math.round(rate * 100)) : 3
            return h('div', {
              key: `${row?.turn ?? 0}-${row?.step ?? 0}-${index}`,
              className: 'dsh-ct-bar',
              'data-tone': finite ? toneOf(rate) : 'none',
              style: { height: `${height}%` },
              title: `turn ${row?.turn ?? '?'} / step ${row?.step ?? '?'}\n`
                + `命中率 ${fmtPct(rate)}\n`
                + `提示词 ${fmtNum(row?.promptTokens)}（缓存读 ${fmtNum(row?.cacheRead)} / 缓存写 ${fmtNum(row?.cacheWrite)}）`,
            })
          }),
        ),
        h('div', { className: 'dsh-ct-legend' },
          h('span', null, `最近 ${recent.length} 步`),
          h('span', null, '绿 ≥60%'),
          h('span', null, '琥珀 30–60%'),
          h('span', null, '红 <30%'),
        ),
      )
    }

    /** 断点归因列表：每条显示「谁变了」。 */
    function BreakList(props) {
      const breaks = Array.isArray(props.breaks) ? props.breaks : []
      if (breaks.length === 0) return h('div', { className: 'dsh-ct-empty' }, '暂未记录到缓存断点。')
      return h('div', { className: 'dsh-ct-breaks' },
        ...breaks.slice(0, 8).map((item, index) => h('div', { key: index, className: 'dsh-ct-break' },
          h('div', { className: 'dsh-ct-break-head' },
            `turn ${item?.turn ?? '?'} / step ${item?.step ?? '?'} · ${item?.reason ?? '?'}`),
          h('div', { className: 'dsh-ct-break-body' },
            ...(Array.isArray(item?.changed) ? item.changed : []).map((text, inner) =>
              h('span', { key: inner, className: 'dsh-ct-chip' }, String(text))),
          ),
        )),
      )
    }

    function Notes(props) {
      const notes = Array.isArray(props.notes) ? props.notes : []
      if (notes.length === 0) return null
      return h('div', { className: 'dsh-ct-notes' },
        ...notes.map((note, index) => h('div', { key: index, className: 'dsh-ct-note' }, `· ${note}`)),
      )
    }

    /**
     * 省钱读数：今日 / 近 7 天 / 近 30 天。
     *
     * 口径来自宿主（cost-meter 账本的历史用量 + 实时单价），与上面「本进程内存
     * 计数器」不是同一套口径 —— 所以这里单独成块，并如实标注数据来源与缺口。
     */
    function SavingsBlock(props) {
      const savings = props.savings ?? null
      const display = savings?.display ?? null
      const windows = Array.isArray(savings?.windows) ? savings.windows : []

      if (savings === null || savings.available !== true || windows.length === 0) {
        const why = savings?.reason === 'ledger-missing'
          ? '读不到 cost-meter 账本（storages/cost-meter/ledger.json）'
          : savings?.reason === 'price-table-missing'
            ? '取不到权威价表'
            : '还没算出来'
        return h('div', { className: 'dsh-ct-block' },
          h('h4', null, '省下的钱'),
          h('div', { className: 'dsh-ct-empty' }, `— （${why}）`),
        )
      }

      const totalUnpriced = windows.reduce((max, w) => Math.max(max, (w.unpricedModels ?? []).length), 0)
      const fallbackDays = Math.max(...windows.map((w) => w.dayFallbackDays ?? 0))
      const coverage = windows.find((w) => w.window === 7)?.pricedCoverage ?? null

      return h('div', { className: 'dsh-ct-block' },
        h('h4', null, '省下的钱'),
        h('div', { className: 'dsh-ct-cards' },
          ...windows.map((w) => h(MetricCard, {
            key: w.window,
            label: w.label ?? `近 ${w.window} 天`,
            value: fmtMoney(w.savingsDisplay, display),
            tone: 'good',
            sub: `${w.from} ~ ${w.to} · 缓存读 ${fmtNum(w.cacheRead)}`,
          })),
        ),
        h('div', { className: 'dsh-ct-legend' },
          h('span', null, '节省 = Σ 缓存读 token ×（未命中价 − 命中价）'),
          h('span', null, `单价 USD/1M token → 按汇率 ${display?.exchangeRate ?? '—'} 折 ${display?.currency ?? '—'}`),
        ),
        coverage !== null && coverage < 1
          ? h('div', { className: 'dsh-ct-card-sub' },
            `⚠ 近 7 天定价覆盖率 ${fmtPct(coverage)}：未覆盖的部分已排除在金额之外。`)
          : null,
        totalUnpriced > 0
          ? h('div', { className: 'dsh-ct-card-sub' },
            `有 ${totalUnpriced} 个模型没有权威单价，其用量未计入金额（实际节省 ≥ 上表）。`)
          : null,
        fallbackDays > 0
          ? h('div', { className: 'dsh-ct-card-sub' },
            `有 ${fallbackDays} 天缺少会话级时间戳，按整日单档估算。`)
          : null,
      )
    }

    /** 设置页：缓存命中（settings.section）。 */
    function CacheTunerSection() {
      const [settings, setSettings] = useState(null)
      const [saving, setSaving] = useState(false)
      const [status, setStatus] = useState('')
      const state = useSyncExternalStore(statsStore.subscribe, statsStore.get, statsStore.get)

      // 首次挂载拉一次设置（统计由 store 自己轮询）。
      useEffect(() => {
        let cancelled = false
        fetchSettings().then(
          (result) => { if (!cancelled) setSettings(result.settings ?? null) },
          (error) => { if (!cancelled) setStatus(`设置读取失败：${String(error?.message ?? error)}`) },
        )
        return () => { cancelled = true }
      }, [])
      const patch = useCallback(async (update) => {
        setSaving(true)
        setStatus('')
        try {
          const result = await saveSettings(update)
          setSettings(result.settings ?? null)
          setStatus('已保存')
          void statsStore.refresh()
        } catch (error) {
          setStatus(`保存失败：${String(error?.message ?? error)}`)
        } finally {
          setSaving(false)
        }
      }, [])

      const onReset = useCallback(async () => {
        setSaving(true)
        setStatus('')
        try {
          await resetCounters()
          setStatus('计数器已清空')
          void statsStore.refresh()
        } catch (error) {
          setStatus(`清空失败：${String(error?.message ?? error)}`)
        } finally {
          setSaving(false)
        }
      }, [])

      const data = state.data
      const global = data?.global ?? null
      const session = data?.session ?? null
      const hitRate = global?.hitRate ?? null
      const capabilities = data?.capabilities ?? null
      /** 设置读回来之前先用客户端默认值渲染，避免开关闪成错误状态。 */
      const effective = settings ?? CLIENT_DEFAULTS

      const check = (key, label, hint, disabled) => h('label', {
        className: 'dsh-ct-check',
        'data-disabled': disabled === true ? 'true' : 'false',
      },
        h('input', {
          type: 'checkbox',
          checked: effective[key] === true,
          disabled: saving || disabled === true || settings === null,
          onChange: (event) => { void patch({ [key]: event.target.checked }) },
        }),
        h('span', null,
          h('div', null, label),
          hint !== undefined ? h('small', { className: 'dsh-ct-hint' }, hint) : null,
        ),
      )

      return h('div', { className: 'dsh-ct-page' },
        h('div', { className: 'dsh-ct-cards' },
          h(MetricCard, {
            label: '整体命中率',
            value: fmtPct(hitRate),
            tone: toneOf(hitRate),
            sub: `${fmtNum(global?.steps)} 步`,
          }),
          h(MetricCard, { label: '累计提示词 token', value: fmtNum(global?.promptTokens) }),
          h(MetricCard, {
            label: '缓存读 token',
            value: fmtNum(global?.cacheRead),
            sub: '按低价计费的部分',
          }),
          h(MetricCard, {
            label: '缓存写 token',
            value: fmtNum(global?.cacheWrite),
            sub: '写入前缀缓存',
          }),
          h(MetricCard, {
            label: '估算省下 token',
            value: fmtNum(global?.savedTokens),
            sub: '≈ 缓存读 token',
          }),
        ),

        h(SavingsBlock, { savings: data?.savings }),

        h('div', { className: 'dsh-ct-block' },
          h('h4', null, '逐步命中率'),
          h(StepChart, { steps: session?.steps }),
        ),

        h('div', { className: 'dsh-ct-block' },
          h('h4', null, '缓存断点归因'),
          h('div', { className: 'dsh-ct-row' },
            h('span', { className: 'dsh-ct-card-sub' },
              data?.sessionId ? `会话 ${data.sessionId}` : '（暂无活跃会话）'),
            data?.recentSessions?.length > 1
              ? h('select', {
                className: 'dsh-ct-select',
                value: statsStore.getSession(),
                onChange: (event) => { statsStore.selectSession(event.target.value) },
              },
                h('option', { value: '' }, '跟随最近活跃会话'),
                ...data.recentSessions.map((item) => h('option', { key: item.id, value: item.id },
                  `${item.id.slice(0, 12)}… · ${fmtPct(item.hitRate)} · ${item.steps} 步`)),
              )
              : null,
          ),
          h(BreakList, { breaks: data?.breaks }),
        ),

        h('div', { className: 'dsh-ct-block' },
          h('h4', null, '建议'),
          h(Notes, { notes: data?.notes }),
        ),

        h('div', { className: 'dsh-ct-block' },
          h('h4', null, '开关'),
          h('div', { className: 'dsh-ct-form' },
            h('div', null, check(
              'enabled',
              '启用缓存调优统计',
              '关闭后不再采集步数据、不再做断点归因；已采集的数据保留在内存里直到重置。',
            )),
            h('div', null, check(
              'suppressRuntimeContext',
              '抑制动态运行上下文（省 token，不是提命中率）',
              '调用 systemPrompt.suppressRuntimeContext()，移除「当前时间」这类每次请求都变的运行上下文。'
              + '注意：这些上下文是以「尾部用户消息」下发的，不在系统提示词前缀里，所以它省的是 token，不会把命中率拉上去。'
              + '取舍：模型不再知道当前时间、工作区状态等实时事实。默认关闭。',
            )),
            h('div', null, check(
              'stableTools',
              '工具集稳定化（本版本不生效）',
              capabilities?.stableTools?.reason
              ?? '工具注册表已经提供全量可见工具，且装配结果的工具列表本来就是按名称典序确定的；再注册稳定化 provider 只会把工具复制一份，因此不注册。',
              true,
            )),
            h('div', { className: 'dsh-ct-row' },
              h('button', {
                type: 'button', className: 'dsh-ct-btn', disabled: saving, onClick: () => { void onReset() },
              }, '清空计数器'),
              data?.capabilities?.scope === false
                ? h('span', { className: 'dsh-ct-status' }, '⚠ 当前会话拿不到作用域，归因退化为全局提示词指纹')
                : null,
            ),
          ),
          saving ? h('div', { className: 'dsh-ct-status' }, '处理中…') : null,
          status !== '' ? h('div', { className: 'dsh-ct-status' }, status) : null,
          state.error !== '' ? h('div', { className: 'dsh-ct-status' }, `统计读取失败：${state.error}`) : null,
        ),
      )
    }

    /** 侧边栏底部小读数（sidebar.footer.action）。 */
    function SidebarReadout() {
      const state = useSyncExternalStore(statsStore.subscribe, statsStore.get, statsStore.get)
      const global = state.data?.global ?? null
      const hitRate = global?.hitRate ?? null
      const finite = typeof hitRate === 'number' && Number.isFinite(hitRate)
      const label = finite ? `♻ ${Math.round(hitRate * 100)}%` : '♻ —'

      const savings = state.data?.savings ?? null
      const display = savings?.display ?? null
      const windows = Array.isArray(savings?.windows) ? savings.windows : []
      const savingsLines = savings !== null && savings.available === true && windows.length > 0
        ? windows.map((w) => `${w.label ?? `近 ${w.window} 天`}省下：${fmtMoney(w.savingsDisplay, display)}（缓存读 ${fmtNum(w.cacheRead)}）`)
        : ['省下：—（读不到 cost-meter 账本或价表）']

      const title = [
        `前缀缓存命中率：${fmtPct(hitRate)}`,
        `步数：${fmtNum(global?.steps)}`,
        `提示词 token：${fmtNum(global?.promptTokens)}`,
        `缓存读：${fmtNum(global?.cacheRead)} / 缓存写：${fmtNum(global?.cacheWrite)}`,
        '—— 省下的钱（按实时单价折算）——',
        ...savingsLines,
        state.data?.breaks?.length ? `最近断点：${state.data.breaks[0]?.changed?.join('、') ?? ''}` : '最近断点：无',
        state.error !== '' ? `（统计读取失败：${state.error}）` : '点击刷新，详情见 设置 → 缓存命中',
      ].join('\n')

      return h('button', {
        type: 'button',
        className: 'dsh-ct-badge',
        'data-tone': toneOf(hitRate),
        title,
        onClick: () => { void statsStore.refresh() },
      },
        h('span', { className: 'dsh-ct-badge-dot' }),
        h('span', null, label),
      )
    }

    // -------------------------------------------------------------------------
    // 模块级单例 store（两个挂载点共享同一条轮询）
    // -------------------------------------------------------------------------
    const statsStore = createStatsStore()

    // -------------------------------------------------------------------------
    // Cordis 插件三件套
    // -------------------------------------------------------------------------
    const name = 'cache-tuner'
    const inject = ['slots']

    function apply(ctx) {
      adoptStyles()

      try {
        ctx.slots.inject('settings.section', function* () {
          yield ctx.slots.register({
            name: 'settings.section',
            id: 'cache-tuner',
            order: 57,
            label: '缓存命中',
          }, CacheTunerSection)
        })
      } catch (error) {
        console.warn('[cache-tuner] 注册设置页失败：', error)
      }

      try {
        ctx.slots.inject('sidebar.footer.action', function* () {
          yield ctx.slots.register({
            name: 'sidebar.footer.action',
            id: 'cache-tuner',
            order: 57,
            label: '缓存命中',
          }, SidebarReadout)
        })
      } catch (error) {
        console.warn('[cache-tuner] 注册侧边栏读数失败：', error)
      }
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = name
    return module.exports
  },
})
