import * as api from '../api.js'
import { toast } from '../app.js'
import { mountAddAccount } from './add-account.js'

const RATE_LIMIT_TIME_ZONE = 'Asia/Shanghai'
const RATE_LIMIT_TIME_ZONE_LABEL = 'UTC+8'
const RATE_LIMIT_CACHE_TTL_MS = 2 * 60 * 1000

const accountsViewState = {
  search: '',
  provider: 'all',
  scheduler: 'all',
  routingGroupId: 'all',
  focus: 'all',
}

const rateLimitProbeCache = new Map()
const ACCOUNT_TABS = new Set(['inventory', 'recovery', 'onboard'])

export async function renderAccounts(_, routeParams = null) {
  const container = document.getElementById('page-accounts')
  if (!container) return

  const activeTab = resolveAccountsTab(routeParams)
  container.innerHTML = renderAccountsWorkspace(activeTab)

  const panel = container.querySelector('[data-accounts-panel]')
  if (!panel) {
    return
  }

  if (activeTab === 'onboard') {
    await mountAddAccount(panel, { embedded: true })
    return
  }

  if (activeTab === 'recovery') {
    await renderAccountsRecovery(panel)
    return
  }

  await renderAccountsInventory(panel)
}

function resolveAccountsTab(routeParams = null) {
  const params = routeParams instanceof URLSearchParams
    ? routeParams
    : new URLSearchParams(String(location.hash || '').split('?')[1] || '')
  const tab = params.get('tab') || 'inventory'
  return ACCOUNT_TABS.has(tab) ? tab : 'inventory'
}

function renderAccountsWorkspace(activeTab) {
  return `
    <div class="workspace-shell">
      <section class="workspace-hero-card workspace-hero-card-accounts">
        <div>
          <div class="section-kicker">Account Workspace</div>
          <h2 class="workspace-hero-title">把账号生命周期收口到一页里。</h2>
          <p class="workspace-hero-subtitle">
            Inventory 负责账号池运维，Recovery 负责处理异常池，Onboard 负责接入新账号。新增入口不再单独占一级导航。
          </p>
        </div>
        <div class="workspace-hero-actions">
          <a class="btn btn-primary" href="#accounts?tab=onboard">Add Account</a>
          <a class="btn" href="#scheduler">Open Routing</a>
          <a class="btn" href="#usage">Open Usage</a>
        </div>
      </section>

      <div class="tabs workspace-tabs" role="tablist" aria-label="Accounts workspace">
        ${renderAccountsTabLink('inventory', 'Inventory', activeTab)}
        ${renderAccountsTabLink('recovery', 'Recovery', activeTab)}
        ${renderAccountsTabLink('onboard', 'Onboard', activeTab)}
      </div>

      <section class="workspace-panel" data-accounts-panel></section>
    </div>
  `
}

function renderAccountsTabLink(tabId, label, activeTab) {
  return `<a class="tab ${activeTab === tabId ? 'active' : ''}" href="#accounts?tab=${tabId}" role="tab" aria-selected="${activeTab === tabId ? 'true' : 'false'}">${esc(label)}</a>`
}

async function loadAccountsViewData() {
  const [{ accounts }, { proxies }, routingGroupsResult] = await Promise.all([
    api.listAccounts(),
    api.listProxies(),
    api.listRoutingGroups().catch(() => ({ routingGroups: [] })),
  ])
  const { routingGroups } = routingGroupsResult

  const proxyMap = {}
  for (const p of (proxies ?? [])) {
    proxyMap[p.url] = p.label || p.url
    if (p.localUrl) proxyMap[p.localUrl] = p.label || p.url
  }
  const routingGroupMap = Object.fromEntries(
    (routingGroups ?? []).map((group) => [group.id, group]),
  )
  const routingGroupList = [...(routingGroups ?? [])].sort((left, right) =>
    left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  )

  return {
    accounts: accounts ?? [],
    proxyMap,
    routingGroupMap,
    routingGroupList,
  }
}

async function renderAccountsInventory(container) {
  container.innerHTML = '<p class="text-dim">Loading...</p>'

  try {
    const viewData = await loadAccountsViewData()
    renderAccountsPage(container, viewData)
  } catch (err) {
    container.innerHTML = `<p class="text-red">Failed to load accounts: ${esc(err.message)}</p>`
  }
}

async function renderAccountsRecovery(container) {
  container.innerHTML = '<p class="text-dim">Loading...</p>'

  try {
    const viewData = await loadAccountsViewData()
    const { accounts, proxyMap, routingGroupMap, routingGroupList } = viewData
    const accountRows = accounts
      .map((acc) => ({ acc, meta: getAccountHealthMeta(acc, routingGroupMap) }))
      .sort(compareAccountRows)
    const attentionRows = accountRows.filter((row) => row.meta.attentionLevel !== 'healthy')

    container.innerHTML = `
      <div class="accounts-shell">
        <section class="card workspace-inline-card">
          <div class="workspace-inline-head">
            <div>
              <div class="section-kicker">Recovery Queue</div>
              <h3 class="card-title">优先处理异常账号，再回到正常池。</h3>
              <p class="card-subtitle">这里收口 token 失效、disabled group、缺代理和自动停止账号。处理完成后，账号会自动回到 Inventory 的稳定池。</p>
            </div>
            <div class="workspace-inline-actions">
              <span class="mini-pill"><strong>${esc(String(attentionRows.length))}</strong> 需要处理</span>
              <a class="btn btn-sm" href="#accounts?tab=inventory">Open Inventory</a>
            </div>
          </div>
        </section>
        <div id="accounts-recovery-list" class="accounts-section-stack"></div>
      </div>
    `

    const list = container.querySelector('#accounts-recovery-list')
    if (!list) {
      return
    }

    if (!accounts.length) {
      list.innerHTML = `
        <section class="card accounts-empty-card">
          <div class="empty-state">还没有账号。先在 Onboard 里接入账号，再回到这里处理异常池。</div>
        </section>
      `
      return
    }

    if (!attentionRows.length) {
      list.innerHTML = `
        <section class="card accounts-empty-card">
          <div class="empty-state">当前没有需要恢复的账号，全部账号都处于稳定池。</div>
        </section>
      `
      return
    }

    const section = buildAccountSection({
      title: 'Recovery Queue',
      subtitle: '优先看 token、routing group、代理和自动停止状态。',
      tone: 'warning',
      rows: attentionRows,
      proxyMap,
      routingGroupMap,
      routingGroupList,
    })
    list.appendChild(section.section)
    void autoProbeAccounts(section.autoProbeJobs)
  } catch (err) {
    container.innerHTML = `<p class="text-red">Failed to load recovery queue: ${esc(err.message)}</p>`
  }
}

function renderAccountsPage(container, viewData, restoreState = null) {
  const { accounts, proxyMap, routingGroupMap, routingGroupList } = viewData
  const accountRows = accounts
    .map((acc) => ({ acc, meta: getAccountHealthMeta(acc, routingGroupMap) }))
    .sort(compareAccountRows)

  const filteredRows = applyAccountFilters(accountRows)
  const attentionRows = filteredRows.filter((row) => row.meta.attentionLevel !== 'healthy')
  const healthyRows = filteredRows.filter((row) => row.meta.attentionLevel === 'healthy')

  if (!accounts.length) {
    container.innerHTML = `
      <div class="accounts-shell">
        ${renderAccountsHero(accountRows, filteredRows)}
        <div class="card accounts-empty-card">
          <div class="empty-state">
            还没有账号。先创建 routing group，再把不同 provider 的账号挂到对应池里。
          </div>
        </div>
      </div>`
    return
  }

  container.innerHTML = `
    <div class="accounts-shell">
      ${renderAccountsHero(accountRows, filteredRows)}
      ${renderAccountsOverview(accountRows, routingGroupList)}
      ${renderAccountsToolbar(accountRows, filteredRows, routingGroupList)}
      <div id="accounts-list" class="accounts-section-stack"></div>
    </div>
  `

  bindAccountsToolbar(container, viewData)

  if (restoreState?.focusFilter) {
    const restoreField = container.querySelector(`[data-filter="${restoreState.focusFilter}"]`)
    restoreField?.focus()
    if (restoreState.focusFilter === 'search' && typeof restoreState.selectionStart === 'number') {
      restoreField.selectionStart = restoreState.selectionStart
      restoreField.selectionEnd = restoreState.selectionEnd ?? restoreState.selectionStart
    }
  }

  const list = document.getElementById('accounts-list')
  const autoProbeJobs = []

  if (!filteredRows.length) {
    list.innerHTML = `
      <section class="card accounts-empty-card">
        <div class="empty-state">
          当前筛选条件没有命中任何账号。
          ${hasActiveAccountFilters() ? '<div style="margin-top:.9rem"><button class="btn btn-sm accounts-clear-filters-btn">清空筛选</button></div>' : ''}
        </div>
      </section>
    `
    list.querySelector('.accounts-clear-filters-btn')?.addEventListener('click', () => {
      resetAccountFilters()
      renderAccountsPage(container, viewData)
    })
    return
  }

  if (attentionRows.length) {
    const section = buildAccountSection({
      title: '需要处理',
      subtitle: '优先看 token、routing group、代理和自动停止状态。',
      tone: 'warning',
      rows: attentionRows,
      proxyMap,
      routingGroupMap,
      routingGroupList,
    })
    list.appendChild(section.section)
    autoProbeJobs.push(...section.autoProbeJobs)
  }

  if (healthyRows.length) {
    const section = buildAccountSection({
      title: attentionRows.length ? '稳定池' : '账号池',
      subtitle: attentionRows.length
        ? '这些账号当前没有明显风险，可以继续作为正常候选池。'
        : '按 routing group、provider 和调度状态管理全部账号。',
      tone: 'healthy',
      rows: healthyRows,
      proxyMap,
      routingGroupMap,
      routingGroupList,
    })
    list.appendChild(section.section)
    autoProbeJobs.push(...section.autoProbeJobs)
  }

  void autoProbeAccounts(autoProbeJobs)
}

