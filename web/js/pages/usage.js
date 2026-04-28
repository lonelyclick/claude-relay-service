import * as api from '../api.js'

let currentPeriod = '30'
let currentSelectedAccountId = null

const detailCache = new Map()

export async function renderUsage() {
  const container = document.getElementById('page-usage')
  return renderUsageSection(container)
}

export async function loadUsageDataset(period = currentPeriod) {
  const since = periodToSince(period)
  const [summary, { accounts }, { trend }] = await Promise.all([
    api.getUsageSummary(since),
    api.getUsageAccounts(since),
    api.getUsageTrend(period === 'all' ? 365 : Number(period)),
  ])

  return {
    period,
    summary,
    accounts,
    trend,
  }
}

export async function renderUsageSection(container, options = {}) {
  if (!container) return

  const { embedded = false, dataset = null } = options
  container.innerHTML = renderUsageLoadingSkeleton(embedded)

  try {
    const nextDataset = dataset ?? await loadUsageDataset(currentPeriod)
    currentPeriod = nextDataset.period
    const selectedAccountId = resolveSelectedAccountId(nextDataset.accounts)

    container.innerHTML = `
      <section class="usage-shell ${embedded ? 'usage-shell-embedded' : ''}">
        <div class="section-toolbar usage-toolbar">
          <div>
            <div class="section-kicker">Usage Lens</div>
            <h2 class="section-title">Traffic, token burn, and account pressure</h2>
            <p class="section-subtitle">Track throughput, spot hot accounts, and catch rate-limit pressure before it becomes routing instability.</p>
          </div>
          <div class="period-group" role="group" aria-label="Usage period">
            ${['7', '30', '90', 'all'].map((period) => `
              <button class="period-btn ${period === currentPeriod ? 'period-btn-active' : ''}" data-period="${period}">
                ${period === 'all' ? 'All' : `${period}d`}
              </button>
            `).join('')}
          </div>
        </div>

        <div class="usage-summary-grid">
          ${statCard(fmtNum(nextDataset.summary.totalRequests), 'Requests', 'Final successful relay requests in the selected window')}
          ${statCard(fmtTokens(nextDataset.summary.totalInputTokens), 'Input Tokens', 'Prompt-side tokens consumed')}
          ${statCard(fmtTokens(nextDataset.summary.totalOutputTokens), 'Output Tokens', 'Completion-side tokens generated')}
          ${statCard(fmtTokens(nextDataset.summary.totalCacheReadTokens), 'Cache Read', 'Prompt cache hits accepted by upstream')}
          ${statCard(fmtTokens(nextDataset.summary.totalCacheCreationTokens), 'Cache Write', 'Prompt cache writes sent upstream')}
          ${statCard(String(nextDataset.summary.uniqueModels), 'Models', 'Distinct model ids seen in the selected window')}
        </div>

        <div class="usage-insight-grid">
          ${renderUsageSignalCard(nextDataset)}
          ${renderTrendChart(nextDataset.trend)}
        </div>

        <div class="card usage-table-card">
          <div class="card-header">
            <div>
              <h3 class="card-title">Account Activity</h3>
              <p class="card-subtitle">Sorted by input token burn. Rate-limit cells hydrate from recent account detail snapshots.</p>
            </div>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Account</th>
                  <th style="text-align:right">Requests</th>
                  <th style="text-align:right">Input</th>
                  <th style="text-align:right">Output</th>
                  <th style="text-align:right">Cache Read</th>
                  <th>Rate Limit</th>
                  <th>Last Used</th>
                </tr>
              </thead>
              <tbody>
                ${nextDataset.accounts.length ? nextDataset.accounts.map((account) => `
                  <tr class="usage-account-row ${account.accountId === selectedAccountId ? 'is-selected' : ''}" data-account-id="${esc(account.accountId)}">
                    <td>
                      <div class="usage-account-cell">
                        <div class="usage-account-main">${esc(account.label || account.emailAddress || account.accountId)}</div>
                        <div class="usage-account-sub">${esc(account.emailAddress || account.accountId)}</div>
                      </div>
                    </td>
                    <td style="text-align:right">${fmtNum(account.totalRequests)}</td>
                    <td style="text-align:right">${fmtTokens(account.totalInputTokens)}</td>
                    <td style="text-align:right">${fmtTokens(account.totalOutputTokens)}</td>
                    <td style="text-align:right">${fmtTokens(account.totalCacheReadTokens)}</td>
                    <td class="usage-rate-limit-cell" data-account-id="${esc(account.accountId)}">
                      ${renderInlineLoading('Loading latest status...')}
                    </td>
                    <td class="text-dim">${account.lastUsedAt ? timeAgo(account.lastUsedAt) : '-'}</td>
                  </tr>
                `).join('') : '<tr><td colspan="7" class="text-muted">No usage data in this window.</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>

        <div class="usage-account-detail"></div>
      </section>
    `

    container.querySelectorAll('.period-btn').forEach((button) => {
      button.addEventListener('click', async () => {
        const nextPeriod = button.dataset.period
        if (!nextPeriod || nextPeriod === currentPeriod) {
          return
        }
        currentPeriod = nextPeriod
        currentSelectedAccountId = null
        await renderUsageSection(container, { embedded })
      })
    })

    container.querySelectorAll('.usage-account-row').forEach((row) => {
      row.addEventListener('click', async () => {
        const { accountId } = row.dataset
        if (!accountId) return
        currentSelectedAccountId = accountId
        updateSelectedUsageRow(container, accountId)
        await loadAccountDetail(container, accountId)
      })
    })

    void hydrateRateLimitCells(container, nextDataset.accounts)

    if (selectedAccountId) {
      currentSelectedAccountId = selectedAccountId
      await loadAccountDetail(container, selectedAccountId)
    }
  } catch (err) {
    container.innerHTML = `
      <div class="card card-error">
        <div class="card-header">
          <h3 class="card-title">Usage failed to load</h3>
        </div>
        <p class="text-red">${esc(err.message)}</p>
      </div>
    `
  }
}

