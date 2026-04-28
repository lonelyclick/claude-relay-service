import * as api from '../api.js'
import { toast, refreshCurrentPage } from '../app.js'

export async function renderSessions() {
  const container = document.getElementById('page-sessions')
  container.innerHTML = '<p class="text-dim">Loading...</p>'

  try {
    const { sessionRoutes, recentHandoffs } = await api.listSessionRoutes()

    if (!sessionRoutes?.length) {
      container.innerHTML = `
        <h2 style="margin-bottom:1rem">Session Routes</h2>
        <div class="empty-state">No active session routes</div>`
      return
    }

    container.innerHTML = `
      <div class="card-header" style="margin-bottom:1rem">
        <h2 class="card-title">Session Routes (${sessionRoutes.length})</h2>
        <button class="btn btn-sm btn-danger" id="clear-sessions-btn">Clear All</button>
      </div>
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Session</th>
                <th>Account ID</th>
                <th>Generation</th>
                <th>Upstream Session</th>
                <th>Expires</th>
                <th>Pending Handoff</th>
              </tr>
            </thead>
            <tbody id="sessions-tbody"></tbody>
          </table>
        </div>
      </div>
      ${renderRecentHandoffs(recentHandoffs ?? [])}
    `

    document.getElementById('clear-sessions-btn').onclick = async () => {
      if (!confirm('Clear all session routes?')) return
      try {
        await api.clearSessionRoutes()
        toast('Session routes cleared')
        refreshCurrentPage()
      } catch (e) { toast(e.message, 'error') }
    }

    const tbody = document.getElementById('sessions-tbody')
    sessionRoutes.forEach((s) => {
      const tr = document.createElement('tr')
      const expiresAt = s.expiresAt ? new Date(s.expiresAt).toLocaleString() : '-'
      const isExpired = s.expiresAt && Date.now() > s.expiresAt

      tr.innerHTML = `
        <td class="mono">${esc(s.sessionKey?.slice(0, 24) ?? '-')}</td>
        <td class="mono">${esc(s.accountId?.slice(0, 24) ?? '-')}</td>
        <td>${s.generation}</td>
        <td class="mono">${esc(s.upstreamSessionId?.slice(0, 24) ?? '-')}</td>
        <td class="${isExpired ? 'text-red' : 'text-dim'}">${expiresAt}</td>
        <td>${s.pendingHandoffSummary ? '<span class="badge badge-yellow">pending</span>' : '<span class="text-muted">-</span>'}</td>
      `
      tbody.appendChild(tr)
    })
  } catch (err) {
    container.innerHTML = `<p class="text-red">Failed to load sessions: ${esc(err.message)}</p>`
  }
}

function renderRecentHandoffs(handoffs) {
  if (!handoffs.length) return ''
  return `
    <div class="card">
      <div class="card-header"><h3 class="card-title">Recent Handoffs</h3></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Session</th><th>From</th><th>To</th><th>Reason</th><th>Created</th></tr></thead>
          <tbody>
            ${handoffs.map((handoff) => `
              <tr>
                <td class="mono">${esc(handoff.sessionKey?.slice(0, 24) ?? '-')}</td>
                <td class="mono">${esc((handoff.fromAccountId || '-').slice(0, 24))}</td>
                <td class="mono">${esc(handoff.toAccountId?.slice(0, 24) ?? '-')}</td>
                <td>${esc(handoff.reason)}</td>
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
