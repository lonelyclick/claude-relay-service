import * as api from '../api.js'
import { toast } from '../app.js'

const state = {
  proxies: [],
  query: '',
  diagnostics: new Map(),
  loadingIds: new Set(),
  bulkProbeRunning: false,
}

export async function renderVpn() {
  const container = document.getElementById('page-network') || document.getElementById('page-vpn')
  if (!container) return

  container.innerHTML = renderLoadingShell()

  try {
    const { proxies } = await api.listProxies()
    state.proxies = Array.isArray(proxies) ? proxies : []
    renderShell()
  } catch (err) {
    container.innerHTML = `
      <div class="card card-error">
        <div class="card-header">
          <div>
            <div class="section-kicker">Proxy Control</div>
            <h3 class="card-title">VPN / Proxy 页面加载失败</h3>
          </div>
        </div>
        <p class="text-red">${esc(err.message)}</p>
      </div>
    `
  }
}

function renderShell() {
  const container = document.getElementById('page-network') || document.getElementById('page-vpn')
  if (!container) return

  container.innerHTML = `
    <section class="vpn-hero-card">
      <div class="vpn-hero-copy">
        <div class="section-kicker">Proxy Control</div>
        <h2 class="vpn-hero-title">把代理出口从静态清单，变成可诊断、可筛选、可快速接入的操作面板。</h2>
        <p class="vpn-hero-subtitle">这里优先展示真实有用的信息：本地接入地址、绑定账号、出口 IP、诊断延迟，以及哪些节点还缺少可用的本地 HTTP 代理。</p>
      </div>
      <div class="vpn-overview-grid" id="vpn-overview-grid"></div>
    </section>

    <section class="card vpn-toolbar-card">
      <div class="card-header vpn-toolbar-header">
        <div>
          <div class="section-kicker">Workbench</div>
          <h3 class="card-title">Search, probe, and copy exits fast</h3>
          <p class="card-subtitle">“测速”在这里指向真实的出口诊断，而不是浏览器层面的假计时。</p>
        </div>
        <div class="vpn-toolbar-actions">
          <button type="button" class="btn" id="vpn-refresh-btn">刷新列表</button>
          <button type="button" class="btn btn-primary" id="vpn-probe-visible-btn">诊断可见节点</button>
        </div>
      </div>
      <div class="vpn-toolbar-grid">
        <label class="form-group vpn-search-group">
          <span>搜索代理 / 账号 / 地址</span>
          <input
            id="vpn-search-input"
            type="search"
            placeholder="例如 Ubuntu-JhHE、10812、IPv6、account@email.com"
            value="${escAttr(state.query)}"
          >
        </label>
        <div class="vpn-toolbar-meta" id="vpn-toolbar-meta"></div>
      </div>
    </section>

    <section class="vpn-grid" id="vpn-grid" aria-live="polite"></section>
  `

  const searchInput = document.getElementById('vpn-search-input')
  searchInput?.addEventListener('input', (event) => {
    state.query = event.target.value
    renderToolbarMeta()
    renderOverview()
    renderGrid()
  })

  document.getElementById('vpn-refresh-btn')?.addEventListener('click', () => {
    void refreshProxies(true)
  })

  document.getElementById('vpn-probe-visible-btn')?.addEventListener('click', () => {
    void probeVisibleProxies()
  })

  renderOverview()
  renderToolbarMeta()
  renderGrid()
}

async function refreshProxies(showToastOnSuccess = false) {
  try {
    const { proxies } = await api.listProxies()
    state.proxies = Array.isArray(proxies) ? proxies : []
    renderOverview()
    renderToolbarMeta()
    renderGrid()
    if (showToastOnSuccess) {
      toast('代理列表已刷新')
    }
  } catch (error) {
    toast(error.message, 'error')
  }
}