async function autoProbeAccounts(jobs) {
  if (!jobs.length) {
    return
  }

  let cursor = 0
  const concurrency = Math.min(2, jobs.length)
  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < jobs.length) {
      const current = jobs[cursor]
      cursor += 1
      await autoProbe(current.accountId, current.card)
    }
  })
  await Promise.all(workers)
}

async function autoProbe(accountId, card) {
  const resultEl = card.querySelector(`.ratelimit-result[data-account-id="${CSS.escape(accountId)}"]`)
  if (!resultEl) {
    return
  }
  resultEl.innerHTML = '<span class="text-dim" style="font-size:.8rem">Loading rate limits...</span>'
  try {
    const result = await api.probeRateLimit(accountId)
    const html = renderRateLimitProbe(result)
    resultEl.innerHTML = html
    rateLimitProbeCache.set(accountId, { html, cachedAt: Date.now() })
  } catch (err) {
    const html = `<span class="text-red" style="font-size:.8rem">Failed: ${esc(err.message)}</span>`
    resultEl.innerHTML = html
    rateLimitProbeCache.set(accountId, { html, cachedAt: Date.now() })
  }
}

function renderAccountsHero(accountRows, filteredRows) {
  const criticalCount = accountRows.filter((row) => row.meta.attentionLevel === 'critical').length
  const warningCount = accountRows.filter((row) => row.meta.attentionLevel === 'warning').length
  const activeFilterBadge = hasActiveAccountFilters()
    ? `<span class="mini-pill"><strong>${esc(String(filteredRows.length))}</strong> 当前结果</span>`
    : ''

  return `
    <section class="accounts-hero-card">
      <div>
        <div class="section-kicker">Account Operations</div>
        <h2 class="accounts-hero-title">Accounts</h2>
        <p class="accounts-hero-subtitle">
          先筛选，再按风险分区。把 routing group、调度状态、rate limit 和登录恢复拆开，不再把所有信息挤在一张卡里。
        </p>
        <div class="accounts-hero-pills">
          <span class="mini-pill"><strong>${esc(String(accountRows.length))}</strong> 总账号</span>
          <span class="mini-pill"><strong>${esc(String(criticalCount))}</strong> Critical</span>
          <span class="mini-pill"><strong>${esc(String(warningCount))}</strong> Warning</span>
          ${activeFilterBadge}
        </div>
      </div>
      <div class="accounts-hero-actions">
        <a class="btn btn-primary" href="#accounts?tab=onboard">Add Account</a>
        <a class="btn" href="#scheduler">Routing</a>
        ${hasActiveAccountFilters() ? '<button class="btn accounts-clear-filters-btn">Clear Filters</button>' : ''}
      </div>
    </section>
  `
}

function renderAccountsOverview(accountRows, routingGroups) {
  const assignedAccounts = accountRows.filter((row) => resolveAccountRoutingGroupId(row.acc)).length
  const defaultPoolAccounts = accountRows.length - assignedAccounts
  const disabledGroupAccounts = accountRows.filter((row) => row.meta.groupState === 'disabled').length
  const activeGroups = routingGroups.filter((group) => group.isActive).length
  const attentionAccounts = accountRows.filter((row) => row.meta.attentionLevel !== 'healthy').length

  return `
    <div class="stats-grid accounts-stats-grid">
      ${miniStatCard(accountRows.length, 'Total Accounts', '当前仓库里的全部账号记录。')}
      ${miniStatCard(attentionAccounts, 'Needs Attention', '优先检查 token、代理和 disabled group。')}
      ${miniStatCard(activeGroups, 'Active Groups', '可接收新流量的 routing group 数量。')}
      ${miniStatCard(assignedAccounts, 'Assigned Accounts', '已经明确绑定 routing group 的账号。')}
      ${miniStatCard(defaultPoolAccounts, 'Default Pool', '未绑定 routing group，走默认池。')}
      ${miniStatCard(disabledGroupAccounts, 'On Disabled Group', '这些账号不会参与新的调度。')}
    </div>
  `
}

function renderAccountsToolbar(accountRows, filteredRows, routingGroupList) {
  const criticalCount = filteredRows.filter((row) => row.meta.attentionLevel === 'critical').length
  const warningCount = filteredRows.filter((row) => row.meta.attentionLevel === 'warning').length

  return `
    <section class="card accounts-toolbar-card">
      <div class="accounts-toolbar-header">
        <div>
          <h3 class="card-title">筛选与聚焦</h3>
          <p class="card-subtitle">支持按 provider、scheduler、routing group 和风险级别聚焦；搜索会匹配账号名、邮箱、ID 和组信息。</p>
        </div>
        <div class="accounts-toolbar-meta">
          <span class="mini-pill"><strong>${esc(String(filteredRows.length))}</strong> / ${esc(String(accountRows.length))} 可见</span>
          <span class="mini-pill"><strong>${esc(String(criticalCount))}</strong> Critical</span>
          <span class="mini-pill"><strong>${esc(String(warningCount))}</strong> Warning</span>
        </div>
      </div>
      <div class="accounts-toolbar-grid">
        <label class="accounts-filter-field">
          <span>Search</span>
          <input class="input accounts-filter-input" data-filter="search" value="${esc(accountsViewState.search)}" placeholder="Email / label / account id / routing group">
        </label>
        <label class="accounts-filter-field">
          <span>Provider</span>
          <select class="input" data-filter="provider">
            ${buildProviderFilterOptions(accountRows, accountsViewState.provider)}
          </select>
        </label>
        <label class="accounts-filter-field">
          <span>Scheduler</span>
          <select class="input" data-filter="scheduler">
            ${buildSelectOptions([
              { value: 'all', label: 'All states' },
              { value: 'enabled', label: 'Enabled' },
              { value: 'paused', label: 'Paused' },
              { value: 'draining', label: 'Draining' },
              { value: 'auto_blocked', label: 'Auto blocked' },
            ], accountsViewState.scheduler)}
          </select>
        </label>
        <label class="accounts-filter-field">
          <span>Routing Group</span>
          <select class="input" data-filter="routingGroupId">
            ${buildRoutingGroupFilterOptions(accountRows, routingGroupList, accountsViewState.routingGroupId)}
          </select>
        </label>
        <label class="accounts-filter-field">
          <span>Focus</span>
          <select class="input" data-filter="focus">
            ${buildSelectOptions([
              { value: 'all', label: 'All accounts' },
              { value: 'attention', label: 'Needs attention' },
              { value: 'critical', label: 'Critical only' },
              { value: 'healthy', label: 'Healthy only' },
            ], accountsViewState.focus)}
          </select>
        </label>
      </div>
    </section>
  `
}

function bindAccountsToolbar(container, viewData) {
  container.querySelectorAll('[data-filter]').forEach((field) => {
    const filterKey = field.dataset.filter
    const eventName = filterKey === 'search' ? 'input' : 'change'
    field.addEventListener(eventName, () => {
      const restoreState = {
        focusFilter: filterKey,
        selectionStart: field.selectionStart,
        selectionEnd: field.selectionEnd,
      }
      accountsViewState[filterKey] = field.value
      renderAccountsPage(container, viewData, restoreState)
    })
  })

  container.querySelector('.accounts-clear-filters-btn')?.addEventListener('click', () => {
    resetAccountFilters()
    renderAccountsPage(container, viewData)
  })
}

