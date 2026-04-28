import * as api from '../api.js'
import { toast } from '../app.js'

const PENDING_USER_ID_KEY = 'ccdash-selected-user-id'
const PENDING_USER_FOCUS_KEY = 'ccdash-users-focus-section'
const PENDING_CLIENT_DEVICE_ID_KEY = 'ccdash-selected-client-device-id'
const ROUTING_TABS = new Set(['groups', 'live-routes', 'guard', 'handoffs'])
let guardFilterMode = 'all'

export async function renderScheduler(_, routeParams = null) {
  const container = document.getElementById('page-scheduler')
  container.innerHTML = '<p class="text-dim">Loading...</p>'

  try {
    const [stats, { routingGroups }, { accounts: allAccounts }, { users }] = await Promise.all([
      api.getSchedulerStats(),
      api.listRoutingGroups(),
      api.listAccounts(),
      api.listUsers(),
    ])
    const g = stats.global ?? {}
    const groups = stats.groups ?? {}
    const routingGuard = stats.routingGuard ?? {}
    const accounts = stats.accounts ?? []
    const sessionRoutes = stats.sessionRoutes ?? []
    const recentHandoffs = stats.recentHandoffs ?? []
    const activeTab = resolveRoutingTab(routeParams)

    container.innerHTML = renderRoutingWorkspace({
      activeTab,
      globalStats: g,
      routingGroups: routingGroups ?? [],
      allAccounts: allAccounts ?? [],
      users: users ?? [],
      groups,
      routingGuard,
      accounts,
      sessionRoutes,
      recentHandoffs,
    })
    if (activeTab === 'groups') {
      bindRoutingGroupInteractions(container)
    }
    if (activeTab === 'guard') {
      bindRoutingGuardInteractions(container)
    }
    if (activeTab === 'live-routes') {
      bindRoutingLiveRouteInteractions(container)
    }
  } catch (err) {
    container.innerHTML = `<p class="text-red">Failed to load scheduler stats: ${esc(err.message)}</p>`
  }
}

function resolveRoutingTab(routeParams = null) {
  const params = routeParams instanceof URLSearchParams
    ? routeParams
    : new URLSearchParams(String(location.hash || '').split('?')[1] || '')
  const tab = params.get('tab') || 'groups'
  return ROUTING_TABS.has(tab) ? tab : 'groups'
}

function renderRoutingWorkspace({
  activeTab,
  globalStats,
  routingGroups,
  allAccounts,
  users,
  groups,
  routingGuard,
  accounts,
  sessionRoutes,
  recentHandoffs,
}) {
  return `
    <div class="workspace-shell">
      <section class="workspace-hero-card workspace-hero-card-routing">
        <div>
          <div class="section-kicker">Routing Control</div>
          <h2 class="workspace-hero-title">把 registry、实时路由和 handoff 收进同一个控制塔。</h2>
          <p class="workspace-hero-subtitle">
            Groups 管路由组和候选池，Live Routes 看当前会话绑定，Guard 看热点用户和设备，Handoffs 看最近迁移。
          </p>
        </div>
        <div class="workspace-hero-actions">
          <a class="btn btn-primary" href="#scheduler?tab=groups">Manage Groups</a>
          <a class="btn" href="#accounts">Open Accounts</a>
          <a class="btn" href="#users">Open Users</a>
        </div>
      </section>

      <div class="stats-grid">
        ${statCard(globalStats.activeAccounts ?? 0, 'Active Accounts')}
        ${statCard(globalStats.totalActiveSessions ?? 0, 'Active Sessions')}
        ${statCard(globalStats.totalCapacity ?? 0, 'Total Capacity')}
        ${statCard(`${globalStats.utilizationPercent ?? 0}%`, 'Utilization')}
      </div>

      <div class="tabs workspace-tabs" role="tablist" aria-label="Routing workspace">
        ${renderRoutingTabLink('groups', 'Groups', activeTab)}
        ${renderRoutingTabLink('live-routes', 'Live Routes', activeTab)}
        ${renderRoutingTabLink('guard', 'Guard', activeTab)}
        ${renderRoutingTabLink('handoffs', 'Handoffs', activeTab)}
      </div>

      <section class="workspace-panel-stack">
        ${renderRoutingTabPanel({
          activeTab,
          routingGroups,
          allAccounts,
          users,
          groups,
          routingGuard,
          accounts,
          sessionRoutes,
          recentHandoffs,
        })}
      </section>
    </div>
  `
}