function renderOverview() {
  const shell = document.getElementById('vpn-overview-grid')
  if (!shell) return

  const filtered = getFilteredProxies()
  const linkedAccounts = state.proxies.reduce((sum, proxy) => sum + (proxy.accounts?.length ?? 0), 0)
  const withLocalEntry = state.proxies.filter((proxy) => Boolean(proxy.localUrl)).length
  const healthyCount = filtered.reduce((sum, proxy) => sum + (state.diagnostics.get(proxy.id)?.status === 'healthy' ? 1 : 0), 0)

  shell.innerHTML = [
    overviewCard(String(state.proxies.length), 'Total exits', '当前登记的远端节点数量'),
    overviewCard(String(withLocalEntry), 'Local ready', '已配置本地 HTTP 入口，可直接给账号或工具使用'),
    overviewCard(String(linkedAccounts), 'Linked accounts', '当前绑定到这些出口的账号总数'),
    overviewCard(String(healthyCount), 'Healthy probes', '当前筛选结果里，最近一次诊断成功的节点数'),
  ].join('')
}

function renderToolbarMeta() {
  const meta = document.getElementById('vpn-toolbar-meta')
  if (!meta) return

  const filtered = getFilteredProxies()
  const probeable = filtered.filter((proxy) => getProbeCapability(proxy).supported)
  const loadingCount = state.loadingIds.size
  const searchLabel = state.query ? `筛选到 ${filtered.length}/${state.proxies.length}` : `共 ${state.proxies.length} 个节点`

  meta.innerHTML = `
    <span class="mini-pill"><strong>${esc(searchLabel)}</strong><span>当前视图</span></span>
    <span class="mini-pill"><strong>${probeable.length}</strong><span>可诊断节点</span></span>
    <span class="mini-pill"><strong>${loadingCount}</strong><span>诊断中</span></span>
  `

  const probeVisibleBtn = document.getElementById('vpn-probe-visible-btn')
  if (probeVisibleBtn) {
    probeVisibleBtn.disabled = state.bulkProbeRunning || probeable.length === 0
    probeVisibleBtn.textContent = state.bulkProbeRunning ? '诊断进行中…' : '诊断可见节点'
  }
}

function renderGrid() {
  const grid = document.getElementById('vpn-grid')
  if (!grid) return

  const filtered = getFilteredProxies()
  if (!filtered.length) {
    grid.innerHTML = `
      <div class="card vpn-empty-card">
        <div class="empty-state">
          <div class="vpn-empty-title">没有匹配的代理出口</div>
          <div class="vpn-empty-copy">试试搜索标签、端口、本地地址或已绑定账号。</div>
        </div>
      </div>
    `
    return
  }

  grid.innerHTML = filtered.map(renderProxyCard).join('')

  grid.querySelectorAll('[data-vpn-action="copy-remote"]').forEach((button) => {
    button.addEventListener('click', () => {
      const proxy = findProxy(button.dataset.proxyId)
      if (!proxy) return
      void copyText(proxy.url, '远端节点已复制')
    })
  })

  grid.querySelectorAll('[data-vpn-action="copy-local"]').forEach((button) => {
    button.addEventListener('click', () => {
      const proxy = findProxy(button.dataset.proxyId)
      if (!proxy?.localUrl) return
      void copyText(proxy.localUrl, '本地代理地址已复制')
    })
  })

  grid.querySelectorAll('[data-vpn-action="probe"]').forEach((button) => {
    button.addEventListener('click', () => {
      const proxyId = button.dataset.proxyId
      if (!proxyId) return
      void probeProxy(proxyId)
    })
  })
}

async function probeVisibleProxies() {
  const probeTargets = getFilteredProxies().filter((proxy) => getProbeCapability(proxy).supported)
  if (!probeTargets.length) {
    toast('当前可见节点里没有可诊断的本地 HTTP 代理', 'error')
    return
  }

  state.bulkProbeRunning = true
  renderToolbarMeta()

  try {
    for (const proxy of probeTargets) {
      await probeProxy(proxy.id, true)
    }
    toast(`已完成 ${probeTargets.length} 个节点的出口诊断`)
  } finally {
    state.bulkProbeRunning = false
    renderToolbarMeta()
  }
}