function buildAccountSection({
  title,
  subtitle,
  tone,
  rows,
  proxyMap,
  routingGroupMap,
  routingGroupList,
}) {
  const section = document.createElement('section')
  section.className = 'accounts-section'
  section.innerHTML = `
    <div class="accounts-section-header">
      <div>
        <div class="accounts-section-title-row">
          <h3 class="accounts-section-title">${esc(title)}</h3>
          <span class="badge ${tone === 'warning' ? 'badge-yellow' : 'badge-green'}">${esc(String(rows.length))}</span>
        </div>
        <p class="accounts-section-subtitle">${esc(subtitle)}</p>
      </div>
    </div>
  `

  const grid = document.createElement('div')
  grid.className = 'accounts-grid'
  const autoProbeJobs = []

  rows.forEach(({ acc, meta }) => {
    const card = buildAccountCard(acc, meta, proxyMap, routingGroupMap, routingGroupList)
    grid.appendChild(card)
    if (shouldAutoProbeRateLimit(acc)) {
      autoProbeJobs.push({ accountId: acc.id, card })
    }
  })

  section.appendChild(grid)
  return { section, autoProbeJobs }
}

function buildAccountCard(acc, meta, proxyMap, routingGroupMap, routingGroupList) {
  const card = document.createElement('div')
  card.className = `card account-card-shell account-card-${meta.attentionLevel}`

  const planName = getPlanName(acc)
  const primaryTitle = acc.emailAddress || acc.displayName || acc.label || acc.id
  const vpnName = acc.proxyUrl ? proxyMap[acc.proxyUrl] : null
  const vpnLink = vpnName
    ? `<a href="#network" class="inline-link">${esc(vpnName)}</a>`
    : '<span class="text-muted">-</span>'
  const schedulerState = getSchedulerUiState(acc)
  const accountGroupId = resolveAccountRoutingGroupId(acc)
  const accountGroupMeta = accountGroupId ? routingGroupMap[accountGroupId] ?? null : null
  const accountGroupLabel = accountGroupMeta?.name || accountGroupId
  const accountGroupDescription = accountGroupMeta?.description
    ? accountGroupMeta.description
    : accountGroupMeta?.isActive === false
      ? '该 routing group 已禁用，这个账号不会参与新请求调度。'
      : accountGroupId && !accountGroupMeta
        ? '当前账号绑定了不存在的 routing group，请重新选择。'
        : '留空表示归入 default pool，不绑定正式 routing group。'
  const credentialState = getCredentialState(acc)
  const endpointSummary = getEndpointSummary(acc)

  card.innerHTML = `
    <div class="account-card-head">
      <div class="account-card-head-main">
        <div class="account-card-kicker">${esc(providerLabel(acc.provider))} · ${esc(protocolLabel(acc.protocol))} · ${esc(authModeLabel(acc.authMode))}</div>
        <div class="account-card-title-row">
          <h3 class="account-card-title">${esc(primaryTitle)}</h3>
          ${planName ? `<span class="badge ${planBadgeClass(planName)}">${esc(planName)}</span>` : ''}
        </div>
        <div class="account-card-subline">${renderAccountIdentityMeta(acc, primaryTitle)}</div>
        <div class="account-chip-row">
          ${providerBadge(acc.provider)}
          ${protocolBadge(acc.protocol)}
          ${authModeBadge(acc.authMode)}
          ${renderRoutingBadge(accountGroupId, accountGroupMeta)}
          ${schedulerBadge(acc)}
        </div>
      </div>
      <div class="account-status-column">
        ${renderAccountHealthBadge(meta)}
      </div>
    </div>
    ${renderAccountSignals(meta)}
    <div class="account-summary-grid">
      ${renderSummaryMetric('Routing Group', accountGroupLabel || 'Default Pool', accountGroupDescription, meta.groupState === 'disabled' || meta.groupState === 'missing' ? 'warning' : 'neutral')}
      ${renderSummaryMetric('Connectivity', vpnName || (requiresProxy(acc) ? 'Missing proxy' : 'Direct'), acc.proxyUrl || (requiresProxy(acc) ? 'Claude official 账号缺少代理。' : '当前 provider 不依赖专用代理。'), !vpnName && requiresProxy(acc) ? 'warning' : 'neutral')}
      ${renderSummaryMetric('Credentials', credentialState.value, credentialState.note, credentialState.tone)}
      ${renderSummaryMetric('Endpoint', endpointSummary.value, endpointSummary.note, 'neutral')}
    </div>
    <div class="account-control-grid">
      <section class="account-subpanel">
        <div class="account-subpanel-header">
          <div>
            <div class="account-subpanel-title">Routing Group</div>
            <div class="account-subpanel-copy">账号所属的正式候选池。不同 provider 会在当前组内按路径能力分流。</div>
          </div>
          <a class="btn btn-sm" href="#scheduler">Routing</a>
        </div>
        <div class="account-panel-highlight">
          ${renderRoutingBadge(accountGroupId, accountGroupMeta)}
          <span class="account-panel-highlight-copy">${esc(accountGroupDescription)}</span>
        </div>
        <div class="account-inline-form">
          <select class="input account-group-input">
            ${buildRoutingGroupOptionsHtml(routingGroupList, accountGroupId, true)}
          </select>
          <button class="btn btn-sm btn-primary account-group-save-btn" disabled>Save Group</button>
        </div>
      </section>
      <section class="account-subpanel">
        <div class="account-subpanel-header">
          <div>
            <div class="account-subpanel-title">Scheduler</div>
            <div class="account-subpanel-copy">${esc(schedulerStateHelp(schedulerState))}</div>
          </div>
          <div class="account-panel-highlight">
            ${schedulerBadge(acc)}
          </div>
        </div>
        <div class="account-scheduler-group" role="group" aria-label="调度控制">
          ${renderSchedulerButtons(acc)}
        </div>
        <div class="account-scheduler-helper">${esc(schedulerStateLabel(schedulerState))}${acc.autoBlockedReason ? ` · ${esc(acc.autoBlockedReason)}` : ''}</div>
      </section>
    </div>
    <div class="account-ops-grid">
      ${renderRateLimitSection(acc)}
      ${renderLoginSection(acc)}
      <section class="account-subpanel">
        <div class="account-subpanel-header">
          <div>
            <div class="account-subpanel-title">Advanced Details</div>
            <div class="account-subpanel-copy">原始 endpoint、账号标识和补充诊断信息。</div>
          </div>
        </div>
        <div class="account-field-list">
          ${fieldRow('Account ID', `<span class="mono">${esc(acc.id)}</span>`)}
          ${fieldRow('Provider', providerBadge(acc.provider))}
          ${fieldRow('Protocol', protocolBadge(acc.protocol))}
          ${fieldRow('Auth', authModeBadge(acc.authMode))}
          ${fieldRow('VPN', vpnLink)}
          ${acc.modelName ? fieldRow('Model', `<span class="mono">${esc(acc.modelName)}</span>`) : ''}
          ${acc.apiBaseUrl ? fieldRow('Base URL', `<span class="mono">${esc(acc.apiBaseUrl)}</span>`) : ''}
          ${acc.loginPassword ? fieldRow('Password', `<span class="mono">${esc(acc.loginPassword)}</span>`) : ''}
          ${acc.lastError ? fieldRow('Last Error', `<span class="mono">${esc(acc.lastError)}</span>`) : ''}
        </div>
      </section>
    </div>
  `

  const probeBtn = card.querySelector('.probe-ratelimit-btn')
  probeBtn?.addEventListener('click', async (e) => {
    const btn = e.currentTarget
    const accountId = btn.dataset.accountId
    rateLimitProbeCache.delete(accountId)
    btn.disabled = true
    btn.textContent = 'Loading...'
    await autoProbe(accountId, card)
    btn.disabled = false
    btn.textContent = 'Refresh'
  })

  card.querySelectorAll('.account-scheduler-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.action
      const buttons = [...card.querySelectorAll('.account-scheduler-btn')]
      buttons.forEach((item) => { item.disabled = true })
      const originalText = btn.textContent
      btn.textContent = '处理中...'
      try {
        await api.updateAccountSettings(acc.id, schedulerActionPayload(action))
        toast(`调度已切换为${schedulerStateLabel(action)}`)
        await renderAccounts()
      } catch (error) {
        toast(error.message, 'error')
        buttons.forEach((item) => {
          item.disabled = item.dataset.current === 'true'
        })
        btn.textContent = originalText
      } finally {
        if (btn.isConnected) {
          btn.textContent = originalText
        }
      }
    })
  })

  const groupInput = card.querySelector('.account-group-input')
  const groupSaveBtn = card.querySelector('.account-group-save-btn')
  const syncGroupSaveState = () => {
    const nextGroup = normalizeGroup(groupInput?.value) || null
    groupSaveBtn.disabled = nextGroup === (accountGroupId || null)
  }
  groupInput?.addEventListener('change', syncGroupSaveState)
  syncGroupSaveState()
  groupSaveBtn?.addEventListener('click', async () => {
    const nextGroup = normalizeGroup(groupInput?.value) || null
    groupSaveBtn.disabled = true
    const originalText = groupSaveBtn.textContent
    groupSaveBtn.textContent = '保存中...'
    try {
      await api.updateAccountSettings(acc.id, { routingGroupId: nextGroup })
      toast(`账号组已更新为 ${nextGroup || 'default'}`)
      await renderAccounts()
    } catch (error) {
      toast(error.message, 'error')
      groupSaveBtn.disabled = false
      groupSaveBtn.textContent = originalText
    }
  })

  bindLoginSectionEvents(card, acc)

  return card
}