function resolveSelectedAccountId(accounts) {
  if (!accounts.length) return null
  if (currentSelectedAccountId && accounts.some((account) => account.accountId === currentSelectedAccountId)) {
    return currentSelectedAccountId
  }
  return accounts[0].accountId
}

async function hydrateRateLimitCells(container, accounts) {
  if (!accounts.length) return

  let cursor = 0
  const concurrency = Math.min(3, accounts.length)
  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < accounts.length) {
      const account = accounts[cursor]
      cursor += 1
      const cell = container.querySelector(`.usage-rate-limit-cell[data-account-id="${CSS.escape(account.accountId)}"]`)
      if (!cell) continue
      try {
        const detail = await getUsageDetail(account.accountId)
        cell.innerHTML = renderRateLimitSummary(detail.rateLimits)
      } catch {
        cell.innerHTML = '<span class="text-muted">Unavailable</span>'
      }
    }
  })

  await Promise.all(workers)
}

async function getUsageDetail(accountId) {
  const cacheKey = `${currentPeriod}:${accountId}`
  if (detailCache.has(cacheKey)) {
    return detailCache.get(cacheKey)
  }
  const detail = await api.getUsageAccountDetail(accountId, periodToSince(currentPeriod))
  detailCache.set(cacheKey, detail)
  return detail
}

async function loadAccountDetail(container, accountId) {
  const detailEl = container.querySelector('.usage-account-detail')
  if (!detailEl) return

  detailEl.innerHTML = `
    <div class="card usage-detail-card">
      <div class="detail-skeleton-grid">
        <div class="skeleton-block" style="height:12rem"></div>
        <div class="skeleton-block" style="height:12rem"></div>
      </div>
    </div>
  `

  updateSelectedUsageRow(container, accountId)

  try {
    const detail = await getUsageDetail(accountId)
    detailEl.innerHTML = `
      <div class="card usage-detail-card">
        <div class="card-header">
          <div>
            <h3 class="card-title">${esc(detail.label || detail.emailAddress || detail.accountId)}</h3>
            <p class="card-subtitle">${esc(detail.emailAddress || detail.accountId)}</p>
          </div>
          <div class="usage-detail-pill-row">
            ${renderMiniPill(fmtNum(detail.totalRequests), 'Requests')}
            ${renderMiniPill(fmtTokens(detail.totalInputTokens + detail.totalOutputTokens), 'Total Tokens')}
          </div>
        </div>

        <div class="usage-detail-grid">
          <section class="detail-panel">
            <div class="detail-panel-header">
              <h4>Rate Limit Snapshot</h4>
              ${renderRateLimitBadge(detail.rateLimits.latestStatus)}
            </div>
            ${renderRateLimitDetail(detail.rateLimits)}
          </section>
          <section class="detail-panel">
            <div class="detail-panel-header">
              <h4>Model Breakdown</h4>
              <span class="detail-panel-meta">${detail.byModel.length} models</span>
            </div>
            ${renderModelBreakdown(detail.byModel)}
          </section>
        </div>
      </div>
    `
  } catch (err) {
    detailEl.innerHTML = `
      <div class="card card-error">
        <div class="card-header">
          <h3 class="card-title">Account detail failed to load</h3>
        </div>
        <p class="text-red">${esc(err.message)}</p>
      </div>
    `
  }
}