async function probeProxy(proxyId, silent = false) {
  if (!proxyId || state.loadingIds.has(proxyId)) return

  state.loadingIds.add(proxyId)
  renderToolbarMeta()
  renderGrid()

  try {
    const result = await api.probeProxy(proxyId)
    state.diagnostics.set(proxyId, result.diagnostics)
    if (!silent) {
      const status = result.diagnostics?.status
      if (status === 'healthy') {
        toast('代理诊断完成')
      } else if (status === 'unsupported') {
        toast('该节点暂不支持在线诊断', 'error')
      } else {
        toast('代理诊断已返回异常结果', 'error')
      }
    }
  } catch (error) {
    toast(error.message, 'error')
  } finally {
    state.loadingIds.delete(proxyId)
    renderOverview()
    renderToolbarMeta()
    renderGrid()
  }
}

function renderProxyCard(proxy) {
  const linkedAccounts = proxy.accounts ?? []
  const diagnostics = state.diagnostics.get(proxy.id)
  const probeCapability = getProbeCapability(proxy)
  const probeTone = getProbeTone(diagnostics, probeCapability)
  const isLoading = state.loadingIds.has(proxy.id)

  return `
    <article class="card vpn-card vpn-card-${probeTone}">
      <div class="vpn-card-header">
        <div>
          <div class="section-kicker">Exit Node</div>
          <h3 class="vpn-card-title">${esc(proxy.label || 'Untitled')}</h3>
        </div>
        <div class="vpn-card-status-row">
          ${renderProbeBadge(diagnostics, probeCapability, isLoading)}
          <span class="mini-pill"><strong>${linkedAccounts.length}</strong><span>Accounts</span></span>
        </div>
      </div>

      <div class="vpn-metric-grid">
        ${renderMetricCell('本地接入', proxy.localUrl ? '已配置' : '缺失', proxy.localUrl ? '账号和工具应优先走这个地址' : '还不能直接做本地 HTTP 诊断')}
        ${renderMetricCell('最近延迟', formatLatency(diagnostics?.latencyMs), diagnostics ? `Probe via ${esc(diagnostics.via || '-').toUpperCase()}` : '尚未执行出口诊断')}
        ${renderMetricCell('出口 IP', diagnostics?.egressIp || '未检测', diagnostics?.egressFamily ? diagnostics.egressFamily.toUpperCase() : '等待诊断')}
        ${renderMetricCell('最近检测', diagnostics ? timeAgo(diagnostics.checkedAt) : '未检测', diagnostics?.error || '诊断结果会显示在这里')}
      </div>

      <div class="vpn-endpoint-stack">
        <div class="vpn-endpoint-row">
          <div class="vpn-endpoint-label">Remote</div>
          <div class="vpn-endpoint-value mono">${esc(truncateMiddle(proxy.url, 108))}</div>
        </div>
        <div class="vpn-endpoint-row">
          <div class="vpn-endpoint-label">Local</div>
          <div class="vpn-endpoint-value mono ${proxy.localUrl ? '' : 'text-muted'}">${esc(proxy.localUrl || '未配置本地 HTTP 代理')}</div>
        </div>
      </div>

      <div class="vpn-action-row">
        <button type="button" class="btn" data-vpn-action="copy-remote" data-proxy-id="${escAttr(proxy.id)}">复制远端节点</button>
        <button
          type="button"
          class="btn"
          data-vpn-action="copy-local"
          data-proxy-id="${escAttr(proxy.id)}"
          ${proxy.localUrl ? '' : 'disabled'}
        >复制本地地址</button>
        <button
          type="button"
          class="btn ${diagnostics?.status === 'healthy' ? '' : 'btn-primary'}"
          data-vpn-action="probe"
          data-proxy-id="${escAttr(proxy.id)}"
          ${isLoading ? 'disabled' : ''}
        >${isLoading ? '诊断中…' : '出口诊断'}</button>
      </div>

      <div class="vpn-diagnostics-panel ${diagnostics ? `vpn-diagnostics-${diagnostics.status}` : 'vpn-diagnostics-idle'}">
        ${renderDiagnosticsPanel(diagnostics, probeCapability)}
      </div>

      <details class="vpn-disclosure">
        <summary>查看完整地址与绑定账号</summary>
        <div class="vpn-disclosure-body">
          <div class="vpn-endpoint-row">
            <div class="vpn-endpoint-label">Remote Full</div>
            <div class="vpn-endpoint-value mono vpn-endpoint-break">${esc(proxy.url)}</div>
          </div>
          <div class="vpn-endpoint-row">
            <div class="vpn-endpoint-label">Local Full</div>
            <div class="vpn-endpoint-value mono vpn-endpoint-break">${esc(proxy.localUrl || '未配置')}</div>
          </div>
          <div class="vpn-account-block">
            <div class="vpn-endpoint-label">Linked Accounts</div>
            ${linkedAccounts.length
              ? `<div class="vpn-account-list">${linkedAccounts.map((account) =>
                `<a href="#accounts" class="vpn-account-chip">${esc(account.emailAddress || account.label || account.id)}</a>`
              ).join('')}</div>`
              : '<div class="text-muted">当前没有账号绑定到这个出口</div>'}
          </div>
        </div>
      </details>
    </article>
  `
}

