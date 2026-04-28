import * as api from '../api.js'

const DASHBOARD_USAGE_WINDOW_DAYS = 30

export async function renderDashboard() {
  const container = document.getElementById('page-dashboard')
  container.innerHTML = renderDashboardLoadingSkeleton()

  try {
    const usageSince = isoDaysAgo(DASHBOARD_USAGE_WINDOW_DAYS)
    const [health, schedulerStats, { proxies }, { accounts: allAccounts }, usageSummary, { accounts: usageAccounts }] = await Promise.all([
      api.healthz(),
      api.getSchedulerStats(),
      api.listProxies(),
      api.listAccounts(),
      api.getUsageSummary(usageSince),
      api.getUsageAccounts(usageSince),
    ])
    const usageDataset = {
      summary: usageSummary,
      accounts: usageAccounts ?? [],
    }

    const globalStats = schedulerStats.global ?? {}
    const schedulerAccounts = schedulerStats.accounts ?? []
    const usageByAccountId = new Map(usageDataset.accounts.map((account) => [account.accountId, account]))
    const selectableCount = schedulerAccounts.filter((account) => account.isSelectable).length
    const degradedCount = schedulerAccounts.filter((account) => (account.healthScore ?? 1) < 0.55).length

    container.innerHTML = `
      <section class="dashboard-hero-card">
        <div class="dashboard-hero-copy">
          <div class="section-kicker">Relay Control</div>
          <h2 class="dashboard-hero-title">Operate account pool, routing health, and traffic burn from one surface.</h2>
          <p class="dashboard-hero-subtitle">This overview stays focused on service posture. Usage analytics now live on their own page, so Overview can stay opinionated and actionable.</p>
        </div>
        <div class="dashboard-hero-meta">
          <div class="dashboard-status-row">
            ${renderStatusBadge(health.ok ? 'healthy' : 'degraded', health.ok ? 'Relay Healthy' : 'Relay Degraded')}
            <span class="mini-pill"><strong>${esc(health.nextAccountEmail || 'n/a')}</strong><span>Next account</span></span>
          </div>
          <div class="dashboard-meta-grid">
            ${overviewCard(String(health.activeAccountCount ?? 0), 'Active accounts', 'Accounts currently considered active by the relay')}
            ${overviewCard(String(selectableCount), 'Ready for routing', 'Accounts scheduler can pick for new sessions')}
            ${overviewCard(String(globalStats.totalActiveSessions ?? 0), 'Active sessions', 'Concurrent routed sessions across the pool')}
            ${overviewCard(String(globalStats.totalCapacity ?? 0), 'Total capacity', 'Nominal session capacity before overflow')}
            ${overviewCard(String(proxies?.length ?? 0), 'Proxy exits', 'Distinct VPN / proxy exits attached to accounts')}
            ${overviewCard(String(degradedCount), 'Needs attention', 'Accounts with lower health score or degraded posture')}
          </div>
        </div>
      </section>

      <section class="card dashboard-snapshot-card">
        <div class="card-header">
          <div>
            <div class="section-kicker">Traffic Snapshot</div>
            <h3 class="card-title">Usage moved into its own workspace</h3>
            <p class="card-subtitle">Overview now only shows the current burn snapshot. Open Usage for trends, model mix, and account-level pressure.</p>
          </div>
          <div class="workspace-inline-actions">
            <a class="btn btn-sm btn-primary" href="#usage">Open Usage</a>
          </div>
        </div>
        <div class="dashboard-snapshot-grid">
          ${overviewCard(fmtNum(usageDataset.summary.totalRequests), '30d Requests', 'Successful relay requests in the current window')}
          ${overviewCard(fmtTokens(usageDataset.summary.totalInputTokens), '30d Input', 'Prompt-side token burn')}
          ${overviewCard(fmtTokens(usageDataset.summary.totalOutputTokens), '30d Output', 'Completion-side token burn')}
          ${overviewCard(String(usageDataset.summary.uniqueModels), 'Models', 'Distinct model ids seen in the window')}
        </div>
        ${renderUsageTopline(usageDataset.accounts)}
      </section>

      <div class="card dashboard-account-card">
        <div class="card-header">
          <div>
            <div class="section-kicker">Accounts</div>
            <h3 class="card-title">Routing posture by account</h3>
            <p class="card-subtitle">This table blends scheduler state with recent traffic so you can spot cold, overloaded, or unhealthy accounts faster.</p>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Account</th>
                <th>Plan</th>
                <th>Proxy</th>
                <th>Scheduler</th>
                <th>Health</th>
                <th style="text-align:right">30d Input</th>
                <th>Last Used</th>
              </tr>
            </thead>
            <tbody>
              ${allAccounts?.length ? allAccounts.map((account) => {
                const scheduler = schedulerAccounts.find((item) => item.accountId === account.id) ?? {}
                const proxy = proxies?.find((item) => item.url === account.proxyUrl)
                const usage = usageByAccountId.get(account.id)
                return `
                  <tr>
                    <td>
                      <div class="usage-account-cell">
                        <div class="usage-account-main">${esc(account.emailAddress || account.id)}</div>
                        <div class="usage-account-sub">${esc(account.id)}</div>
                      </div>
                    </td>
                    <td>${renderPlanBadge(account.label)}</td>
                    <td>${proxy ? `<a href="#network" class="inline-link">${esc(proxy.label)}</a>` : '<span class="text-muted">-</span>'}</td>
                    <td>${renderSchedulerState(account, scheduler)}</td>
                    <td>
                      <div class="health-inline">
                        <div class="progress progress-md">
                          <div class="progress-bar ${healthColor(scheduler.healthScore ?? 1)}" style="width:${Math.round((scheduler.healthScore ?? 1) * 100)}%"></div>
                        </div>
                        <span class="text-dim">${Math.round((scheduler.healthScore ?? 1) * 100)}%</span>
                      </div>
                    </td>
                    <td style="text-align:right">${usage ? fmtTokens(usage.totalInputTokens) : '<span class="text-muted">0</span>'}</td>
                    <td>${usage?.lastUsedAt ? timeAgo(usage.lastUsedAt) : '<span class="text-muted">No recent traffic</span>'}</td>
                  </tr>
                `
              }).join('') : '<tr><td colspan="7" class="text-muted">No accounts configured.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    `
  } catch (err) {
    container.innerHTML = `
      <div class="card card-error">
        <div class="card-header">
          <h3 class="card-title">Overview failed to load</h3>
        </div>
        <p class="text-red">${esc(err.message)}</p>
      </div>
    `
  }
}