function getAccountHealthMeta(acc, routingGroupMap) {
  const signals = []
  const schedulerState = getSchedulerUiState(acc)
  const accountGroupId = resolveAccountRoutingGroupId(acc)
  const accountGroupMeta = accountGroupId ? routingGroupMap[accountGroupId] ?? null : null
  let groupState = 'default'

  if (schedulerState === 'auto_blocked') {
    signals.push({ tone: 'critical', label: 'Auto blocked', detail: acc.autoBlockedReason || '账号已被系统自动摘除。' })
  } else if (!acc.isActive) {
    signals.push({ tone: 'critical', label: 'Inactive', detail: '账号当前已停用。' })
  }

  if (requiresProxy(acc) && !acc.proxyUrl) {
    signals.push({ tone: 'warning', label: 'Missing proxy', detail: 'Claude official 账号缺少代理。' })
  }

  if (String(acc.authMode || '').toLowerCase() === 'oauth') {
    if (!acc.hasAccessToken) {
      signals.push({ tone: 'critical', label: 'Missing access token', detail: '需要重新登录或重新换码。' })
    } else if (!acc.hasRefreshToken) {
      signals.push({ tone: 'warning', label: 'Missing refresh token', detail: '长期使用前建议补登 refresh token。' })
    }
  }

  if (hasTokenIssue(acc.lastError)) {
    signals.push({ tone: 'warning', label: 'Token error', detail: acc.lastError })
  }

  if (accountGroupId && !accountGroupMeta) {
    groupState = 'missing'
    signals.push({ tone: 'critical', label: 'Unknown group', detail: '绑定的 routing group 已不存在。' })
  } else if (accountGroupMeta && !accountGroupMeta.isActive) {
    groupState = 'disabled'
    signals.push({ tone: 'warning', label: 'Disabled group', detail: '当前组已禁用，不会接收新流量。' })
  } else if (accountGroupId) {
    groupState = 'assigned'
  }

  const attentionLevel = signals.some((signal) => signal.tone === 'critical')
    ? 'critical'
    : signals.length
      ? 'warning'
      : 'healthy'

  return {
    attentionLevel,
    signals,
    groupState,
  }
}

function applyAccountFilters(accountRows) {
  return accountRows.filter(({ acc, meta }) => {
    if (accountsViewState.provider !== 'all' && acc.provider !== accountsViewState.provider) {
      return false
    }

    const schedulerState = getSchedulerUiState(acc)
    if (accountsViewState.scheduler !== 'all' && schedulerState !== accountsViewState.scheduler) {
      return false
    }

    const routingGroupId = resolveAccountRoutingGroupId(acc)
    if (accountsViewState.routingGroupId !== 'all') {
      if (accountsViewState.routingGroupId === 'default' && routingGroupId) {
        return false
      }
      if (accountsViewState.routingGroupId !== 'default' && routingGroupId !== accountsViewState.routingGroupId) {
        return false
      }
    }

    if (accountsViewState.focus === 'attention' && meta.attentionLevel === 'healthy') {
      return false
    }
    if (accountsViewState.focus === 'critical' && meta.attentionLevel !== 'critical') {
      return false
    }
    if (accountsViewState.focus === 'healthy' && meta.attentionLevel !== 'healthy') {
      return false
    }

    const searchNeedle = normalizeGroup(accountsViewState.search).toLowerCase()
    if (!searchNeedle) {
      return true
    }

    const searchParts = [
      acc.id,
      acc.emailAddress,
      acc.label,
      acc.displayName,
      acc.provider,
      acc.protocol,
      acc.authMode,
      routingGroupId,
      schedulerState,
    ].filter(Boolean).join(' ').toLowerCase()

    return searchParts.includes(searchNeedle)
  })
}

function compareAccountRows(left, right) {
  const severityRank = { critical: 0, warning: 1, healthy: 2 }
  const severityDiff = severityRank[left.meta.attentionLevel] - severityRank[right.meta.attentionLevel]
  if (severityDiff !== 0) {
    return severityDiff
  }

  const leftScheduler = getSchedulerUiState(left.acc)
  const rightScheduler = getSchedulerUiState(right.acc)
  if (leftScheduler !== rightScheduler) {
    const schedulerRank = { auto_blocked: 0, paused: 1, draining: 2, enabled: 3 }
    return schedulerRank[leftScheduler] - schedulerRank[rightScheduler]
  }

  return (left.acc.emailAddress || left.acc.displayName || left.acc.label || left.acc.id)
    .localeCompare(right.acc.emailAddress || right.acc.displayName || right.acc.label || right.acc.id)
}

function buildProviderFilterOptions(accountRows, selectedValue) {
  const values = [...new Set(accountRows.map(({ acc }) => acc.provider).filter(Boolean))]
    .sort((left, right) => providerLabel(left).localeCompare(providerLabel(right)))
    .map((provider) => ({ value: provider, label: providerLabel(provider) }))
  return buildSelectOptions([
    { value: 'all', label: 'All providers' },
    ...values,
  ], selectedValue)
}

function buildRoutingGroupFilterOptions(accountRows, routingGroupList, selectedValue) {
  const unknownGroups = [...new Set(accountRows
    .map(({ acc }) => resolveAccountRoutingGroupId(acc))
    .filter((groupId) => groupId && !routingGroupList.some((group) => group.id === groupId)))]
    .sort()

  const options = [
    { value: 'all', label: 'All groups' },
    { value: 'default', label: 'Default Pool' },
    ...routingGroupList.map((group) => ({ value: group.id, label: formatRoutingGroupLabel(group) })),
    ...unknownGroups.map((groupId) => ({ value: groupId, label: `${groupId} [unknown]` })),
  ]
  return buildSelectOptions(options, selectedValue)
}

function buildSelectOptions(options, selectedValue) {
  return options.map((option) => `
    <option value="${esc(option.value)}" ${option.value === selectedValue ? 'selected' : ''}>${esc(option.label)}</option>
  `).join('')
}

function renderAccountHealthBadge(meta) {
  if (meta.attentionLevel === 'critical') {
    return '<div class="account-health-badge account-health-critical">Needs Repair</div>'
  }
  if (meta.attentionLevel === 'warning') {
    return '<div class="account-health-badge account-health-warning">Needs Review</div>'
  }
  return '<div class="account-health-badge account-health-healthy">Ready</div>'
}

function renderAccountSignals(meta) {
  if (!meta.signals.length) {
    return ''
  }

  return `
    <div class="account-signal-list">
      ${meta.signals.slice(0, 3).map((signal) => `
        <div class="account-signal account-signal-${signal.tone}">
          <div class="account-signal-label">${esc(signal.label)}</div>
          <div class="account-signal-copy">${esc(signal.detail)}</div>
        </div>
      `).join('')}
    </div>
  `
}

function renderAccountIdentityMeta(acc, primaryTitle) {
  const items = []
  if (acc.emailAddress && acc.emailAddress !== primaryTitle) {
    items.push(acc.emailAddress)
  }
  if (acc.label && acc.label !== primaryTitle) {
    items.push(`label ${acc.label}`)
  }
  if (acc.displayName && acc.displayName !== primaryTitle && acc.displayName !== acc.label) {
    items.push(`display ${acc.displayName}`)
  }
  items.push(`id ${acc.id}`)
  return items.map((item) => `<span>${esc(item)}</span>`).join('<span class="account-meta-divider">·</span>')
}

function renderRoutingBadge(accountGroupId, accountGroupMeta) {
  if (!accountGroupId) {
    return '<span class="badge badge-gray">Default Pool</span>'
  }
  if (!accountGroupMeta) {
    return `<span class="badge badge-red">${esc(accountGroupId)} [unknown]</span>`
  }
  return `<span class="badge ${accountGroupMeta.isActive ? 'badge-blue' : 'badge-yellow'}">${esc(accountGroupMeta.name || accountGroupMeta.id)}</span>`
}