function renderDiagnosticsPanel(diagnostics, probeCapability) {
  if (!diagnostics) {
    return `
      <div class="vpn-diag-title">出口诊断</div>
      <div class="vpn-diag-copy ${probeCapability.supported ? 'text-dim' : 'text-yellow'}">
        ${esc(probeCapability.message)}
      </div>
    `
  }

  return `
    <div class="vpn-diag-title">出口诊断</div>
    <div class="vpn-diag-grid">
      <div class="vpn-diag-item">
        <div class="vpn-diag-label">Status</div>
        <div class="vpn-diag-value">${esc(diagnostics.status)}</div>
      </div>
      <div class="vpn-diag-item">
        <div class="vpn-diag-label">HTTP</div>
        <div class="vpn-diag-value">${esc(diagnostics.httpStatus ? String(diagnostics.httpStatus) : '-')}</div>
      </div>
      <div class="vpn-diag-item">
        <div class="vpn-diag-label">IP Lookup</div>
        <div class="vpn-diag-value">${esc(diagnostics.ipLookupStatus ? String(diagnostics.ipLookupStatus) : '-')}</div>
      </div>
      <div class="vpn-diag-item">
        <div class="vpn-diag-label">Via</div>
        <div class="vpn-diag-value">${esc(diagnostics.via || '-')}</div>
      </div>
    </div>
    ${diagnostics.error ? `<div class="vpn-diag-copy text-yellow">${esc(diagnostics.error)}</div>` : '<div class="vpn-diag-copy text-green">连通性和出口 IP 都已拿到，可以直接判断这条链路是不是活的。</div>'}
  `
}

function renderProbeBadge(diagnostics, probeCapability, isLoading) {
  if (isLoading) {
    return '<span class="badge badge-blue">Probing</span>'
  }
  if (!diagnostics) {
    return `<span class="badge ${probeCapability.supported ? 'badge-gray' : 'badge-yellow'}">${probeCapability.supported ? 'Idle' : 'Needs Local URL'}</span>`
  }
  if (diagnostics.status === 'healthy') {
    return '<span class="badge badge-green">Healthy</span>'
  }
  if (diagnostics.status === 'degraded') {
    return '<span class="badge badge-yellow">Degraded</span>'
  }
  if (diagnostics.status === 'unsupported') {
    return '<span class="badge badge-gray">Unsupported</span>'
  }
  return '<span class="badge badge-red">Error</span>'
}