function renderRoutingTabLink(tabId, label, activeTab) {
  return `<a class="tab ${activeTab === tabId ? 'active' : ''}" href="#scheduler?tab=${tabId}" role="tab" aria-selected="${activeTab === tabId ? 'true' : 'false'}">${esc(label)}</a>`
}

function renderRoutingTabPanel({
  activeTab,
  routingGroups,
  allAccounts,
  users,
  groups,
  routingGuard,
  accounts,
  sessionRoutes,
  recentHandoffs,
}) {
  if (activeTab === 'guard') {
    return renderRoutingGuard(routingGuard)
  }

  if (activeTab === 'live-routes') {
    return renderRoutingLiveRoutesPanel(sessionRoutes)
  }

  if (activeTab === 'handoffs') {
    return renderRoutingHandoffsPanel(recentHandoffs)
  }

  return `
    ${renderRoutingRegistryStats(routingGroups, allAccounts, users)}
    ${renderRoutingGroupsPanel(routingGroups, allAccounts, users)}
    ${renderGroupBreakdown(groups)}
    ${renderAccountTable(accounts)}
  `
}

function renderRoutingLiveRoutesPanel(routes) {
  return `
    <section class="card workspace-inline-card">
      <div class="workspace-inline-head">
        <div>
          <div class="section-kicker">Live Routes</div>
          <h3 class="card-title">当前会话粘在谁身上，一眼看清。</h3>
          <p class="card-subtitle">这部分原来是独立 Sessions 页，现在并回 Routing，避免运行态信息和组配置分散在两个入口。</p>
        </div>
        <div class="workspace-inline-actions">
          <span class="mini-pill"><strong>${esc(String(routes.length))}</strong> active routes</span>
          <button class="btn btn-sm btn-danger" id="routing-clear-sessions-btn" ${routes.length ? '' : 'disabled'}>Clear All</button>
        </div>
      </div>
    </section>
    ${routes.length
      ? renderSessionRoutes(routes)
      : '<div class="card accounts-empty-card"><div class="empty-state">当前没有 active session routes。</div></div>'}
  `
}

function renderRoutingHandoffsPanel(handoffs) {
  return `
    <section class="card workspace-inline-card">
      <div class="workspace-inline-head">
        <div>
          <div class="section-kicker">Recent Handoffs</div>
          <h3 class="card-title">观察最近的切换，而不是等用户报错。</h3>
          <p class="card-subtitle">这里单独收口 recent handoffs，便于判断是不是组内配额、账号状态或者 guard 触发导致的迁移。</p>
        </div>
        <div class="workspace-inline-actions">
          <span class="mini-pill"><strong>${esc(String(handoffs.length))}</strong> recent events</span>
        </div>
      </div>
    </section>
    ${handoffs.length
      ? renderRecentHandoffs(handoffs)
      : '<div class="card accounts-empty-card"><div class="empty-state">近期没有 handoff 事件。</div></div>'}
  `
}

function bindRoutingLiveRouteInteractions(container) {
  container.querySelector('#routing-clear-sessions-btn')?.addEventListener('click', async () => {
    if (!confirm('Clear all session routes?')) return
    try {
      await api.clearSessionRoutes()
      toast('Session routes cleared')
      await renderScheduler()
    } catch (error) {
      toast(error.message, 'error')
    }
  })
}