function renderSummaryMetric(label, value, note, tone = 'neutral') {
  return `
    <div class="account-summary-item account-summary-${tone}">
      <div class="account-summary-label">${esc(label)}</div>
      <div class="account-summary-value">${esc(value)}</div>
      <div class="account-summary-note">${esc(note)}</div>
    </div>
  `
}

function getCredentialState(acc) {
  const authMode = String(acc.authMode || '').toLowerCase()
  if (authMode === 'api_key') {
    return {
      value: 'Static API Key',
      note: '固定密钥模式，不依赖 access / refresh token。',
      tone: 'healthy',
    }
  }
  if (authMode === 'passthrough') {
    return {
      value: 'Passthrough',
      note: '请求直接透传，上游凭据不在本地托管。',
      tone: 'healthy',
    }
  }
  if (!acc.hasAccessToken) {
    return {
      value: 'Missing access token',
      note: '需要重新登录、换码或重新导入凭据。',
      tone: 'critical',
    }
  }
  if (!acc.hasRefreshToken) {
    return {
      value: 'Access only',
      note: '当前没有 refresh token，建议补登以便长期使用。',
      tone: 'warning',
    }
  }
  if (hasTokenIssue(acc.lastError)) {
    return {
      value: 'Token issue detected',
      note: acc.lastError,
      tone: 'warning',
    }
  }
  return {
    value: 'Managed OAuth ready',
    note: 'access / refresh token 已就绪，可继续参与调度。',
    tone: 'healthy',
  }
}

function getEndpointSummary(acc) {
  if (acc.modelName && acc.apiBaseUrl) {
    return {
      value: acc.modelName,
      note: acc.apiBaseUrl,
    }
  }
  if (acc.modelName) {
    return {
      value: acc.modelName,
      note: '使用默认 endpoint。',
    }
  }
  if (acc.apiBaseUrl) {
    return {
      value: 'Custom endpoint',
      note: acc.apiBaseUrl,
    }
  }
  return {
    value: protocolLabel(acc.protocol),
    note: '使用 provider 默认 endpoint。',
  }
}

function resetAccountFilters() {
  accountsViewState.search = ''
  accountsViewState.provider = 'all'
  accountsViewState.scheduler = 'all'
  accountsViewState.routingGroupId = 'all'
  accountsViewState.focus = 'all'
}

function hasActiveAccountFilters() {
  return accountsViewState.search
    || accountsViewState.provider !== 'all'
    || accountsViewState.scheduler !== 'all'
    || accountsViewState.routingGroupId !== 'all'
    || accountsViewState.focus !== 'all'
}

function getFreshRateLimitProbeCache(accountId) {
  const cached = rateLimitProbeCache.get(accountId)
  if (!cached) {
    return null
  }
  if (Date.now() - cached.cachedAt > RATE_LIMIT_CACHE_TTL_MS) {
    rateLimitProbeCache.delete(accountId)
    return null
  }
  return cached
}

function fieldRow(label, valueHtml) {
  return `<div class="account-field-label">${esc(label)}</div><div class="account-field-value">${valueHtml}</div>`
}

function providerLabel(provider) {
  const normalized = String(provider || '').toLowerCase()
  if (normalized === 'claude-official') return 'Claude Official'
  if (normalized === 'openai-codex') return 'OpenAI Codex'
  if (normalized === 'openai-compatible') return 'OpenAI Compatible'
  return provider || 'unknown'
}

function authModeLabel(authMode) {
  const normalized = String(authMode || '').toLowerCase()
  if (normalized === 'oauth') return 'OAuth'
  if (normalized === 'api_key') return 'API Key'
  if (normalized === 'passthrough') return 'Passthrough'
  return authMode || 'unknown'
}

function shouldRenderLoginSection(acc) {
  if (!supportsManagedOAuthLogin(acc)) {
    return false
  }
  const missingRequiredProxy = requiresProxy(acc) && !acc.proxyUrl
  return missingRequiredProxy || !acc.isActive || !acc.hasAccessToken || !acc.hasRefreshToken || hasTokenIssue(acc.lastError)
}

function renderLoginSection(acc) {
  if (!shouldRenderLoginSection(acc)) {
    return ''
  }

  const isCodex = acc.provider === 'openai-codex'
  let helperText = isCodex
    ? '先生成 Codex 登录链接。浏览器完成登录后会跳到 localhost 回调地址；把最终 URL 或 code 贴回来完成换码。'
    : '先生成登录链接，浏览器完成登录后，把 code 或完整回调链接贴回来完成换码。'
  if (requiresProxy(acc) && !acc.proxyUrl) {
    helperText = isCodex
      ? '当前账号尚未绑定代理；如需重新登录或补登，可以直接用下面的 Codex OAuth 流程。'
      : '当前账号尚未绑定代理；如需重新登录或补登，可以直接用下面的 OAuth 流程。'
  } else if (!acc.hasAccessToken) {
    helperText = isCodex
      ? '当前账号缺少 access token；可以直接重新登录，把 Codex token 补回这张账号卡。'
      : '当前账号缺少 access token；可以直接重新登录，把 token 补回这张账号卡。'
  } else if (!acc.hasRefreshToken) {
    helperText = isCodex
      ? '当前账号没有 refresh token；如需继续长期使用，建议重新登录补登 Codex OAuth。'
      : '当前账号没有 refresh token；如需继续长期使用，建议重新登录补登。'
  } else if (!acc.isActive || hasTokenIssue(acc.lastError)) {
    helperText = isCodex
      ? '当前账号状态异常；可以直接重新登录，刷新这张账号卡上的 Codex OAuth 凭据。'
      : '当前账号状态异常；可以直接重新登录，刷新这张账号卡上的 OAuth 凭据。'
  }

  return `
    <section class="account-subpanel account-login-panel">
      <div class="account-subpanel-header">
        <div>
          <div class="account-subpanel-title">${isCodex ? 'Codex OAuth Login' : 'OAuth Login'}</div>
          <div class="account-subpanel-copy">${esc(helperText)}</div>
        </div>
        <button class="btn btn-sm account-generate-login-btn">Login</button>
      </div>
      <div class="account-login-url-wrap" hidden>
        <label class="account-form-label">Auth URL</label>
        <div class="account-inline-form">
          <input class="input account-auth-url-input mono" readonly>
          <button class="btn btn-sm account-open-login-btn">Open</button>
          <button class="btn btn-sm account-copy-login-btn">Copy</button>
        </div>
        <div class="account-inline-hint">Session ID: <span class="mono account-session-id"></span></div>
      </div>
      <div>
        <label class="account-form-label">Code / Callback URL</label>
        <input class="input account-code-input" placeholder="Paste callback URL or code">
        <div class="account-login-action-row">
          <span class="account-inline-hint">Expected login: ${esc(acc.emailAddress || acc.id)}</span>
          <button class="btn btn-sm btn-primary account-exchange-code-btn" disabled>Exchange Code</button>
        </div>
        <div class="account-login-result" style="margin-top:.5rem"></div>
      </div>
    </section>
  `
}