function renderMetricCell(label, value, caption) {
  return `
    <div class="vpn-metric-card">
      <div class="vpn-metric-label">${esc(label)}</div>
      <div class="vpn-metric-value">${esc(value)}</div>
      <div class="vpn-metric-caption">${esc(caption)}</div>
    </div>
  `
}

function overviewCard(value, label, caption) {
  return `
    <div class="dashboard-overview-card">
      <div class="dashboard-overview-value">${esc(value)}</div>
      <div class="dashboard-overview-label">${esc(label)}</div>
      <div class="dashboard-overview-caption">${esc(caption)}</div>
    </div>
  `
}

function getFilteredProxies() {
  const query = state.query.trim().toLowerCase()
  if (!query) return state.proxies

  return state.proxies.filter((proxy) => {
    const linkedAccounts = proxy.accounts ?? []
    const haystack = [
      proxy.label,
      proxy.url,
      proxy.localUrl,
      ...linkedAccounts.map((account) => account.emailAddress || account.label || account.id),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()

    return haystack.includes(query)
  })
}

function getProbeCapability(proxy) {
  if (proxy.localUrl && /^https?:\/\//i.test(proxy.localUrl)) {
    return { supported: true, message: '会优先通过 localUrl 做真实出口诊断。' }
  }
  if (/^https?:\/\//i.test(proxy.url)) {
    return { supported: true, message: '没有 localUrl，将直接通过远端 HTTP 代理做诊断。' }
  }
  return { supported: false, message: '当前记录更像节点配置而不是 HTTP 代理，需提供 localUrl 才能在线诊断。' }
}

function getProbeTone(diagnostics, probeCapability) {
  if (diagnostics?.status === 'healthy') return 'healthy'
  if (diagnostics?.status === 'degraded') return 'degraded'
  if (diagnostics?.status === 'error') return 'error'
  if (diagnostics?.status === 'unsupported' || !probeCapability.supported) return 'muted'
  return 'idle'
}

function findProxy(proxyId) {
  return state.proxies.find((proxy) => proxy.id === proxyId)
}

async function copyText(value, successMessage) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
    } else {
      const textarea = document.createElement('textarea')
      textarea.value = value
      textarea.setAttribute('readonly', 'readonly')
      textarea.style.position = 'absolute'
      textarea.style.left = '-9999px'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      textarea.remove()
    }
    toast(successMessage)
  } catch {
    toast('复制失败', 'error')
  }
}

function formatLatency(value) {
  if (!Number.isFinite(value) || value === null) return '未检测'
  return `${Math.max(1, Math.round(value))} ms`
}

function truncateMiddle(value, maxLength) {
  if (!value || value.length <= maxLength) return value || ''
  const head = Math.max(12, Math.floor(maxLength * 0.58))
  const tail = Math.max(10, maxLength - head - 1)
  return `${value.slice(0, head)}…${value.slice(-tail)}`
}

function timeAgo(iso) {
  const timestamp = new Date(iso).getTime()
  if (!Number.isFinite(timestamp)) return '刚刚'
  const diff = Date.now() - timestamp
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

function renderLoadingShell() {
  return `
    <section class="vpn-hero-card">
      <div>
        <div class="skeleton-block" style="width:7rem;height:.75rem;margin-bottom:.7rem"></div>
        <div class="skeleton-block" style="width:30rem;max-width:100%;height:2.4rem;margin-bottom:.7rem"></div>
        <div class="skeleton-block" style="width:32rem;max-width:100%;height:1rem"></div>
      </div>
      <div class="vpn-overview-grid">
        ${Array.from({ length: 4 }, () => '<div class="skeleton-card"></div>').join('')}
      </div>
    </section>
    <div class="skeleton-block" style="height:18rem"></div>
  `
}

function esc(value) {
  const div = document.createElement('div')
  div.textContent = value ?? ''
  return div.innerHTML
}

function escAttr(value) {
  return esc(value).replace(/"/g, '&quot;')
}