function renderRoutingRegistryStats(routingGroups, accounts, users) {
  const activeGroups = routingGroups.filter((group) => group.isActive).length
  const disabledGroups = routingGroups.length - activeGroups
  const linkedAccounts = accounts.filter((account) => resolveRoutingGroupId(account)).length
  const linkedUsers = users.filter((user) => resolveRoutingGroupId(user)).length

  return `
    <div class="stats-grid" style="margin-bottom:1rem">
      ${statCard(routingGroups.length, 'Routing Groups')}
      ${statCard(activeGroups, 'Active Groups')}
      ${statCard(disabledGroups, 'Disabled Groups')}
      ${statCard(linkedAccounts, 'Linked Accounts')}
      ${statCard(linkedUsers, 'Linked Users')}
    </div>
  `
}

function renderRoutingGroupsPanel(routingGroups, accounts, users) {
  const rows = routingGroups.map((group) => {
    const linkedAccounts = accounts.filter((account) => resolveRoutingGroupId(account) === group.id)
    const linkedUsers = users.filter((user) => resolveRoutingGroupId(user) === group.id)
    const providers = summarizeProviders(linkedAccounts)
    const isDeleteBlocked = linkedAccounts.length > 0 || linkedUsers.length > 0
    const deleteHint = linkedAccounts.length > 0 || linkedUsers.length > 0
      ? `${linkedAccounts.length} accounts / ${linkedUsers.length} users still linked`
      : 'Ready to delete'
    return `
      <tr data-routing-group-row="${esc(group.id)}">
        <td>
          <div style="display:flex;flex-direction:column;gap:.2rem">
            <strong>${esc(group.id)}</strong>
            <span class="text-dim" style="font-size:.75rem">${esc(group.createdAt || '-')}</span>
          </div>
        </td>
        <td>
          <input class="input routing-group-name-input" style="min-width:140px" value="${esc(group.name || group.id)}">
        </td>
        <td>
          <input class="input routing-group-description-input" value="${esc(group.description || '')}" placeholder="optional">
        </td>
        <td>
          <label style="display:flex;align-items:center;gap:.4rem">
            <input type="checkbox" class="routing-group-active-input" ${group.isActive ? 'checked' : ''}>
            <span class="badge ${group.isActive ? 'badge-green' : 'badge-red'}">${group.isActive ? 'active' : 'disabled'}</span>
          </label>
        </td>
        <td>${linkedAccounts.length}</td>
        <td>${linkedUsers.length}</td>
        <td>${providers || '<span class="text-muted">-</span>'}</td>
        <td>
          <div style="display:flex;gap:.4rem;flex-wrap:wrap">
            <button class="btn btn-sm btn-primary routing-group-save-btn" data-group-id="${esc(group.id)}">Save</button>
            <button class="btn btn-sm btn-danger routing-group-delete-btn" data-group-id="${esc(group.id)}" title="${esc(deleteHint)}" ${isDeleteBlocked ? 'disabled' : ''}>Delete</button>
          </div>
          <div class="text-dim" style="font-size:.72rem;margin-top:.35rem">${esc(deleteHint)}</div>
        </td>
      </tr>
    `
  }).join('')

  return `
    <div class="card">
      <div class="card-header">
        <div>
          <h3 class="card-title">Routing Groups</h3>
          <div class="text-dim" style="font-size:.8rem">一等路由组 registry。用户和账号都绑定到这里，禁用后该组账号不会再参与新请求调度。</div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1.2fr 1fr 1.4fr auto auto;gap:.6rem;align-items:end;margin-bottom:1rem">
        <div>
          <div class="text-dim" style="font-size:.78rem;margin-bottom:.25rem">Group ID</div>
          <input class="input" id="routing-group-create-id" placeholder="team-a">
        </div>
        <div>
          <div class="text-dim" style="font-size:.78rem;margin-bottom:.25rem">Name</div>
          <input class="input" id="routing-group-create-name" placeholder="Team A">
        </div>
        <div>
          <div class="text-dim" style="font-size:.78rem;margin-bottom:.25rem">Description</div>
          <input class="input" id="routing-group-create-description" placeholder="optional">
        </div>
        <label style="display:flex;align-items:center;gap:.4rem;padding-bottom:.35rem">
          <input type="checkbox" id="routing-group-create-active" checked>
          <span>Active</span>
        </label>
        <button class="btn btn-sm btn-primary" id="routing-group-create-btn">Create</button>
      </div>

      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Name</th>
              <th>Description</th>
              <th>Status</th>
              <th>Accounts</th>
              <th>Users</th>
              <th>Providers</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${rows || '<tr><td colspan="8" class="text-muted">No routing groups yet. Create the first group above, then assign accounts and users to it.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>`
}