function bindLoginSectionEvents(card, acc) {
  const panel = card.querySelector('.account-login-panel')
  if (!panel) {
    return
  }

  const generateBtn = panel.querySelector('.account-generate-login-btn')
  const openBtn = panel.querySelector('.account-open-login-btn')
  const copyBtn = panel.querySelector('.account-copy-login-btn')
  const exchangeBtn = panel.querySelector('.account-exchange-code-btn')
  const codeInput = panel.querySelector('.account-code-input')
  const urlWrap = panel.querySelector('.account-login-url-wrap')
  const urlInput = panel.querySelector('.account-auth-url-input')
  const sessionIdEl = panel.querySelector('.account-session-id')
  const resultEl = panel.querySelector('.account-login-result')

  generateBtn.addEventListener('click', async () => {
    generateBtn.disabled = true
    generateBtn.textContent = 'Generating...'
    resultEl.innerHTML = ''
    try {
      const result = await api.generateAuthUrl(undefined, acc.provider === 'openai-codex' ? 'openai-codex' : undefined)
      const sessionId = result?.session?.sessionId || result?.session?.id
      const authUrl = result?.session?.authUrl || ''
      if (!sessionId || !authUrl) {
        throw new Error('OAuth session response is invalid')
      }
      panel.dataset.sessionId = sessionId
      urlInput.value = authUrl
      sessionIdEl.textContent = sessionId
      urlWrap.hidden = false
      exchangeBtn.disabled = false
      generateBtn.textContent = 'Regenerate Link'
      toast('Login link generated')
    } catch (error) {
      resultEl.innerHTML = `<p class="text-red" style="font-size:.8rem">${esc(error.message)}</p>`
      generateBtn.textContent = 'Login'
      toast(error.message, 'error')
    } finally {
      generateBtn.disabled = false
    }
  })

  openBtn?.addEventListener('click', () => {
    const url = urlInput.value.trim()
    if (!url) {
      toast('Generate a login link first', 'error')
      return
    }
    window.open(url, '_blank', 'noopener,noreferrer')
  })

  copyBtn?.addEventListener('click', async () => {
    const url = urlInput.value.trim()
    if (!url) {
      toast('Generate a login link first', 'error')
      return
    }
    try {
      await navigator.clipboard.writeText(url)
      toast('Copied to clipboard')
    } catch {
      toast('Failed to copy login link', 'error')
    }
  })

  exchangeBtn?.addEventListener('click', async () => {
    const sessionId = panel.dataset.sessionId || ''
    const authorizationInput = codeInput.value.trim()
    if (!sessionId) {
      toast('Generate a login link first', 'error')
      return
    }
    if (!authorizationInput) {
      toast('Paste the callback URL or code first', 'error')
      return
    }

    exchangeBtn.disabled = true
    exchangeBtn.textContent = 'Exchanging...'
    resultEl.innerHTML = ''
    try {
      const result = await api.exchangeCode(
        sessionId,
        authorizationInput,
        acc.label || undefined,
        acc.id,
        acc.provider === 'openai-codex'
          ? {
              modelName: acc.modelName || undefined,
              apiBaseUrl: acc.apiBaseUrl || undefined,
              proxyUrl: acc.proxyUrl || undefined,
              routingGroupId: resolveAccountRoutingGroupId(acc) || undefined,
            }
          : {
              routingGroupId: resolveAccountRoutingGroupId(acc) || undefined,
            },
      )
      resultEl.innerHTML = `
        <div class="badge badge-green" style="margin-bottom:.4rem">Login completed</div>
        <div class="text-dim" style="font-size:.8rem">Email: ${esc(result.account?.emailAddress || acc.emailAddress || '-')}</div>
      `
      toast('Account login completed')
      await renderAccounts()
    } catch (error) {
      resultEl.innerHTML = `<p class="text-red" style="font-size:.8rem">${esc(error.message)}</p>`
      toast(error.message, 'error')
    } finally {
      exchangeBtn.disabled = false
      exchangeBtn.textContent = 'Exchange Code'
    }
  })
}

// ── Rate Limit Probe Rendering ──

function renderRateLimitProbe(r) {
  if (r?.kind === 'openai') {
    return renderOpenAIRateLimitProbe(r)
  }

  const tokenNote = renderProbeTokenStatus(r)
  if (r.error && !r.status) {
    return `<div style="font-size:.85rem">
      <span class="badge badge-red">${esc(r.error)}</span>
      <span class="text-muted" style="margin-left:.5rem">HTTP ${r.httpStatus}</span>
      ${tokenNote ? `<div style="margin-top:.5rem">${tokenNote}</div>` : ''}
    </div>`
  }

  const errorNote = r.error
    ? `<div style="margin-bottom:.5rem"><span class="badge badge-yellow">${esc(r.error)}</span> <span class="text-muted">HTTP ${r.httpStatus}</span></div>`
    : ''

  return `
    ${errorNote}
    ${tokenNote ? `<div style="margin-bottom:.6rem">${tokenNote}</div>` : ''}
    <div class="account-ratelimit-grid" style="font-size:.85rem">
      <div>
        <div style="margin-bottom:.75rem">
          <div class="text-dim" style="font-size:.75rem;margin-bottom:.4rem">Overall Status</div>
          <div>${statusBadge(r.status)} ${r.representativeClaim ? `<span class="text-muted" style="font-size:.8rem;margin-left:.3rem">bottleneck: ${esc(r.representativeClaim)}</span>` : ''}</div>
        </div>

        <div style="margin-bottom:.6rem">
          <div style="display:flex;justify-content:space-between;font-size:.8rem;margin-bottom:.2rem">
            <span class="text-dim">5h Utilization</span>
            <span>${r.fiveHourUtilization !== null ? pct(r.fiveHourUtilization) : '-'} ${statusBadgeSm(r.fiveHourStatus)}</span>
          </div>
          ${r.fiveHourUtilization !== null ? progressBar(r.fiveHourUtilization) : ''}
          ${r.fiveHourReset ? `<div class="text-muted" style="font-size:.75rem;margin-top:.15rem">Reset ${resetTime(r.fiveHourReset)}</div>` : ''}
        </div>

        <div style="margin-bottom:.6rem">
          <div style="display:flex;justify-content:space-between;font-size:.8rem;margin-bottom:.2rem">
            <span class="text-dim">7d Utilization</span>
            <span>${r.sevenDayUtilization !== null ? pct(r.sevenDayUtilization) : '-'} ${statusBadgeSm(r.sevenDayStatus)}</span>
          </div>
          ${r.sevenDayUtilization !== null ? progressBar(r.sevenDayUtilization) : ''}
          ${r.sevenDayReset ? `<div class="text-muted" style="font-size:.75rem;margin-top:.15rem">Reset ${resetTime(r.sevenDayReset)}</div>` : ''}
        </div>
      </div>

      <div>
        <div class="text-dim" style="font-size:.75rem;margin-bottom:.4rem">Details</div>
        <div style="font-size:.8rem;display:flex;flex-direction:column;gap:.35rem">
          ${detailRow('Overage', r.overageStatus ? statusBadgeSm(r.overageStatus) : '-')}
          ${r.overageDisabledReason ? detailRow('Overage Reason', `<span class="mono">${esc(r.overageDisabledReason)}</span>`) : ''}
          ${r.overageReset ? detailRow('Overage Reset', resetTime(r.overageReset)) : ''}
          ${r.fallbackPercentage !== null ? detailRow('Fallback', pct(r.fallbackPercentage)) : ''}
          ${r.sevenDaySurpassedThreshold !== null ? detailRow('7d Warning Threshold', pct(r.sevenDaySurpassedThreshold)) : ''}
          ${r.reset ? detailRow('Global Reset', resetTime(r.reset)) : ''}
        </div>
        <div class="text-muted" style="font-size:.7rem;margin-top:.75rem">Probed ${timeAgo(r.probedAt)} · ${formatIsoTime(r.probedAt)}</div>
      </div>
    </div>
    <div style="margin-top:.75rem;border-top:1px solid var(--border);padding-top:.75rem">
      <div class="text-dim" style="font-size:.75rem;margin-bottom:.45rem">Claude Raw Rate Limit Fields</div>
      <div class="account-ratelimit-raw-grid" style="font-size:.78rem">
        ${claudeFieldRow('status', formatRawString(r.status))}
        ${claudeFieldRow('representativeClaim', formatRawString(r.representativeClaim))}
        ${claudeFieldRow('reset', formatRawTimestamp(r.reset))}
        ${claudeFieldRow('fallbackPercentage', formatRawRatio(r.fallbackPercentage))}
        ${claudeFieldRow('fiveHourStatus', formatRawString(r.fiveHourStatus))}
        ${claudeFieldRow('fiveHourUtilization', formatRawRatio(r.fiveHourUtilization))}
        ${claudeFieldRow('fiveHourReset', formatRawTimestamp(r.fiveHourReset))}
        ${claudeFieldRow('sevenDayStatus', formatRawString(r.sevenDayStatus))}
        ${claudeFieldRow('sevenDayUtilization', formatRawRatio(r.sevenDayUtilization))}
        ${claudeFieldRow('sevenDayReset', formatRawTimestamp(r.sevenDayReset))}
        ${claudeFieldRow('sevenDaySurpassedThreshold', formatRawRatio(r.sevenDaySurpassedThreshold))}
        ${claudeFieldRow('overageStatus', formatRawString(r.overageStatus))}
        ${claudeFieldRow('overageDisabledReason', formatRawString(r.overageDisabledReason))}
        ${claudeFieldRow('overageReset', formatRawTimestamp(r.overageReset))}
        ${claudeFieldRow('httpStatus', `<span class="mono">${esc(String(r.httpStatus ?? '-'))}</span>`)}
        ${claudeFieldRow('tokenStatus', formatRawString(r.tokenStatus))}
        ${claudeFieldRow('refreshAttempted', `<span class="mono">${esc(String(Boolean(r.refreshAttempted)))}</span>`)}
        ${claudeFieldRow('refreshSucceeded', `<span class="mono">${esc(String(Boolean(r.refreshSucceeded)))}</span>`)}
        ${claudeFieldRow('refreshError', formatRawString(r.refreshError))}
        ${claudeFieldRow('probedAt', `<span class="mono">${esc(r.probedAt || '-')}</span> <span class="text-muted">(${formatIsoTime(r.probedAt)})</span>`)}
      </div>
    </div>
  `
}