function updateSelectedUsageRow(container, accountId) {
  container.querySelectorAll('.usage-account-row').forEach((row) => {
    row.classList.toggle('is-selected', row.dataset.accountId === accountId)
  })
}

function renderUsageSignalCard(dataset) {
  const hottestAccount = dataset.accounts[0] ?? null
  const totalTokens = dataset.summary.totalInputTokens + dataset.summary.totalOutputTokens
  const avgTokensPerRequest = dataset.summary.totalRequests
    ? Math.round(totalTokens / dataset.summary.totalRequests)
    : 0

  return `
    <div class="card usage-signal-card">
      <div class="card-header">
        <div>
          <div class="section-kicker">Signal</div>
          <h3 class="card-title">Window summary</h3>
        </div>
      </div>
      <div class="usage-signal-grid">
        ${renderSignalMetric('Total Tokens', fmtTokens(totalTokens))}
        ${renderSignalMetric('Avg / Request', fmtNum(avgTokensPerRequest))}
        ${renderSignalMetric('Active Accounts', String(dataset.summary.uniqueAccounts))}
      </div>
      <div class="usage-signal-highlight">
        <div class="usage-signal-label">Hottest account</div>
        <div class="usage-signal-value">${esc(hottestAccount ? (hottestAccount.label || hottestAccount.emailAddress || hottestAccount.accountId) : 'No traffic yet')}</div>
        <div class="usage-signal-note">${hottestAccount
          ? `${fmtTokens(hottestAccount.totalInputTokens)} input tokens across ${fmtNum(hottestAccount.totalRequests)} requests`
          : 'No account activity recorded in this window.'}</div>
      </div>
    </div>
  `
}

function renderSignalMetric(label, value) {
  return `
    <div class="usage-signal-metric">
      <div class="usage-signal-metric-label">${esc(label)}</div>
      <div class="usage-signal-metric-value">${esc(value)}</div>
    </div>
  `
}