function bindRoutingGroupInteractions(container) {
  const createBtn = container.querySelector('#routing-group-create-btn')
  createBtn?.addEventListener('click', async () => {
    const id = container.querySelector('#routing-group-create-id')?.value?.trim() || ''
    const name = container.querySelector('#routing-group-create-name')?.value?.trim() || ''
    const description = container.querySelector('#routing-group-create-description')?.value?.trim() || ''
    const isActive = Boolean(container.querySelector('#routing-group-create-active')?.checked)
    if (!id) {
      toast('Group ID 不能为空', 'error')
      return
    }
    createBtn.disabled = true
    try {
      await api.createRoutingGroup({
        id,
        name: name || undefined,
        description: description || undefined,
        isActive,
      })
      toast('Routing group 已创建')
      await renderScheduler()
    } catch (error) {
      toast(error.message, 'error')
    } finally {
      createBtn.disabled = false
    }
  })

  container.querySelectorAll('.routing-group-save-btn').forEach((button) => {
    button.addEventListener('click', async () => {
      const groupId = button.dataset.groupId
      const row = button.closest('[data-routing-group-row]')
      if (!groupId || !row) return
      const name = row.querySelector('.routing-group-name-input')?.value?.trim() || ''
      const description = row.querySelector('.routing-group-description-input')?.value?.trim() || ''
      const isActive = Boolean(row.querySelector('.routing-group-active-input')?.checked)
      button.disabled = true
      try {
        await api.updateRoutingGroup(groupId, {
          name: name || null,
          description: description || null,
          isActive,
        })
        toast(`Routing group ${groupId} 已更新`)
        await renderScheduler()
      } catch (error) {
        toast(error.message, 'error')
      } finally {
        button.disabled = false
      }
    })
  })

  container.querySelectorAll('.routing-group-delete-btn').forEach((button) => {
    button.addEventListener('click', async () => {
      const groupId = button.dataset.groupId
      if (!groupId) return
      if (!confirm(`Delete routing group "${groupId}"?`)) return
      button.disabled = true
      try {
        await api.deleteRoutingGroup(groupId)
        toast(`Routing group ${groupId} 已删除`)
        await renderScheduler()
      } catch (error) {
        toast(error.message, 'error')
      } finally {
        button.disabled = false
      }
    })
  })
}

function resolveRoutingGroupId(entity) {
  const groupId = typeof entity?.routingGroupId === 'string' ? entity.routingGroupId.trim() : ''
  if (groupId) {
    return groupId
  }
  const legacyGroup = typeof entity?.group === 'string' ? entity.group.trim() : typeof entity?.preferredGroup === 'string' ? entity.preferredGroup.trim() : ''
  return legacyGroup || ''
}

function summarizeProviders(accounts) {
  if (!accounts.length) {
    return ''
  }
  const counts = new Map()
  for (const account of accounts) {
    counts.set(account.provider, (counts.get(account.provider) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])))
    .map(([provider, count]) => `${provider}×${count}`)
    .join(' · ')
}