function renderProbeTokenStatus(r) {
  if (r.tokenStatus === 'refreshed') {
    return `<span class="badge badge-green">access_token_refreshed</span>`
  }
  if (r.tokenStatus === 'refresh_token_missing') {
    return `<span class="badge badge-yellow">missing_refresh_token</span>`
  }
  if (r.tokenStatus === 'refresh_token_revoked') {
    return `<span class="badge badge-red">refresh_token_revoked</span>`
  }
  if (r.tokenStatus === 'refresh_failed') {
    return `<span class="badge badge-yellow">refresh_failed</span>${r.refreshError ? ` <span class="text-muted">${esc(r.refreshError)}</span>` : ''}`
  }
  if (r.tokenStatus === 'refreshed_but_still_unauthorized') {
    return `<span class="badge badge-yellow">refreshed_but_still_unauthorized</span>`
  }
  return ''
}

function renderOpenAIRateLimitProbe(r) {
  const hasHeaders = r.requestLimit != null || r.tokenLimit != null
  const errorNote = r.error
    ? `<div style="margin-bottom:.55rem"><span class="badge ${r.httpStatus === 429 ? 'badge-yellow' : 'badge-red'}">${esc(r.error)}</span>${r.httpStatus ? ` <span class="text-muted">HTTP ${esc(String(r.httpStatus))}</span>` : ''}</div>`
    : ''

  if (!hasHeaders && r.error && !r.httpStatus) {
    return `<div style="font-size:.85rem">${errorNote}</div>`
  }

  return `
    ${errorNote}
    <div class="account-ratelimit-grid" style="font-size:.85rem">
      ${renderOpenAIRateLimitMetric('Requests', r.requestLimit, r.requestRemaining, r.requestUtilization, r.requestReset)}
      ${renderOpenAIRateLimitMetric('Tokens', r.tokenLimit, r.tokenRemaining, r.tokenUtilization, r.tokenReset)}
    </div>
    <div class="account-inline-hint" style="margin-top:.75rem">
      ${hasHeaders
        ? `Probed ${esc(timeAgo(r.probedAt))} · ${esc(formatIsoTime(r.probedAt))}`
        : '这次探测没有拿到 x-ratelimit-* headers；如果上游不返回标准 OpenAI 限额头，面板里就不会有百分比。'}
    </div>
  `
}

function renderOpenAIRateLimitMetric(label, limit, remaining, utilization, reset) {
  const limitText = formatLargeNumber(limit)
  const remainingText = formatLargeNumber(remaining)
  const utilizationText = utilization == null ? '-' : pct(utilization)
  return `
    <div class="account-summary-item">
      <div class="account-summary-label">${esc(label)}</div>
      <div class="account-summary-value">${esc(utilizationText)}</div>
      <div class="account-summary-note">limit ${esc(limitText)} · remaining ${esc(remainingText)}</div>
      <div class="account-summary-note">${reset ? `reset ${esc(reset)}` : 'reset -'}</div>
    </div>
  `
}

function renderRateLimitSection(acc) {
  const cached = getFreshRateLimitProbeCache(acc.id)
  const initialHint = acc.provider === 'openai-codex'
    ? (!acc.hasAccessToken
        ? '当前账号缺少 access token，无法探测 Codex quota。'
        : '加载 Codex quota / x-ratelimit 头信息...')
    : (acc.proxyUrl
        ? 'Loading rate limits...'
        : '未绑定代理，无法探测当前账号的 rate limits。')
  const content = cached?.html || `<span class="text-dim" style="font-size:.8rem">${esc(initialHint)}</span>`

  if (!supportsRateLimitProbe(acc)) {
    return `
      <section class="account-subpanel">
        <div class="account-subpanel-header">
          <div>
            <div class="account-subpanel-title">Rate Limits</div>
            <div class="account-subpanel-copy">当前账号协议暂未接入管理台限流探测。</div>
          </div>
        </div>
        <div class="account-inline-hint">
          当前账号使用 ${esc(protocolLabel(acc.protocol))} 协议，管理台暂未接入该协议的限流探测。
        </div>
      </section>
    `
  }

  return `
    <section class="account-subpanel">
      <div class="account-subpanel-header">
        <div>
          <div class="account-subpanel-title">Rate Limits</div>
          <div class="account-subpanel-copy">
            ${acc.provider === 'openai-codex'
              ? 'Codex OAuth 账号会尝试读取 OpenAI 标准 x-ratelimit 头，并换算成使用百分比。缓存 2 分钟，筛选不会重复打探测接口。'
              : `当前仅支持 Claude 协议探测，所有时间统一显示为 ${RATE_LIMIT_TIME_ZONE_LABEL}。缓存 2 分钟，筛选不会重复打探测接口。`}
          </div>
        </div>
        <button class="btn btn-sm probe-ratelimit-btn" data-account-id="${esc(acc.id)}">Refresh</button>
      </div>
      <div class="ratelimit-result" data-account-id="${esc(acc.id)}">
        ${content}
      </div>
    </section>
  `
}

function shouldAutoProbeRateLimit(acc) {
  if (!supportsRateLimitProbe(acc) || getFreshRateLimitProbeCache(acc.id)) {
    return false
  }
  if (acc.provider === 'openai-codex') {
    return Boolean(acc.hasAccessToken)
  }
  return Boolean(acc.proxyUrl)
}

function supportsRateLimitProbe(acc) {
  return String(acc.protocol || '').toLowerCase() === 'claude'
    || String(acc.provider || '').toLowerCase() === 'openai-codex'
}

function supportsManagedOAuthLogin(acc) {
  return String(acc.provider || '').toLowerCase() === 'claude-official'
    && String(acc.authMode || '').toLowerCase() === 'oauth'
}

function requiresProxy(acc) {
  return String(acc.provider || '').toLowerCase() === 'claude-official'
}

function providerBadge(provider) {
  const normalized = String(provider || '').toLowerCase()
  const labelMap = {
    'claude-official': 'Claude Official',
    'openai-codex': 'OpenAI Codex',
    'openai-compatible': 'OpenAI Compatible',
  }
  const colorMap = {
    'claude-official': 'badge-blue',
    'openai-codex': 'badge-green',
    'openai-compatible': 'badge-gray',
  }
  return `<span class="badge ${colorMap[normalized] ?? 'badge-gray'}">${esc(labelMap[normalized] || provider || 'unknown')}</span>`
}

function protocolBadge(protocol) {
  const normalized = String(protocol || '').toLowerCase()
  const colorMap = {
    claude: 'badge-blue',
    openai: 'badge-green',
  }
  return `<span class="badge ${colorMap[normalized] ?? 'badge-gray'}">${esc(protocolLabel(protocol))}</span>`
}

function authModeBadge(authMode) {
  const normalized = String(authMode || '').toLowerCase()
  const labelMap = {
    oauth: 'OAuth',
    api_key: 'API Key',
    passthrough: 'Passthrough',
  }
  const colorMap = {
    oauth: 'badge-yellow',
    api_key: 'badge-gray',
    passthrough: 'badge-blue',
  }
  return `<span class="badge ${colorMap[normalized] ?? 'badge-gray'}">${esc(labelMap[normalized] || authMode || 'unknown')}</span>`
}

function protocolLabel(protocol) {
  const normalized = String(protocol || '').toLowerCase()
  if (normalized === 'claude') return 'Claude'
  if (normalized === 'openai') return 'OpenAI'
  return protocol || 'unknown'
}

function getPlanName(acc) {
  const subscription = String(acc.subscriptionType || '').toLowerCase()
  if (subscription === 'max') return 'Max'
  if (subscription === 'pro') return 'Pro'
  if (subscription === 'team') return 'Team'
  if (subscription === 'enterprise') return 'Enterprise'

  const tier = String(acc.rateLimitTier || '').toLowerCase()
  if (tier.includes('max')) return 'Max'
  if (tier.includes('claude_ai') || tier.includes('pro')) return 'Pro'
  return null
}

function planBadgeClass(planName) {
  const normalized = String(planName || '').toLowerCase()
  if (normalized === 'max') return 'badge-blue'
  if (normalized === 'pro') return 'badge-green'
  if (normalized === 'team') return 'badge-yellow'
  return 'badge-gray'
}

function renderAliasLine(acc, planName) {
  const normalizedPlan = String(planName || '').trim().toLowerCase()
  const label = String(acc.label || '').trim()
  const displayName = String(acc.displayName || '').trim()

  if (label && label.toLowerCase() !== normalizedPlan) {
    return `<div class="text-muted" style="font-size:.78rem;margin-top:.18rem">别名: ${esc(label)}</div>`
  }

  if (displayName && displayName.toLowerCase() !== normalizedPlan) {
    return `<div class="text-muted" style="font-size:.78rem;margin-top:.18rem">显示名: ${esc(displayName)}</div>`
  }

  return ''
}