function renderTrendChart(trend) {
  if (!trend?.length) {
    return `
      <div class="card trend-card">
        <div class="card-header">
          <div>
            <h3 class="card-title">Daily Trend</h3>
            <p class="card-subtitle">No traffic data in the selected window.</p>
          </div>
        </div>
      </div>
    `
  }

  const width = 920
  const height = 240
  const paddingX = 28
  const top = 24
  const bottom = 44
  const chartHeight = height - top - bottom
  const tokenMax = Math.max(...trend.map((point) => point.totalInputTokens + point.totalOutputTokens), 1)
  const requestMax = Math.max(...trend.map((point) => point.totalRequests), 1)
  const step = trend.length > 1 ? (width - paddingX * 2) / (trend.length - 1) : 0
  const barWidth = Math.max(12, Math.min(42, step * 0.56 || 42))

  const linePoints = trend.map((point, index) => {
    const x = paddingX + step * index
    const y = top + chartHeight - ((point.totalRequests / requestMax) * chartHeight)
    return `${x},${y}`
  }).join(' ')

  const last = trend[trend.length - 1]
  const strongest = trend.reduce((max, point) =>
    (point.totalInputTokens + point.totalOutputTokens) > (max.totalInputTokens + max.totalOutputTokens) ? point : max,
  trend[0])

  return `
    <div class="card trend-card">
      <div class="card-header">
        <div>
          <h3 class="card-title">Daily Trend</h3>
          <p class="card-subtitle">Blue bars show tokens, amber line shows request count.</p>
        </div>
        <div class="trend-legend">
          <span class="legend-item"><span class="legend-swatch legend-swatch-bar"></span>Tokens</span>
          <span class="legend-item"><span class="legend-swatch legend-swatch-line"></span>Requests</span>
        </div>
      </div>
      <svg class="trend-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Usage trend chart">
        <defs>
          <linearGradient id="trend-bar-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stop-color="rgba(59,130,246,0.95)"></stop>
            <stop offset="100%" stop-color="rgba(14,165,233,0.28)"></stop>
          </linearGradient>
          <linearGradient id="trend-line-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stop-color="rgba(245,158,11,0.28)"></stop>
            <stop offset="100%" stop-color="rgba(245,158,11,0)"></stop>
          </linearGradient>
        </defs>
        <line x1="${paddingX}" y1="${top + chartHeight}" x2="${width - paddingX}" y2="${top + chartHeight}" class="trend-axis"></line>
        ${trend.map((point, index) => {
          const totalTokens = point.totalInputTokens + point.totalOutputTokens
          const x = paddingX + step * index
          const barHeight = Math.max(6, (totalTokens / tokenMax) * chartHeight)
          const barY = top + chartHeight - barHeight
          return `
            <g>
              <title>${point.date}: ${fmtNum(point.totalRequests)} requests, ${fmtTokens(totalTokens)} tokens</title>
              <rect x="${x - barWidth / 2}" y="${barY}" width="${barWidth}" height="${barHeight}" rx="10" fill="url(#trend-bar-fill)"></rect>
            </g>
          `
        }).join('')}
        <polyline points="${linePoints}" fill="none" class="trend-line"></polyline>
        ${trend.map((point, index) => {
          const x = paddingX + step * index
          const y = top + chartHeight - ((point.totalRequests / requestMax) * chartHeight)
          return `<circle cx="${x}" cy="${y}" r="4" class="trend-point"></circle>`
        }).join('')}
        <text x="${paddingX}" y="${height - 12}" class="trend-label">${trend[0].date}</text>
        <text x="${width - paddingX}" y="${height - 12}" text-anchor="end" class="trend-label">${last.date}</text>
      </svg>
      <div class="trend-footer">
        <div class="trend-footer-item">
          <span class="trend-footer-label">Peak token day</span>
          <strong>${strongest.date}</strong>
          <span>${fmtTokens(strongest.totalInputTokens + strongest.totalOutputTokens)}</span>
        </div>
        <div class="trend-footer-item">
          <span class="trend-footer-label">Latest day</span>
          <strong>${last.date}</strong>
          <span>${fmtNum(last.totalRequests)} requests</span>
        </div>
      </div>
    </div>
  `
}

function renderRateLimitSummary(rateLimits) {
  if (!rateLimits || (!rateLimits.latestStatus && rateLimits.latest5hUtilization === null && rateLimits.latest7dUtilization === null)) {
    return '<span class="text-muted">No snapshot</span>'
  }

  const highestUtilization = maxDefined(rateLimits.latest5hUtilization, rateLimits.latest7dUtilization)
  const utilizationText = highestUtilization === null ? 'No utilization %' : `${Math.round(highestUtilization * 100)}% peak`

  return `
    <div class="usage-rate-limit-stack">
      ${renderRateLimitBadge(rateLimits.latestStatus)}
      <span class="usage-rate-limit-meta">${esc(utilizationText)}</span>
    </div>
  `
}

function renderRateLimitDetail(rateLimits) {
  if (!rateLimits || (!rateLimits.latestStatus && rateLimits.latest5hUtilization === null && rateLimits.latest7dUtilization === null)) {
    return '<div class="text-muted">No recent rate-limit snapshot available.</div>'
  }

  return `
    <div class="rate-limit-detail">
      ${renderUtilizationRow('5h utilization', rateLimits.latest5hUtilization)}
      ${renderUtilizationRow('7d utilization', rateLimits.latest7dUtilization)}
    </div>
  `
}