function statCard(value, label) {
  return `
    <div class="stat-card">
      <div class="stat-value">${esc(String(value))}</div>
      <div class="stat-label">${esc(label)}</div>
    </div>`
}

function renderGroupBreakdown(groups) {
  const entries = Object.entries(groups)
  if (!entries.length) return ''

  return `
    <div class="card">
      <div class="card-header"><h3 class="card-title">Group Breakdown</h3></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Group</th><th>Accounts</th><th>Sessions / Capacity</th><th>Utilization</th></tr></thead>
          <tbody>
            ${entries.map(([name, g]) => `
              <tr>
                <td><span class="badge badge-blue">${esc(name)}</span></td>
                <td>${g.accounts}</td>
                <td>${g.activeSessions} / ${g.capacity}</td>
                <td>
                  <div style="display:flex;align-items:center;gap:.5rem">
                    <div class="progress" style="width:120px">
                      <div class="progress-bar ${utilizationColor(g.utilizationPercent)}" style="width:${Math.min(100, g.utilizationPercent)}%"></div>
                    </div>
                    <span>${g.utilizationPercent}%</span>
                  </div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>`
}

function renderRoutingGuard(routingGuard) {
  const limits = routingGuard?.limits ?? {}
  const users = routingGuard?.users ?? []
  const devices = routingGuard?.devices ?? []
  const windowMs = Number(routingGuard?.windowMs ?? 0)

  return `
    <div class="card guard-panel" id="routing-guard-board">
      <div class="card-header guard-panel-header">
        <div>
          <h3 class="card-title">Routing Guard Board</h3>
          <p class="guard-panel-subtitle">Recent pressure across relay users and client devices in a ${esc(formatWindow(windowMs))} window.</p>
        </div>
        <div class="guard-panel-controls">
          <div class="guard-filter-group">
            <button class="btn btn-sm guard-filter-btn ${guardFilterMode === 'all' ? 'is-active' : ''}" data-guard-filter="all">All</button>
            <button class="btn btn-sm guard-filter-btn ${guardFilterMode === 'hot' ? 'is-active' : ''}" data-guard-filter="hot">Hot / Critical</button>
          </div>
          <div class="guard-limit-pills">
            ${guardLimitPill('User Sessions', limits.userActiveSessions)}
            ${guardLimitPill('Device Sessions', limits.clientDeviceActiveSessions)}
            ${guardLimitPill('User Requests', limits.userRecentRequests)}
            ${guardLimitPill('Device Requests', limits.clientDeviceRecentRequests)}
            ${guardLimitPill('User Tokens', formatTokenCount(limits.userRecentTokens))}
            ${guardLimitPill('Device Tokens', formatTokenCount(limits.clientDeviceRecentTokens))}
          </div>
        </div>
      </div>

      <div class="guard-grid">
        ${renderRoutingGuardTable('Hot Users', users, limits, 'user')}
        ${renderRoutingGuardTable('Hot Devices', devices, limits, 'device')}
      </div>
    </div>`
}

function renderRoutingGuardTable(title, items, limits, mode) {
  const hasDeviceColumn = mode === 'device'
  const noDataRow = items.length
    ? ''
    : `
      <tr class="guard-empty-row" data-guard-empty="static">
        <td colspan="${hasDeviceColumn ? 6 : 5}" class="text-muted">No recent pressure in this window.</td>
      </tr>
    `
  return `
    <div class="guard-section">
      <div class="guard-section-header">
        <h4>${esc(title)}</h4>
        <span class="badge badge-gray">${items.length ? `${items.length} tracked` : 'quiet'}</span>
      </div>
      <div class="table-wrap">
        <table class="guard-table">
          <thead>
            <tr>
              <th>User</th>
              ${hasDeviceColumn ? '<th>Device</th>' : ''}
              <th>Sessions</th>
              <th>Requests</th>
              <th>Tokens</th>
              <th>Heat</th>
            </tr>
          </thead>
          <tbody>
            ${items.length ? items.map((item) => renderRoutingGuardRow(item, limits, mode)).join('') : ''}
            ${noDataRow}
            <tr class="guard-empty-row" data-guard-empty="filtered" hidden>
              <td colspan="${hasDeviceColumn ? 6 : 5}" class="text-muted">No rows match the current filter.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>`
}

function renderRoutingGuardRow(item, limits, mode) {
  const sessionPct = clampPct(item.activeSessionUtilizationPercent ?? 0)
  const requestPct = clampPct(item.requestUtilizationPercent ?? 0)
  const tokenPct = clampPct(item.tokenUtilizationPercent ?? 0)
  const peakPct = Math.max(sessionPct, requestPct, tokenPct)
  const heatLevel = guardHeatLevel(peakPct)
  const hasDeviceColumn = mode === 'device'
  return `
    <tr
      class="guard-row guard-row-${guardHeatClass(peakPct)}"
      data-guard-heat-level="${esc(heatLevel)}"
      data-user-id="${esc(item.userId)}"
      data-guard-focus="${mode === 'device' ? 'sessions' : 'overview'}"
      ${hasDeviceColumn ? `data-client-device-id="${esc(item.clientDeviceId)}"` : ''}
    >
      <td>
        <div class="guard-identity">
          <span class="mono">${esc(item.userId)}</span>
        </div>
      </td>
      ${hasDeviceColumn ? `<td><span class="badge badge-blue mono">${esc(item.clientDeviceId)}</span></td>` : ''}
      <td>${guardMeter(item.activeSessions, mode === 'device' ? limits.clientDeviceActiveSessions : limits.userActiveSessions, sessionPct)}</td>
      <td>${guardMeter(item.recentRequests, mode === 'device' ? limits.clientDeviceRecentRequests : limits.userRecentRequests, requestPct)}</td>
      <td>${guardMeter(formatTokenCount(item.recentTokens), formatTokenCount(mode === 'device' ? limits.clientDeviceRecentTokens : limits.userRecentTokens), tokenPct)}</td>
      <td>${guardHeatBadge(peakPct)}</td>
    </tr>`
}

function guardMeter(current, limit, pct) {
  const width = clampPct(pct)
  return `
    <div class="guard-meter">
      <div class="guard-meter-label">
        <span>${esc(String(current))}</span>
        <span class="text-muted">/ ${esc(String(limit ?? '-'))}</span>
      </div>
      <div class="progress guard-meter-progress">
        <div class="progress-bar ${utilizationColor(width)}" style="width:${width}%"></div>
      </div>
      <div class="guard-meter-pct">${width}%</div>
    </div>`
}

function guardLimitPill(label, value) {
  return `
    <span class="guard-limit-pill">
      <span>${esc(label)}</span>
      <strong>${esc(String(value ?? '-'))}</strong>
    </span>`
}

function guardHeatBadge(pct) {
  const label = guardHeatLevel(pct)
  return `<span class="badge ${guardHeatBadgeClass(pct)}">${esc(label)} · ${pct}%</span>`
}

function guardHeatBadgeClass(pct) {
  if (pct >= 90) return 'badge-red'
  if (pct >= 75) return 'badge-yellow'
  if (pct >= 55) return 'badge-blue'
  return 'badge-green'
}

function guardHeatClass(pct) {
  if (pct >= 90) return 'critical'
  if (pct >= 75) return 'warning'
  if (pct >= 55) return 'watch'
  return 'stable'
}

function guardHeatLevel(pct) {
  if (pct >= 90) return 'critical'
  if (pct >= 75) return 'hot'
  if (pct >= 55) return 'warming'
  return 'stable'
}

function bindRoutingGuardInteractions(container) {
  container.querySelectorAll('[data-guard-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      guardFilterMode = button.dataset.guardFilter === 'hot' ? 'hot' : 'all'
      applyRoutingGuardFilter(container)
    })
  })

  container.querySelectorAll('.guard-row[data-user-id]').forEach((row) => {
    row.addEventListener('click', () => {
      const userId = row.dataset.userId
      if (!userId) return
      try {
        sessionStorage.setItem(PENDING_USER_ID_KEY, userId)
        sessionStorage.setItem(PENDING_USER_FOCUS_KEY, row.dataset.guardFocus || 'overview')
        if (row.dataset.clientDeviceId) {
          sessionStorage.setItem(PENDING_CLIENT_DEVICE_ID_KEY, row.dataset.clientDeviceId)
        } else {
          sessionStorage.removeItem(PENDING_CLIENT_DEVICE_ID_KEY)
        }
      } catch {}
      location.hash = 'users'
    })
  })

  applyRoutingGuardFilter(container)
}

function applyRoutingGuardFilter(container) {
  const hotOnly = guardFilterMode === 'hot'
  container.querySelectorAll('[data-guard-filter]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.guardFilter === guardFilterMode)
  })

  container.querySelectorAll('.guard-table tbody').forEach((tbody) => {
    const totalRows = tbody.querySelectorAll('.guard-row').length
    let visibleRows = 0
    tbody.querySelectorAll('.guard-row').forEach((row) => {
      const heatLevel = row.dataset.guardHeatLevel || 'stable'
      const shouldShow = !hotOnly || heatLevel === 'hot' || heatLevel === 'critical'
      row.hidden = !shouldShow
      if (shouldShow) visibleRows += 1
    })

    const staticEmptyRow = tbody.querySelector('[data-guard-empty="static"]')
    const filteredEmptyRow = tbody.querySelector('[data-guard-empty="filtered"]')
    if (staticEmptyRow) {
      staticEmptyRow.hidden = totalRows !== 0
    }
    if (filteredEmptyRow) {
      filteredEmptyRow.hidden = totalRows === 0 || visibleRows !== 0
    }
  })
}

function renderAccountTable(accounts) {
  if (!accounts.length) return '<div class="empty-state">No accounts</div>'

  return `
    <div class="card">
      <div class="card-header"><h3 class="card-title">Account Details</h3></div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Label</th>
              <th>Group</th>
              <th>Status</th>
              <th>Scheduler</th>
              <th>Selectable</th>
              <th>Sessions</th>
              <th>Quota</th>
              <th>Health</th>
              <th>Total</th>
              <th>Blocked</th>
            </tr>
          </thead>
          <tbody>
            ${accounts.map((a) => {
              const rl = a.rateLimitedUntil && a.rateLimitedUntil > Date.now()
              const rlText = rl ? new Date(a.rateLimitedUntil).toLocaleTimeString() : '-'
              return `
                <tr>
                  <td class="mono">${esc(a.accountId?.slice(0, 8) ?? '-')}</td>
                  <td>${a.label ? esc(a.label) : '<span class="text-muted">-</span>'}</td>
                  <td>${resolveRoutingGroupId(a) ? `<span class="badge badge-blue">${esc(resolveRoutingGroupId(a))}</span>` : '<span class="text-muted">-</span>'}</td>
                  <td>${statusBadge(a.status)}</td>
                  <td>${schedulerBadge(a)}</td>
                  <td>${a.isSelectable ? '<span class="text-green">Yes</span>' : '<span class="text-red">No</span>'}</td>
                  <td>${a.activeSessions} / ${a.maxSessions}</td>
                  <td>${scorePct(a.quotaScore)}</td>
                  <td>
                    <div style="display:flex;align-items:center;gap:.5rem">
                      <div class="progress" style="width:60px">
                        <div class="progress-bar ${healthColor(a.healthScore)}" style="width:${Math.round(a.healthScore * 100)}%"></div>
                      </div>
                      <span>${(a.healthScore * 100).toFixed(0)}%</span>
                    </div>
                  </td>
                  <td>${scorePct(a.totalScore)}</td>
                  <td class="${a.blockedReason ? 'text-red' : 'text-muted'}">${esc(a.blockedReason || rlText)}</td>
                </tr>`
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>`
}

function statusBadge(status) {
  const map = { active: 'badge-green', expired: 'badge-yellow', revoked: 'badge-red', error: 'badge-red', cooldown: 'badge-yellow', temp_error: 'badge-yellow' }
  return `<span class="badge ${map[status] ?? 'badge-gray'}">${esc(status ?? 'unknown')}</span>`
}

function schedulerBadge(account) {
  const state = String(account.schedulerState || 'enabled')
  if (state === 'auto_blocked') {
    return '<span class="badge badge-red">auto_blocked</span>'
  }
  if (state === 'draining') {
    return '<span class="badge badge-yellow">draining</span>'
  }
  if (!account.schedulerEnabled || state === 'paused') {
    return '<span class="badge badge-gray">paused</span>'
  }
  return '<span class="badge badge-green">enabled</span>'
}

function healthColor(score) {
  if (score >= 0.7) return 'progress-green'
  if (score >= 0.4) return 'progress-yellow'
  return 'progress-red'
}

function utilizationColor(pct) {
  if (pct < 60) return 'progress-green'
  if (pct < 85) return 'progress-yellow'
  return 'progress-red'
}

function scorePct(value) {
  return `${Math.round((value ?? 0) * 100)}%`
}

function formatWindow(windowMs) {
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    return 'recent'
  }
  if (windowMs % (60 * 60 * 1000) === 0) {
    return `${Math.round(windowMs / (60 * 60 * 1000))}h`
  }
  if (windowMs % (60 * 1000) === 0) {
    return `${Math.round(windowMs / (60 * 1000))}m`
  }
  return `${Math.round(windowMs / 1000)}s`
}

function formatTokenCount(value) {
  const num = Number(value ?? 0)
  if (!Number.isFinite(num)) return '-'
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k`
  return String(Math.round(num))
}

function clampPct(value) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
}

function renderSessionRoutes(routes) {
  if (!routes.length) return ''
  return `
    <div class="card">
      <div class="card-header"><h3 class="card-title">Session Routes</h3></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Session</th><th>Account</th><th>Generation</th><th>Upstream Session</th><th>Burn 7d</th><th>Pending Handoff</th></tr></thead>
          <tbody>
            ${routes.map((route) => `
              <tr>
                <td class="mono">${esc(route.sessionKey?.slice(0, 24) ?? '-')}</td>
                <td class="mono">${esc(route.accountId?.slice(0, 24) ?? '-')}</td>
                <td>${route.generation}</td>
                <td class="mono">${esc(route.upstreamSessionId?.slice(0, 24) ?? '-')}</td>
                <td>${scorePct(route.generationBurn7d)}</td>
                <td>${route.pendingHandoffSummary ? '<span class="badge badge-yellow">pending</span>' : '<span class="text-muted">-</span>'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>`
}

function renderRecentHandoffs(handoffs) {
  if (!handoffs.length) return ''
  return `
    <div class="card">
      <div class="card-header"><h3 class="card-title">Recent Handoffs</h3></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Session</th><th>From</th><th>To</th><th>Reason</th><th>Generation</th><th>Created</th></tr></thead>
          <tbody>
            ${handoffs.map((handoff) => `
              <tr>
                <td class="mono">${esc(handoff.sessionKey?.slice(0, 24) ?? '-')}</td>
                <td class="mono">${esc((handoff.fromAccountId || '-').slice(0, 24))}</td>
                <td class="mono">${esc(handoff.toAccountId?.slice(0, 24) ?? '-')}</td>
                <td>${esc(handoff.reason)}</td>
                <td>${handoff.generation}</td>
                <td>${esc(new Date(handoff.createdAt).toLocaleString())}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>`
}

function esc(str) {
  const d = document.createElement('div')
  d.textContent = str
  return d.innerHTML
}