function schedulerBadge(acc) {
  const state = getSchedulerUiState(acc)
  if (state === 'paused') {
    return '<span class="badge badge-gray">paused</span>'
  }
  if (state === 'draining') {
    return '<span class="badge badge-yellow">draining</span>'
  }
  if (state === 'auto_blocked') {
    return '<span class="badge badge-red">auto_blocked</span>'
  }
  return '<span class="badge badge-green">enabled</span>'
}

function getSchedulerUiState(acc) {
  const state = String(acc.schedulerState || 'enabled')
  if (state === 'auto_blocked') return 'auto_blocked'
  if (state === 'draining') return 'draining'
  if (!acc.schedulerEnabled || state === 'paused') return 'paused'
  return 'enabled'
}

function schedulerStateLabel(state) {
  if (state === 'enabled') return '启用'
  if (state === 'paused') return '暂停'
  if (state === 'draining') return '排空'
  if (state === 'auto_blocked') return '自动停止'
  return String(state || '未知')
}

function schedulerStateHelp(state) {
  if (state === 'enabled') {
    return '接收新调度，现有会话继续运行。'
  }
  if (state === 'paused') {
    return '停止接收新调度，账号保留供刷新、登录和手动恢复。'
  }
  if (state === 'draining') {
    return '不再接收新调度，现有会话继续跑到结束或迁移。'
  }
  if (state === 'auto_blocked') {
    return '账号被系统自动摘除；先看停止原因，确认后可手动恢复。'
  }
  return '调度状态未知。'
}

function schedulerActionPayload(action) {
  if (action === 'enabled') {
    return { schedulerEnabled: true, schedulerState: 'enabled' }
  }
  if (action === 'draining') {
    return { schedulerEnabled: true, schedulerState: 'draining' }
  }
  return { schedulerEnabled: false, schedulerState: 'paused' }
}

function renderSchedulerButtons(acc) {
  const current = getSchedulerUiState(acc)
  return [
    { action: 'enabled', label: '启用', tone: 'green' },
    { action: 'paused', label: '暂停', tone: 'gray' },
    { action: 'draining', label: '排空', tone: 'yellow' },
  ].map((item) => {
    const isCurrent = item.action === current
    return `
      <button
        class="btn btn-sm account-scheduler-btn account-scheduler-btn-${item.tone}${isCurrent ? ' is-active' : ''}"
        data-action="${item.action}"
        data-current="${isCurrent ? 'true' : 'false'}"
        ${isCurrent ? 'disabled aria-current="true"' : ''}
      >${item.label}${isCurrent ? ' · 当前' : ''}</button>
    `
  }).join('')
}

function detailRow(label, valueHtml) {
  return `<div><span class="text-dim">${label}:</span> ${valueHtml}</div>`
}

function claudeFieldRow(label, valueHtml) {
  return `<div class="text-dim mono">${esc(label)}</div><div>${valueHtml}</div>`
}

function statusBadge(status) {
  if (!status) return '<span class="badge badge-gray">-</span>'
  return `<span class="badge ${statusColor(status)}">${esc(status)}</span>`
}

function statusBadgeSm(status) {
  if (!status) return ''
  return `<span class="badge ${statusColor(status)}" style="font-size:.7rem;padding:.1rem .35rem">${esc(status)}</span>`
}

function statusColor(status) {
  if (!status) return 'badge-gray'
  const s = status.toLowerCase()
  if (s === 'allowed') return 'badge-green'
  if (s.includes('warning')) return 'badge-yellow'
  if (s === 'rejected' || s === 'throttled' || s === 'blocked') return 'badge-red'
  return 'badge-gray'
}

function progressBar(ratio) {
  const p = Math.min(100, (ratio * 100)).toFixed(1)
  return `<div class="progress"><div class="progress-bar ${utilizationColor(ratio)}" style="width:${p}%"></div></div>`
}

function utilizationColor(v) {
  if (v >= 0.8) return 'progress-red'
  if (v >= 0.5) return 'progress-yellow'
  return 'progress-green'
}

function pct(v) {
  return (v * 100).toFixed(1) + '%'
}

function formatLargeNumber(value) {
  if (value == null || !Number.isFinite(value)) {
    return '-'
  }
  return new Intl.NumberFormat('en-US').format(value)
}

function resetTime(ts) {
  const now = Date.now()
  const target = ts * 1000
  const diff = target - now
  const absolute = formatDateInRateLimitZone(new Date(target))
  if (diff <= 0) return `<span class="text-green">now</span> <span class="text-muted">(${absolute} ${RATE_LIMIT_TIME_ZONE_LABEL})</span>`

  const h = Math.floor(diff / 3600000)
  const m = Math.floor((diff % 3600000) / 60000)
  const dateStr = `${absolute} ${RATE_LIMIT_TIME_ZONE_LABEL}`

  if (h >= 24) {
    const d = Math.floor(h / 24)
    return `in ${d}d ${h % 24}h <span class="text-muted">(${dateStr})</span>`
  }
  if (h > 0) return `in ${h}h ${m}m <span class="text-muted">(${dateStr})</span>`
  return `in ${m}m <span class="text-muted">(${dateStr})</span>`
}

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime()
  const secs = Math.floor(diff / 1000)
  if (secs < 5) return 'just now'
  if (secs < 60) return secs + 's ago'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return mins + 'm ago'
  return Math.floor(mins / 60) + 'h ago'
}

function field(label, value) {
  const display = value != null && value !== '' ? esc(String(value)) : '<span class="text-muted">-</span>'
  return `<div><span class="text-dim">${label}:</span> ${display}</div>`
}

function formatUnixTime(ts) {
  if (!ts) {
    return '<span class="text-muted">-</span>'
  }
  return `<span class="mono">${esc(String(ts))}</span> <span class="text-muted">(${formatDateInRateLimitZone(new Date(ts * 1000))} ${RATE_LIMIT_TIME_ZONE_LABEL})</span>`
}

function formatIsoTime(iso) {
  if (!iso) {
    return '-'
  }
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return esc(iso)
  }
  return `${formatDateInRateLimitZone(date)} ${RATE_LIMIT_TIME_ZONE_LABEL}`
}

function formatDateInRateLimitZone(date) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: RATE_LIMIT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date)
}

function formatRawString(value) {
  if (value == null || value === '') {
    return '<span class="text-muted">-</span>'
  }
  return `<span class="mono">${esc(String(value))}</span>`
}

function formatRawRatio(value) {
  if (value == null) {
    return '<span class="text-muted">-</span>'
  }
  return `<span class="mono">${esc(String(value))}</span> <span class="text-muted">(${pct(value)})</span>`
}

function formatRawTimestamp(value) {
  if (!value) {
    return '<span class="text-muted">-</span>'
  }
  return formatUnixTime(value)
}

function hasTokenIssue(lastError) {
  if (!lastError) {
    return false
  }
  const normalized = String(lastError).toLowerCase()
  return normalized.includes('token') || normalized.includes('invalid_grant') || normalized.includes('revoked')
}

function normalizeGroup(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function resolveAccountRoutingGroupId(account) {
  return normalizeGroup(account?.routingGroupId) || normalizeGroup(account?.group)
}

function buildRoutingGroupOptionsHtml(routingGroupList, selectedId, includeDefault = true) {
  const normalizedSelectedId = normalizeGroup(selectedId)
  const options = []
  if (includeDefault) {
    options.push(`<option value="" ${normalizedSelectedId ? '' : 'selected'}>Default Pool</option>`)
  }
  for (const group of routingGroupList) {
    options.push(
      `<option value="${esc(group.id)}" ${group.id === normalizedSelectedId ? 'selected' : ''}>${esc(formatRoutingGroupLabel(group))}</option>`,
    )
  }
  if (normalizedSelectedId && !routingGroupList.some((group) => group.id === normalizedSelectedId)) {
    options.push(`<option value="${esc(normalizedSelectedId)}" selected>${esc(`${normalizedSelectedId} [unknown]`)}</option>`)
  }
  return options.join('')
}

function formatRoutingGroupLabel(group) {
  const namePart = group.name && group.name !== group.id ? `${group.name} (${group.id})` : group.id
  return group.isActive ? namePart : `${namePart} [disabled]`
}

function miniStatCard(value, label, caption = '') {
  return `
    <div class="stat-card">
      <div class="stat-value">${esc(String(value))}</div>
      <div class="stat-label">${esc(label)}</div>
      ${caption ? `<div class="stat-caption">${esc(caption)}</div>` : ''}
    </div>`
}

function esc(str) {
  const d = document.createElement('div')
  d.textContent = str ?? ''
  return d.innerHTML
}