function renderUtilizationRow(label, value) {
  if (value === null || value === undefined) {
    return `
      <div class="util-row">
        <div class="util-row-label">${esc(label)}</div>
        <div class="text-muted">No data</div>
      </div>
    `
  }

  const pct = Math.round(value * 100)
  return `
    <div class="util-row">
      <div class="util-row-label-row">
        <span class="util-row-label">${esc(label)}</span>
        <span class="util-row-value">${pct}%</span>
      </div>
      <div class="progress progress-lg">
        <div class="progress-bar ${utilizationColor(value)}" style="width:${Math.min(100, pct)}%"></div>
      </div>
    </div>
  `
}

function renderModelBreakdown(models) {
  if (!models?.length) {
    return '<div class="text-muted">No model breakdown recorded in this window.</div>'
  }

  return `
    <div class="model-breakdown-list">
      ${models.slice(0, 6).map((model) => `
        <div class="model-breakdown-row">
          <div>
            <div class="model-breakdown-name mono">${esc(model.model || '(unknown)')}</div>
            <div class="model-breakdown-meta">${fmtNum(model.totalRequests)} requests</div>
          </div>
          <div class="model-breakdown-values">
            <span>${fmtTokens(model.totalInputTokens)}</span>
            <span class="text-dim">in</span>
            <span>${fmtTokens(model.totalOutputTokens)}</span>
            <span class="text-dim">out</span>
          </div>
        </div>
      `).join('')}
    </div>
  `
}

function renderRateLimitBadge(status) {
  if (!status) {
    return '<span class="badge badge-gray">Unknown</span>'
  }
  if (status === 'allowed') {
    return '<span class="badge badge-green">Allowed</span>'
  }
  if (status.includes('warning')) {
    return `<span class="badge badge-yellow">${esc(status)}</span>`
  }
  return `<span class="badge badge-red">${esc(status)}</span>`
}

function renderMiniPill(value, label) {
  return `
    <span class="mini-pill">
      <strong>${esc(value)}</strong>
      <span>${esc(label)}</span>
    </span>
  `
}

function renderInlineLoading(label) {
  return `
    <span class="inline-loading">
      <span class="inline-loading-dot"></span>
      <span>${esc(label)}</span>
    </span>
  `
}

function renderUsageLoadingSkeleton(embedded) {
  return `
    <section class="usage-shell ${embedded ? 'usage-shell-embedded' : ''}">
      <div class="section-toolbar usage-toolbar">
        <div>
          <div class="skeleton-block" style="width:6rem;height:.75rem;margin-bottom:.6rem"></div>
          <div class="skeleton-block" style="width:22rem;height:2rem;margin-bottom:.55rem"></div>
          <div class="skeleton-block" style="width:30rem;max-width:100%;height:.9rem"></div>
        </div>
        <div class="period-group">
          <div class="skeleton-block" style="width:12rem;height:2.5rem"></div>
        </div>
      </div>
      <div class="usage-summary-grid">
        ${Array.from({ length: 6 }, () => '<div class="skeleton-card"></div>').join('')}
      </div>
      <div class="usage-insight-grid">
        <div class="skeleton-block" style="height:15rem"></div>
        <div class="skeleton-block" style="height:15rem"></div>
      </div>
      <div class="skeleton-block" style="height:18rem"></div>
    </section>
  `
}

function periodToSince(period) {
  if (period === 'all') return null
  const date = new Date()
  date.setDate(date.getDate() - Number(period))
  return date.toISOString()
}

function fmtNum(value) {
  if (value == null) return '0'
  return Number(value).toLocaleString()
}

function fmtTokens(value) {
  if (!value) return '0'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(value)
}

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function utilizationColor(value) {
  if (value >= 0.8) return 'progress-red'
  if (value >= 0.5) return 'progress-yellow'
  return 'progress-green'
}

function statCard(value, label, caption) {
  return `
    <div class="stat-card stat-card-usage">
      <div class="stat-value">${esc(value)}</div>
      <div class="stat-label">${esc(label)}</div>
      <div class="stat-caption">${esc(caption)}</div>
    </div>
  `
}

function maxDefined(...values) {
  const filtered = values.filter((value) => value !== null && value !== undefined)
  return filtered.length ? Math.max(...filtered) : null
}

function esc(str) {
  const div = document.createElement('div')
  div.textContent = str ?? ''
  return div.innerHTML
}