function renderDashboardLoadingSkeleton() {
  return `
    <section class="dashboard-hero-card">
      <div class="dashboard-hero-copy">
        <div class="skeleton-block" style="width:7rem;height:.75rem;margin-bottom:.7rem"></div>
        <div class="skeleton-block" style="width:28rem;max-width:100%;height:2.3rem;margin-bottom:.7rem"></div>
        <div class="skeleton-block" style="width:34rem;max-width:100%;height:1rem"></div>
      </div>
      <div class="dashboard-hero-meta">
        <div class="skeleton-block" style="height:2.5rem;margin-bottom:1rem"></div>
        <div class="dashboard-meta-grid">
          ${Array.from({ length: 6 }, () => '<div class="skeleton-card"></div>').join('')}
        </div>
      </div>
    </section>
    <div class="skeleton-block" style="height:24rem"></div>
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

function renderStatusBadge(tone, label) {
  const klass = tone === 'healthy' ? 'badge-green' : tone === 'warning' ? 'badge-yellow' : 'badge-red'
  return `<span class="badge ${klass}">${esc(label)}</span>`
}

function renderPlanBadge(label) {
  if (!label) return '<span class="text-muted">-</span>'
  const badgeClass = label.toLowerCase().includes('max') ? 'badge-blue' : 'badge-green'
  return `<span class="badge ${badgeClass}">${esc(label)}</span>`
}

function renderUsageTopline(accounts) {
  const hottest = accounts?.[0]
  if (!hottest) {
    return '<div class="account-inline-hint" style="margin-top:.85rem">当前窗口没有 usage 数据，去 Usage 页面可以切换周期继续看。</div>'
  }

  return `
    <div class="account-inline-hint" style="margin-top:.85rem">
      当前最热账号是 <strong>${esc(hottest.label || hottest.emailAddress || hottest.accountId)}</strong>，
      30d 输入 ${esc(fmtTokens(hottest.totalInputTokens))}，请求数 ${esc(fmtNum(hottest.totalRequests))}。
      <a href="#usage" class="inline-link">查看完整细分</a>
    </div>
  `
}

function renderSchedulerState(account, scheduler) {
  if (scheduler.isSelectable) {
    return '<span class="badge badge-green">Ready</span>'
  }

  const label = esc(scheduler.status || account.status || 'paused')
  if (label.includes('drain')) {
    return `<span class="badge badge-yellow">${label}</span>`
  }
  if (label.includes('error') || label.includes('revoked')) {
    return `<span class="badge badge-red">${label}</span>`
  }
  return `<span class="badge badge-gray">${label}</span>`
}

function healthColor(score) {
  if (score >= 0.7) return 'progress-green'
  if (score >= 0.4) return 'progress-yellow'
  return 'progress-red'
}

function fmtTokens(value) {
  if (!value) return '0'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(value)
}

function fmtNum(value) {
  return Number(value || 0).toLocaleString()
}

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function esc(str) {
  const div = document.createElement('div')
  div.textContent = str ?? ''
  return div.innerHTML
}
