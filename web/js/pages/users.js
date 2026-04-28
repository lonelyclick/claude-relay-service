import * as api from '../api.js'
import { toast } from '../app.js'

let disclosedApiKey = null
const PENDING_USER_ID_KEY = 'ccdash-selected-user-id'
const PENDING_USER_FOCUS_KEY = 'ccdash-users-focus-section'
const PENDING_CLIENT_DEVICE_ID_KEY = 'ccdash-selected-client-device-id'
let cachedRoutingGroups = []
let cachedRoutingGroupMap = {}

function buildDisclosedApiKeyState(input) {
  if (!input) return null
  const primaryApiKey = input.primaryApiKey ?? null
  const apiKeySource = input.apiKeySource ?? (primaryApiKey ? 'relay_api_keys' : 'relay_users_legacy')
  const apiKeyFieldMode = input.apiKeyFieldMode
    ?? (apiKeySource === 'relay_api_keys' ? 'current_primary_plaintext' : 'legacy_primary_plaintext')
  return {
    userId: input.userId,
    apiKey: typeof input.apiKey === 'string' ? input.apiKey : null,
    apiKeySource,
    primaryApiKey,
    activeApiKeyCount: Number.isFinite(input.activeApiKeyCount) ? input.activeApiKeyCount : (primaryApiKey ? 1 : 0),
    apiKeyFieldMode,
    legacyApiKey: typeof input.legacyApiKey === 'string' ? input.legacyApiKey : null,
    legacyApiKeyDeprecated: Boolean(input.legacyApiKeyDeprecated),
  }
}

export async function renderUsers(selectedUserId = null, routeParams = null) {
  const container = document.getElementById('page-users')
  container.innerHTML = '<p class="text-dim">Loading...</p>'
  const urlState = readUsersUrlState(routeParams)
  const preserveUrlState = Boolean(selectedUserId && urlState.userId === selectedUserId)
  const requestedUserId = selectedUserId || urlState.userId || consumePendingUserId()
  const requestedFocus = selectedUserId
    ? (preserveUrlState ? urlState.focusSection : 'overview')
    : urlState.focusSection || consumePendingUserFocus()
  const requestedClientDeviceId = selectedUserId
    ? (preserveUrlState ? urlState.deviceId : null)
    : urlState.deviceId || consumePendingClientDeviceId()
  const requestedSessionKey = preserveUrlState || !selectedUserId ? urlState.sessionKey : null
  const requestedRequestId = preserveUrlState || !selectedUserId ? urlState.requestId : null

  try {
    const [{ users }, { accounts }, { routingGroups }] = await Promise.all([
      api.listUsers(),
      api.listAccounts(),
      api.listRoutingGroups(),
    ])
    cachedRoutingGroups = routingGroups ?? []
    cachedRoutingGroupMap = Object.fromEntries(
      cachedRoutingGroups.map((group) => [group.id, group]),
    )

    container.innerHTML = `
      <div class="card-header" style="margin-bottom:1rem">
        <h2 class="card-title">Users (${users.length})</h2>
        <button class="btn btn-sm btn-primary" id="create-user-btn">+ New User</button>
      </div>
      <div id="create-user-form" hidden style="margin-bottom:1rem">
        <div class="card" style="padding:.75rem">
          <div style="display:flex;gap:.5rem;align-items:center">
            <input type="text" id="new-user-name" placeholder="User name" class="input" style="flex:1">
            <button class="btn btn-sm btn-primary" id="save-user-btn">Create</button>
            <button class="btn btn-sm" id="cancel-user-btn">Cancel</button>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>Name</th>
              <th>API Key</th>
              <th>Routing</th>
              <th>Target</th>
              <th style="text-align:right">Sessions</th>
              <th style="text-align:right">Requests</th>
              <th style="text-align:right">Tokens</th>
              <th>Status</th>
            </tr></thead>
            <tbody id="users-tbody">
              ${users.length ? users.map((u) => userRow(u, accounts)).join('') : '<tr><td colspan="8" class="text-muted">No users yet</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
      <div id="user-detail"></div>
    `

    // Create user
    document.getElementById('create-user-btn').onclick = () => {
      document.getElementById('create-user-form').hidden = false
      document.getElementById('new-user-name').focus()
    }
    document.getElementById('cancel-user-btn').onclick = () => {
      document.getElementById('create-user-form').hidden = true
    }
    document.getElementById('save-user-btn').onclick = async () => {
      const name = document.getElementById('new-user-name').value.trim()
      if (!name) return
      try {
        const created = await api.createUser(name)
        disclosedApiKey = buildDisclosedApiKeyState({
          ...created,
          userId: created.user.id,
          apiKeyFieldMode: created.apiKeySource === 'relay_api_keys'
            ? 'current_primary_plaintext'
            : 'legacy_primary_plaintext',
        })
        toast(`User created: ${created.user.name}`)
        renderUsers(created.user.id)
      } catch (e) { toast(e.message, 'error') }
    }

    // Row click -> detail
    container.querySelectorAll('.user-row').forEach((row) => {
      row.addEventListener('click', () => loadUserDetail(row.dataset.userId, accounts))
    })

    if (users.length) {
      const nextUserId = users.some((user) => user.id === requestedUserId)
        ? requestedUserId
        : users[0].id
      await loadUserDetail(nextUserId, accounts, {
        selectedClientDeviceId: requestedClientDeviceId,
        focusSection: requestedFocus,
        autoExpandSessionKey: requestedSessionKey,
        autoExpandRequestId: requestedRequestId,
      })
      focusUserSection(requestedFocus)
    }
  } catch (err) {
    container.innerHTML = `<p class="text-red">Failed to load: ${esc(err.message)}</p>`
  }
}

function userRow(u, accounts) {
  const acc = u.accountId ? accounts.find((a) => a.id === u.accountId) : null
  const accLabel = acc ? (acc.emailAddress || acc.id) : '-'
  const routingGroupId = resolveUserRoutingGroupId(u)
  const routingGroup = routingGroupId ? cachedRoutingGroupMap[routingGroupId] ?? null : null
  const routingTarget =
    u.routingMode === 'pinned_account'
      ? accLabel
      : u.routingMode === 'preferred_group'
        ? (routingGroup?.name || routingGroupId || '-')
        : '-'
  const totalTokens = (u.totalInputTokens || 0) + (u.totalOutputTokens || 0)
  return `<tr class="user-row" data-user-id="${esc(u.id)}" style="cursor:pointer">
    <td><strong>${esc(u.name)}</strong></td>
    <td><span class="mono" style="font-size:.8rem">${esc(u.apiKeyPreview || "-")}</span></td>
    <td>${routingModeBadge(u.routingMode)}</td>
    <td>${routingTarget !== '-' ? esc(routingTarget) : '<span class="text-muted">-</span>'}</td>
    <td style="text-align:right">${u.sessionCount || 0}</td>
    <td style="text-align:right">${fmtNum(u.totalRequests || 0)}</td>
    <td style="text-align:right">${fmtTokens(totalTokens)}</td>
    <td>${u.isActive ? '<span class="badge badge-green">Active</span>' : '<span class="badge badge-red">Disabled</span>'}</td>
  </tr>`
}

async function loadUserDetail(userId, accounts, options = {}) {
  const detailEl = document.getElementById('user-detail')
  if (!detailEl) return
  detailEl.innerHTML = '<p class="text-dim" style="padding:1rem">Loading...</p>'
  const selectedClientDeviceId = normalizeClientDeviceId(options.selectedClientDeviceId)
  const autoExpandSessionKey = typeof options.autoExpandSessionKey === 'string' && options.autoExpandSessionKey
    ? options.autoExpandSessionKey
    : null
  const autoExpandRequestId = typeof options.autoExpandRequestId === 'string' && options.autoExpandRequestId
    ? options.autoExpandRequestId
    : null

  document.querySelectorAll('.user-row').forEach((r) => {
    r.style.background = r.dataset.userId === userId ? 'rgba(59,130,246,.08)' : ''
  })

  try {
    const [{ user }, { sessions }, { requests: userRequests, total: userRequestTotal }] = await Promise.all([
      api.getUser(userId),
      api.getUserSessions(userId),
      api.getUserRequests(userId),
    ])
    const routingGroupId = resolveUserRoutingGroupId(user)
    const routingGroup = routingGroupId ? cachedRoutingGroupMap[routingGroupId] ?? null : null
    const revealedKeyState = disclosedApiKey?.userId === user.id ? disclosedApiKey : null
    const revealedKey = revealedKeyState?.apiKey ?? null
    const revealedPrimaryApiKey = revealedKeyState?.primaryApiKey ?? null
    const routingMode = user.routingMode || 'auto'
    const candidateAccounts = getCandidateAccounts(accounts, routingMode, routingGroupId)
    const deviceOptions = buildClientDeviceOptions(sessions, userRequests, selectedClientDeviceId)
    const visibleSessions = filterSessionsByDevice(sessions, selectedClientDeviceId)
    const visibleSessionCount = visibleSessions.length
    const visibleUserRequests = filterRequestsByDevice(userRequests, selectedClientDeviceId)
    const initialFocusSection = normalizeFocusSection(options.focusSection) || (selectedClientDeviceId ? 'sessions' : 'overview')

    detailEl.innerHTML = `
      <div class="card" style="margin-top:1rem">
        <div class="card-header">
          <h3 class="card-title">${esc(user.name)}</h3>
          <div style="display:flex;gap:.5rem">
            <button class="btn btn-sm" id="toggle-active-btn">${user.isActive ? 'Disable' : 'Enable'}</button>
            <button class="btn btn-sm btn-danger" id="delete-user-btn">Delete</button>
          </div>
        </div>

        ${renderUserFocusBar({
          userId: user.id,
          userName: user.name,
          focusSection: initialFocusSection,
          deviceId: selectedClientDeviceId,
          sessionKey: autoExpandSessionKey,
          requestId: autoExpandRequestId,
        })}

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:1rem">
          <div>
            <div class="text-dim" style="font-size:.8rem;margin-bottom:.3rem">Legacy Key Preview</div>
            <div class="mono" style="font-size:.8rem;word-break:break-all">${esc(user.apiKeyPreview || "-")}</div>
            <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.5rem">
              <button class="btn btn-sm" id="reveal-key-btn">${revealedKeyState ? "Refresh Key Info" : "Show Key Info"}</button>
              <button class="btn btn-sm" id="regen-key-btn">Regenerate Key</button>
            </div>
            ${revealedKeyState ? `
              <div style="margin-top:.75rem">
                <div class="text-dim" style="font-size:.75rem;margin-bottom:.25rem">Current Key Source</div>
                <div class="mono" style="font-size:.8rem;word-break:break-all">${esc(revealedKeyState.apiKeySource === 'relay_api_keys' ? 'relay_api_keys primary path' : 'relay_users.api_key legacy path')}</div>
                ${revealedPrimaryApiKey ? `
                  <div style="margin-top:.5rem">
                    <div class="text-dim" style="font-size:.75rem;margin-bottom:.25rem">Primary Relay Key Preview</div>
                    <div class="mono" style="font-size:.8rem;word-break:break-all">${esc(revealedPrimaryApiKey.keyPreview)}</div>
                    <div class="text-muted" style="font-size:.75rem;margin-top:.25rem">${revealedKeyState.apiKeyFieldMode === 'current_primary_plaintext'
                      ? 'Primary plaintext is only returned once at issue time.'
                      : 'relay_api_keys keeps metadata and preview here; plaintext is not readable later from this endpoint.'}</div>
                  </div>
                ` : ''}
                ${revealedKey ? `
                  <div style="margin-top:.5rem">
                    <div class="text-dim" style="font-size:.75rem;margin-bottom:.25rem">${esc(revealedKeyState.apiKeyFieldMode === 'compatibility_legacy_plaintext'
                      ? 'Legacy Compatibility Key'
                      : revealedKeyState.apiKeyFieldMode === 'legacy_primary_plaintext'
                        ? 'Legacy Primary Key'
                        : 'Current Primary Key')}</div>
                    <div class="mono" style="font-size:.8rem;word-break:break-all">${esc(revealedKey)} <button class="btn-copy" data-copy="${esc(revealedKey)}" style="cursor:pointer;background:none;border:none;font-size:.75rem">📋</button></div>
                    <div class="text-muted" style="font-size:.75rem;margin-top:.25rem">${esc(revealedKeyState.apiKeyFieldMode === 'compatibility_legacy_plaintext'
                      ? 'This plaintext is retained only as a legacy compatibility value; the current admin primary key is the relay_api_keys preview above.'
                      : revealedKeyState.apiKeyFieldMode === 'legacy_primary_plaintext'
                        ? 'Legacy relay_users.api_key is still the current readable primary key for this user.'
                        : 'Only shown after explicit create/regenerate.' )}</div>
                  </div>
                ` : ''}
              </div>
            ` : ""}
          </div>
          <div>
            <div class="text-dim" style="font-size:.8rem;margin-bottom:.3rem">Routing Mode</div>
            <select id="user-routing-mode-select" class="input" style="font-size:.85rem;margin-bottom:.5rem">
              <option value="auto" ${routingMode === 'auto' ? 'selected' : ''}>Auto</option>
              <option value="pinned_account" ${routingMode === 'pinned_account' ? 'selected' : ''}>Pinned Account</option>
              <option value="preferred_group" ${routingMode === 'preferred_group' ? 'selected' : ''}>Preferred Group</option>
            </select>
            <div id="routing-mode-help" class="text-dim" style="font-size:.75rem;margin-bottom:.5rem">${esc(routingModeHelp(routingMode))}</div>
            <div id="user-account-wrap" style="margin-bottom:.5rem">
              <div class="text-dim" style="font-size:.8rem;margin-bottom:.3rem">Pinned Account</div>
              <select id="user-account-select" class="input" style="font-size:.85rem">
                <option value="">Select an account</option>
                ${renderPinnedAccountOptions(accounts, user.accountId)}
              </select>
            </div>
            <div id="user-group-wrap" style="margin-bottom:.5rem">
              <div class="text-dim" style="font-size:.8rem;margin-bottom:.3rem">Routing Group</div>
              <select id="user-preferred-group-input" class="input" style="font-size:.85rem">
                ${buildRoutingGroupOptionsHtml(routingGroupId, true)}
              </select>
              <div id="user-routing-group-hint" class="text-dim" style="font-size:.75rem;margin-top:.35rem">${renderRoutingGroupSelectionHint(routingGroupId)}</div>
            </div>
            <div style="display:flex;gap:.5rem;flex-wrap:wrap">
              <button class="btn btn-sm btn-primary" id="save-routing-btn">Apply Routing</button>
              <a class="btn btn-sm" href="#scheduler">Routing</a>
            </div>
            <div class="text-dim" style="font-size:.75rem;margin-top:.5rem">
              Pinned Account 会强制固定账号；Preferred Group 只限制候选池；Auto 交给调度器综合评分。
            </div>
          </div>
          <div>
            <div class="text-dim" style="font-size:.8rem;margin-bottom:.3rem">Current Routing</div>
            <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:.5rem">
              ${routingModeBadge(routingMode)}
              ${user.accountId ? `<span class="badge badge-blue">${esc((accounts.find((a) => a.id === user.accountId)?.emailAddress) || user.accountId)}</span>` : ''}
              ${routingGroupId ? `<span class="badge ${routingGroup?.isActive === false ? 'badge-red' : 'badge-gray'}">${esc(routingGroup?.name || routingGroupId)}</span>` : ''}
              ${routingGroupId && routingGroup && routingGroup.name !== routingGroupId ? `<span class="text-dim" style="font-size:.75rem">${esc(routingGroupId)}</span>` : ''}
            </div>
            <div class="text-dim" style="font-size:.75rem">
              当前路由不会影响已创建的 session route；新请求会按新策略生效。
            </div>
          </div>
          <div>
            <div class="text-dim" style="font-size:.8rem;margin-bottom:.3rem">Candidate Pool</div>
            <div id="user-available-accounts-list" style="font-size:.8rem;display:grid;gap:.35rem">
              ${renderCandidateAccountsList(candidateAccounts, routingMode, routingGroupId)}
            </div>
          </div>
        </div>

        <div id="user-sessions-section">
          <div class="session-toolbar">
            <div class="session-toolbar-meta">
              <div class="text-dim" style="font-size:.8rem">Sessions (${sessions.length})</div>
              ${selectedClientDeviceId ? `<span class="badge badge-blue mono">${esc(selectedClientDeviceId)}</span>` : ''}
              ${selectedClientDeviceId ? `<span class="badge badge-gray">${visibleSessionCount} visible</span>` : ''}
            </div>
            ${sessions.length && (deviceOptions.length || selectedClientDeviceId) ? `
              <div class="session-toolbar-actions">
                <select id="session-device-filter" class="input session-filter-select" aria-label="Filter sessions by client device">
                  <option value="">All Devices</option>
                  ${deviceOptions.map((deviceId) => `
                    <option value="${esc(deviceId)}" ${deviceId === selectedClientDeviceId ? 'selected' : ''}>${esc(deviceId)}</option>
                  `).join('')}
                </select>
                ${selectedClientDeviceId ? '<button class="btn btn-sm" id="clear-session-device-filter-btn">Show All</button>' : ''}
              </div>
            ` : ''}
          </div>
          ${sessions.length
            ? `<div id="sessions-container">${renderSessionBlocks(sessions, selectedClientDeviceId)}</div>`
            : '<div class="text-muted">No sessions yet</div>'}
        </div>

        <div id="user-requests-section" style="margin-top:1rem">
          <div class="session-toolbar">
            <div class="session-toolbar-meta">
              <div class="text-dim" style="font-size:.8rem">Recent Requests (${fmtNum(userRequestTotal)})</div>
              ${selectedClientDeviceId ? `<span class="badge badge-blue mono">${esc(selectedClientDeviceId)}</span>` : ''}
              ${selectedClientDeviceId ? `<span class="badge badge-gray">${fmtNum(visibleUserRequests.length)} visible</span>` : ''}
            </div>
            ${userRequests.length && (deviceOptions.length || selectedClientDeviceId) ? `
              <div class="session-toolbar-actions">
                <select id="user-request-device-filter" class="input session-filter-select" aria-label="Filter user requests by client device">
                  <option value="">All Devices</option>
                  ${deviceOptions.map((deviceId) => `
                    <option value="${esc(deviceId)}" ${deviceId === selectedClientDeviceId ? 'selected' : ''}>${esc(deviceId)}</option>
                  `).join('')}
                </select>
                ${selectedClientDeviceId ? '<button class="btn btn-sm" id="clear-user-request-device-filter-btn">Show All</button>' : ''}
              </div>
            ` : ''}
          </div>
          <div id="user-requests-container">
            ${renderUserRequestTable(userRequests, userRequestTotal, selectedClientDeviceId)}
          </div>
        </div>
      </div>
    `

    // Actions
    document.getElementById('toggle-active-btn').onclick = async () => {
      await api.updateUser(userId, { isActive: !user.isActive })
      toast(user.isActive ? 'User disabled' : 'User enabled')
      renderUsers(userId)
    }
    document.getElementById('delete-user-btn').onclick = async () => {
      if (!confirm(`Delete user "${user.name}"?`)) return
      await api.deleteUser(userId)
      if (disclosedApiKey?.userId === userId) disclosedApiKey = null
      toast('User deleted')
      renderUsers()
    }
    document.getElementById('reveal-key-btn').onclick = async () => {
      disclosedApiKey = buildDisclosedApiKeyState(await api.getUserApiKey(userId))
      toast('API key info loaded')
      loadUserDetail(userId, accounts, { selectedClientDeviceId })
    }
    document.getElementById('regen-key-btn').onclick = async () => {
      if (!confirm('Regenerate primary relay API key? The current primary key will stop working immediately; other active keys remain unchanged.')) return
      const regenerated = await api.regenerateUserKey(userId)
      disclosedApiKey = buildDisclosedApiKeyState({
        ...regenerated,
        userId,
        apiKeyFieldMode: regenerated.apiKeySource === 'relay_api_keys'
          ? 'current_primary_plaintext'
          : 'legacy_primary_plaintext',
      })
      toast('Primary relay API key regenerated')
      renderUsers(userId)
    }
    const routingModeSelect = document.getElementById('user-routing-mode-select')
    const accountWrap = document.getElementById('user-account-wrap')
    const accountSelect = document.getElementById('user-account-select')
    const groupWrap = document.getElementById('user-group-wrap')
    const groupInput = document.getElementById('user-preferred-group-input')
    const routingModeHelpEl = document.getElementById('routing-mode-help')
    const routingGroupHintEl = document.getElementById('user-routing-group-hint')
    const candidateAccountsEl = document.getElementById('user-available-accounts-list')
    const syncRoutingUi = () => {
      const mode = routingModeSelect.value
      const selectedRoutingGroupId = groupInput.value.trim()
      accountWrap.style.display = mode === 'pinned_account' ? '' : 'none'
      accountSelect.disabled = mode !== 'pinned_account'
      groupWrap.style.display = mode === 'preferred_group' ? '' : 'none'
      groupInput.disabled = mode !== 'preferred_group'
      routingModeHelpEl.textContent = routingModeHelp(mode)
      if (routingGroupHintEl) {
        routingGroupHintEl.innerHTML = renderRoutingGroupSelectionHint(selectedRoutingGroupId)
      }
      if (candidateAccountsEl) {
        candidateAccountsEl.innerHTML = renderCandidateAccountsList(
          getCandidateAccounts(accounts, mode, selectedRoutingGroupId),
          mode,
          selectedRoutingGroupId,
        )
      }
    }
    routingModeSelect.onchange = syncRoutingUi
    groupInput.onchange = syncRoutingUi
    syncRoutingUi()
    document.getElementById('save-routing-btn').onclick = async () => {
      const mode = routingModeSelect.value
      const updates = { routingMode: mode }
      if (mode === 'pinned_account') {
        if (!accountSelect.value) {
          toast('Pinned Account 模式必须选择账号', 'error')
          return
        }
        updates.accountId = accountSelect.value
        updates.routingGroupId = null
      } else if (mode === 'preferred_group') {
        const preferredGroup = groupInput.value.trim()
        if (!preferredGroup) {
          toast('Preferred Group 模式必须选择 routing group', 'error')
          return
        }
        updates.accountId = null
        updates.routingGroupId = preferredGroup
      } else {
        updates.accountId = null
        updates.routingGroupId = null
      }
      await api.updateUser(userId, updates)
      toast('Routing updated')
      renderUsers(userId)
    }

    const sessionDeviceFilter = document.getElementById('session-device-filter')
    if (sessionDeviceFilter) {
      sessionDeviceFilter.onchange = async () => {
        await loadUserDetail(userId, accounts, {
          selectedClientDeviceId: normalizeClientDeviceId(sessionDeviceFilter.value),
          focusSection: 'sessions',
        })
      }
    }
    const clearSessionFilterBtn = document.getElementById('clear-session-device-filter-btn')
    if (clearSessionFilterBtn) {
      clearSessionFilterBtn.onclick = async () => {
        await loadUserDetail(userId, accounts, { focusSection: 'sessions' })
      }
    }
    const userRequestDeviceFilter = document.getElementById('user-request-device-filter')
    if (userRequestDeviceFilter) {
      userRequestDeviceFilter.onchange = async () => {
        await loadUserDetail(userId, accounts, {
          selectedClientDeviceId: normalizeClientDeviceId(userRequestDeviceFilter.value),
          focusSection: 'requests',
        })
      }
    }
    const clearUserRequestFilterBtn = document.getElementById('clear-user-request-device-filter-btn')
    if (clearUserRequestFilterBtn) {
      clearUserRequestFilterBtn.onclick = async () => {
        await loadUserDetail(userId, accounts, { focusSection: 'requests' })
      }
    }
    bindUserFocusBarActions(detailEl, userId, accounts)

    // Copy buttons
    detailEl.querySelectorAll('.btn-copy').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        navigator.clipboard.writeText(btn.dataset.copy)
        toast('Copied to clipboard')
      })
    })

    // Session click -> expand with requests
    const sessionCache = {}
    const reqDetailCache = {}
    bindExpandableRequestRows(
      document.getElementById('user-requests-container'),
      userId,
      accounts,
      reqDetailCache,
      9,
      'requests',
      initialFocusSection === 'requests' ? autoExpandRequestId : null,
    )
    detailEl.querySelectorAll('.session-header').forEach((header) => {
      header.addEventListener('click', async () => {
        const sk = header.dataset.sessionKey
        const body = header.nextElementSibling
        if (!body) return

        // Toggle collapse
        if (body.style.display !== 'none') {
          body.style.display = 'none'
          header.querySelector('.session-arrow').textContent = '▶'
          updateUserFocusBar(detailEl, userId, accounts, {
            focusSection: 'sessions',
            sessionKey: null,
            requestId: null,
          })
          return
        }

        // Collapse all other sessions
        detailEl.querySelectorAll('.session-body').forEach((b) => { b.style.display = 'none' })
        detailEl.querySelectorAll('.session-arrow').forEach((a) => { a.textContent = '▶' })

        body.style.display = 'block'
        header.querySelector('.session-arrow').textContent = '▼'
        updateUserFocusBar(detailEl, userId, accounts, {
          focusSection: 'sessions',
          sessionKey: sk,
          requestId: null,
        })

        // Load requests if not cached
        if (!sessionCache[sk]) {
          body.innerHTML = '<div style="padding:.5rem" class="text-dim">Loading requests...</div>'
          try {
            const data = await api.getSessionRequests(userId, sk)
            sessionCache[sk] = data
          } catch (e) {
            body.innerHTML = `<div style="padding:.5rem" class="text-red">Failed: ${esc(e.message)}</div>`
            return
          }
        }

        const data = sessionCache[sk]
        renderSessionRequests(
          body,
          data,
          userId,
          accounts,
          reqDetailCache,
          autoExpandSessionKey === sk ? autoExpandRequestId : null,
        )
      })
    })

    syncUsersUrlState({
      userId: user.id,
      focusSection: initialFocusSection,
      deviceId: selectedClientDeviceId,
      sessionKey: autoExpandSessionKey,
      requestId: autoExpandRequestId,
    })

    if (autoExpandSessionKey) {
      const targetHeader = [...detailEl.querySelectorAll('.session-header')]
        .find((header) => header.dataset.sessionKey === autoExpandSessionKey)
      if (targetHeader) {
        targetHeader.click()
      }
    }

    if (options.focusSection) {
      focusUserSection(options.focusSection)
    }
  } catch (err) {
    detailEl.innerHTML = `<p class="text-red" style="padding:1rem">Failed: ${esc(err.message)}</p>`
  }
}

function consumePendingUserId() {
  try {
    const value = sessionStorage.getItem(PENDING_USER_ID_KEY)
    if (value) sessionStorage.removeItem(PENDING_USER_ID_KEY)
    return value
  } catch {
    return null
  }
}

function consumePendingUserFocus() {
  try {
    const value = sessionStorage.getItem(PENDING_USER_FOCUS_KEY)
    if (value) sessionStorage.removeItem(PENDING_USER_FOCUS_KEY)
    return value || 'overview'
  } catch {
    return 'overview'
  }
}

function consumePendingClientDeviceId() {
  try {
    const value = sessionStorage.getItem(PENDING_CLIENT_DEVICE_ID_KEY)
    if (value) sessionStorage.removeItem(PENDING_CLIENT_DEVICE_ID_KEY)
    return normalizeClientDeviceId(value)
  } catch {
    return null
  }
}

function normalizeClientDeviceId(value) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return normalized || null
}

function normalizeFocusSection(value) {
  return value === 'overview' || value === 'sessions' || value === 'requests' ? value : null
}

function readUsersUrlState(routeParams = null) {
  const params = routeParams instanceof URLSearchParams
    ? routeParams
    : new URLSearchParams((location.hash.split('?')[1] || ''))
  const userId = normalizeUrlToken(params.get('user'))
  if (!userId) {
    return {
      userId: null,
      focusSection: null,
      deviceId: null,
      sessionKey: null,
      requestId: null,
    }
  }
  return {
    userId,
    focusSection: normalizeFocusSection(params.get('focus')),
    deviceId: normalizeClientDeviceId(params.get('device')),
    sessionKey: normalizeUrlToken(params.get('session')),
    requestId: normalizeUrlToken(params.get('request')),
  }
}

function syncUsersUrlState(state) {
  if (!location.hash.startsWith('#users')) {
    return
  }
  const params = new URLSearchParams()
  if (state.userId) params.set('user', state.userId)
  if (state.focusSection && state.focusSection !== 'overview') params.set('focus', state.focusSection)
  if (state.deviceId) params.set('device', state.deviceId)
  if (state.sessionKey) params.set('session', state.sessionKey)
  if (state.requestId) params.set('request', state.requestId)
  const nextHash = params.toString() ? `#users?${params.toString()}` : '#users'
  if (location.hash !== nextHash) {
    history.replaceState(null, '', nextHash)
  }
}

function normalizeUrlToken(value) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return normalized || null
}

function focusUserSection(section) {
  const target = section === 'sessions'
    ? document.getElementById('user-sessions-section')
    : section === 'requests'
      ? document.getElementById('user-requests-section')
      : document.getElementById('user-detail')
  target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function renderUserFocusBar(state) {
  return `
    <div
      id="user-focus-bar"
      class="focus-bar"
      data-user-id="${esc(state.userId || '')}"
      data-user-name="${esc(state.userName || '')}"
      data-focus-section="${esc(state.focusSection || 'overview')}"
      data-device-focus="${esc(state.deviceId || '')}"
      data-session-focus="${esc(state.sessionKey || '')}"
      data-request-focus="${esc(state.requestId || '')}"
    >
      ${renderUserFocusBarContent(state)}
    </div>
  `
}

function renderUserFocusBarContent(state) {
  const chips = [
    renderFocusChip('User', state.userName || state.userId || '-'),
    renderFocusChip('Scope', focusScopeLabel(state.focusSection)),
  ]
  if (state.deviceId) {
    chips.push(renderFocusChip('Device', state.deviceId, 'device'))
  }
  if (state.sessionKey) {
    chips.push(renderFocusChip('Session', shortenRef(state.sessionKey), 'session'))
  }
  if (state.requestId) {
    chips.push(renderFocusChip('Request', shortenRef(state.requestId), 'request'))
  }

  return `
    <div class="focus-bar-main">
      <span class="focus-bar-title">Focus</span>
      <div class="focus-bar-chips">${chips.join('')}</div>
    </div>
    ${(state.deviceId || state.sessionKey || state.requestId) ? '<button type="button" class="btn btn-sm" data-focus-clear="all">Reset View</button>' : ''}
  `
}

function renderFocusChip(label, value, clearKey = null) {
  return `
    <span class="focus-chip">
      <span class="focus-chip-label">${esc(label)}</span>
      <span class="focus-chip-value mono">${esc(value)}</span>
      ${clearKey ? `<button type="button" class="focus-chip-clear" data-focus-clear="${esc(clearKey)}" aria-label="Clear ${esc(label)} focus">×</button>` : ''}
    </span>
  `
}

function focusScopeLabel(scope) {
  if (scope === 'sessions') return 'sessions'
  if (scope === 'requests') return 'requests'
  return 'overview'
}

function shortenRef(value) {
  const text = typeof value === 'string' ? value : ''
  if (text.length <= 20) return text || '-'
  return `${text.slice(0, 20)}...`
}

function readUserFocusBarState(detailEl) {
  const focusBar = detailEl.querySelector('#user-focus-bar')
  if (!focusBar) return null
  return {
    userId: focusBar.dataset.userId || '',
    userName: focusBar.dataset.userName || '',
    focusSection: normalizeFocusSection(focusBar.dataset.focusSection) || 'overview',
    deviceId: normalizeClientDeviceId(focusBar.dataset.deviceFocus) || null,
    sessionKey: focusBar.dataset.sessionFocus || null,
    requestId: focusBar.dataset.requestFocus || null,
  }
}

function updateUserFocusBar(detailEl, userId, accounts, patch) {
  const focusBar = detailEl.querySelector('#user-focus-bar')
  if (!focusBar) return
  const current = readUserFocusBarState(detailEl)
  if (!current) return
  const nextState = {
    userId: current.userId,
    userName: current.userName,
    focusSection: normalizeFocusSection(patch.focusSection) || current.focusSection,
    deviceId: patch.deviceId === undefined ? current.deviceId : normalizeClientDeviceId(patch.deviceId),
    sessionKey: patch.sessionKey === undefined ? current.sessionKey : (patch.sessionKey || null),
    requestId: patch.requestId === undefined ? current.requestId : (patch.requestId || null),
  }
  focusBar.dataset.focusSection = nextState.focusSection || 'overview'
  focusBar.dataset.deviceFocus = nextState.deviceId || ''
  focusBar.dataset.sessionFocus = nextState.sessionKey || ''
  focusBar.dataset.requestFocus = nextState.requestId || ''
  focusBar.innerHTML = renderUserFocusBarContent(nextState)
  syncUsersUrlState(nextState)
  bindUserFocusBarActions(detailEl, userId, accounts)
}

function bindUserFocusBarActions(detailEl, userId, accounts) {
  const focusBar = detailEl.querySelector('#user-focus-bar')
  if (!focusBar) return
  focusBar.querySelectorAll('[data-focus-clear]').forEach((button) => {
    button.onclick = async (event) => {
      event.stopPropagation()
      const state = readUserFocusBarState(detailEl)
      if (!state) return
      const clearType = button.dataset.focusClear
      if (clearType === 'device') {
        await loadUserDetail(userId, accounts, { focusSection: state.focusSection })
        return
      }
      if (clearType === 'session') {
        await loadUserDetail(userId, accounts, {
          selectedClientDeviceId: state.deviceId,
          focusSection: 'sessions',
        })
        return
      }
      if (clearType === 'request') {
        await loadUserDetail(userId, accounts, {
          selectedClientDeviceId: state.deviceId,
          autoExpandSessionKey: state.sessionKey,
          focusSection: state.focusSection || 'requests',
        })
        return
      }
      await loadUserDetail(userId, accounts)
    }
  })
}

function buildClientDeviceOptions(sessions, requests, selectedClientDeviceId) {
  const options = [...new Set(
    [...sessions, ...requests]
      .map((entry) => normalizeClientDeviceId(entry.clientDeviceId))
      .filter(Boolean),
  )].sort((left, right) => left.localeCompare(right))

  if (selectedClientDeviceId && !options.includes(selectedClientDeviceId)) {
    options.unshift(selectedClientDeviceId)
  }
  return options
}

function filterSessionsByDevice(sessions, selectedClientDeviceId) {
  if (!selectedClientDeviceId) {
    return sessions
  }
  return sessions.filter((session) => normalizeClientDeviceId(session.clientDeviceId) === selectedClientDeviceId)
}

function filterRequestsByDevice(requests, selectedClientDeviceId) {
  if (!selectedClientDeviceId) {
    return requests
  }
  return requests.filter((request) => normalizeClientDeviceId(request.clientDeviceId) === selectedClientDeviceId)
}

function renderSessionBlocks(sessions, selectedClientDeviceId) {
  const visibleSessions = filterSessionsByDevice(sessions, selectedClientDeviceId)
  if (!visibleSessions.length) {
    return `<div class="text-muted">No sessions matched device <span class="mono">${esc(selectedClientDeviceId || '-')}</span>.</div>`
  }

  return visibleSessions.map((session) => sessionBlock(session, {
    highlighted: selectedClientDeviceId != null && normalizeClientDeviceId(session.clientDeviceId) === selectedClientDeviceId,
  })).join('')
}

function sessionBlock(s, options = {}) {
  const totalTokens = s.totalInputTokens + s.totalOutputTokens
  const isHighlighted = Boolean(options.highlighted)
  const baseBackground = isHighlighted ? 'rgba(59,130,246,.12)' : 'rgba(255,255,255,.03)'
  const hoverBackground = isHighlighted ? 'rgba(59,130,246,.18)' : 'rgba(59,130,246,.08)'
  const borderColor = isHighlighted ? 'rgba(96,165,250,.45)' : 'rgba(255,255,255,.06)'
  return `
    <div class="session-block" style="margin-bottom:2px">
      <div class="session-header" data-session-key="${esc(s.sessionKey)}"
           style="display:flex;align-items:center;gap:.75rem;padding:.6rem .75rem;background:${baseBackground};border:1px solid ${borderColor};border-radius:4px;cursor:pointer;font-size:.85rem;transition:background .15s"
           onmouseover="this.style.background='${hoverBackground}'" onmouseout="this.style.background='${baseBackground}'">
        <span class="session-arrow" style="font-size:.7rem;color:#64748b;width:1em">▶</span>
        <span class="mono" style="font-size:.8rem;color:#93c5fd;min-width:140px">${esc(s.sessionKey?.slice(0, 20) ?? '-')}${s.sessionKey?.length > 20 ? '...' : ''}</span>
        ${s.clientDeviceId ? `<span class="badge ${isHighlighted ? 'badge-blue' : 'badge-gray'} mono">${esc(s.clientDeviceId)}</span>` : ''}
        <span style="color:#64748b;font-size:.8rem">${fmtNum(s.requestCount)} req</span>
        <span style="color:#64748b;font-size:.8rem">${fmtTokens(totalTokens)} tok</span>
        <span style="color:#64748b;font-size:.8rem;margin-left:auto">${esc((s.accountId || '').slice(0, 24))}</span>
        <span style="color:#64748b;font-size:.8rem">${timeAgo(s.lastActiveAt)}</span>
      </div>
      <div class="session-body" style="display:none"></div>
    </div>`
}

function renderUserRequestTable(requests, total, selectedClientDeviceId) {
  const visibleRequests = filterRequestsByDevice(requests, selectedClientDeviceId)
  if (!requests.length) {
    return '<div class="text-muted">No requests yet</div>'
  }
  if (!visibleRequests.length) {
    return `<div class="text-muted">No recent requests matched device <span class="mono">${esc(selectedClientDeviceId || '-')}</span>.</div>`
  }

  return `
    <div style="border:1px solid rgba(255,255,255,.06);border-radius:4px;overflow:hidden">
      <div class="table-wrap"><table style="font-size:.82rem;margin:0" class="session-req-table">
        <thead><tr>
          <th style="padding:.4rem .5rem">Time</th>
          <th style="padding:.4rem .5rem">Session</th>
          <th style="padding:.4rem .5rem">Model</th>
          <th style="padding:.4rem .5rem">Device</th>
          <th style="padding:.4rem .5rem;text-align:right">In</th>
          <th style="padding:.4rem .5rem;text-align:right">Out</th>
          <th style="padding:.4rem .5rem">Status</th>
          <th style="padding:.4rem .5rem;text-align:right">Duration</th>
          <th style="padding:.4rem .5rem">Target</th>
        </tr></thead>
        <tbody>
          ${visibleRequests.map((r) => `<tr class="req-row" data-request-id="${esc(r.requestId)}" data-session-key="${esc(r.sessionKey || '')}" data-client-device-id="${esc(r.clientDeviceId || '')}" style="cursor:pointer">
            <td style="padding:.4rem .5rem" class="text-dim">${timeAgo(r.createdAt)}</td>
            <td style="padding:.4rem .5rem">${r.sessionKey ? `<button type="button" class="session-focus-btn mono" data-session-focus="${esc(r.sessionKey)}" data-session-device-id="${esc(r.clientDeviceId || '')}">${esc(r.sessionKey.slice(0, 20))}${r.sessionKey.length > 20 ? '...' : ''}</button>` : '<span class="text-muted">-</span>'}</td>
            <td style="padding:.4rem .5rem" class="mono" style="font-size:.78rem">${esc(r.model || '-')}</td>
            <td style="padding:.4rem .5rem">${r.clientDeviceId ? `<button type="button" class="device-focus-btn mono" data-device-focus="${esc(r.clientDeviceId)}">${esc(r.clientDeviceId)}</button>` : '<span class="text-muted">-</span>'}</td>
            <td style="padding:.4rem .5rem;text-align:right">${fmtTokens(r.inputTokens)}</td>
            <td style="padding:.4rem .5rem;text-align:right">${fmtTokens(r.outputTokens)}</td>
            <td style="padding:.4rem .5rem">${r.statusCode === 200 ? '<span class="badge badge-green">200</span>' : `<span class="badge badge-yellow">${r.statusCode}</span>`}</td>
            <td style="padding:.4rem .5rem;text-align:right" class="text-dim">${r.durationMs ? (r.durationMs / 1000).toFixed(1) + 's' : '-'}</td>
            <td style="padding:.4rem .5rem" class="mono text-dim" style="font-size:.78rem">${esc(r.target || '-')}</td>
          </tr>`).join('')}
        </tbody>
      </table></div>
      ${total > requests.length || visibleRequests.length !== requests.length
        ? `<div style="padding:.4rem .75rem;font-size:.8rem;color:#64748b">Showing ${fmtNum(visibleRequests.length)} of latest ${fmtNum(requests.length)} requests${total > requests.length ? ` (${fmtNum(total)} total)` : ''}</div>`
        : ''}
    </div>`
}

function renderSessionRequests(container, data, userId, accounts, reqDetailCache, autoExpandRequestId = null) {
  if (!data.requests.length) {
    container.innerHTML = '<div style="padding:.5rem" class="text-muted">No requests</div>'
    return
  }

  container.innerHTML = `
    <div style="border:1px solid rgba(255,255,255,.06);border-top:none;border-radius:0 0 4px 4px;overflow:hidden">
      <div class="table-wrap"><table style="font-size:.82rem;margin:0" class="session-req-table">
        <thead><tr>
          <th style="padding:.4rem .5rem">Time</th>
          <th style="padding:.4rem .5rem">Model</th>
          <th style="padding:.4rem .5rem">Device</th>
          <th style="padding:.4rem .5rem;text-align:right">In</th>
          <th style="padding:.4rem .5rem;text-align:right">Out</th>
          <th style="padding:.4rem .5rem">Status</th>
          <th style="padding:.4rem .5rem;text-align:right">Duration</th>
          <th style="padding:.4rem .5rem">Target</th>
        </tr></thead>
        <tbody>
          ${data.requests.map((r) => `<tr class="req-row" data-request-id="${esc(r.requestId)}" data-session-key="${esc(r.sessionKey || '')}" data-client-device-id="${esc(r.clientDeviceId || '')}" style="cursor:pointer">
            <td style="padding:.4rem .5rem" class="text-dim">${timeAgo(r.createdAt)}</td>
            <td style="padding:.4rem .5rem" class="mono" style="font-size:.78rem">${esc(r.model || '-')}</td>
            <td style="padding:.4rem .5rem">${r.clientDeviceId ? `<button type="button" class="device-focus-btn mono" data-device-focus="${esc(r.clientDeviceId)}">${esc(r.clientDeviceId)}</button>` : '<span class="text-muted">-</span>'}</td>
            <td style="padding:.4rem .5rem;text-align:right">${fmtTokens(r.inputTokens)}</td>
            <td style="padding:.4rem .5rem;text-align:right">${fmtTokens(r.outputTokens)}</td>
            <td style="padding:.4rem .5rem">${r.statusCode === 200 ? '<span class="badge badge-green">200</span>' : `<span class="badge badge-yellow">${r.statusCode}</span>`}</td>
            <td style="padding:.4rem .5rem;text-align:right" class="text-dim">${r.durationMs ? (r.durationMs / 1000).toFixed(1) + 's' : '-'}</td>
            <td style="padding:.4rem .5rem" class="mono text-dim" style="font-size:.78rem">${esc(r.target || '-')}</td>
          </tr>`).join('')}
        </tbody>
      </table></div>
      ${data.total > data.requests.length ? `<div style="padding:.4rem .75rem;font-size:.8rem;color:#64748b">Showing ${data.requests.length} of ${data.total} requests</div>` : ''}
    </div>`

  bindExpandableRequestRows(container, userId, accounts, reqDetailCache, 8, 'sessions', autoExpandRequestId)
}

function renderRequestDetail(d) {
  const headerDiff = diffHeaders(d.requestHeaders, d.upstreamRequestHeaders)
  return `<div style="background:rgba(0,0,0,.15);padding:.75rem;font-size:.8rem;border-top:1px solid rgba(255,255,255,.05)">
    <div style="display:flex;gap:.45rem;flex-wrap:wrap;margin-bottom:.75rem">
      ${detailSessionBadge(d.sessionKey, d.clientDeviceId)}
      ${detailDeviceBadge(d.clientDeviceId)}
      ${detailMetaBadge('Account', d.accountId || '-')}
      ${detailMetaBadge('Target', d.target || '-')}
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem">
      <div>
        <div style="font-weight:600;margin-bottom:.3rem;color:#93c5fd">Request Headers (incoming)</div>
        <pre style="margin:0;white-space:pre-wrap;word-break:break-all;max-height:200px;overflow:auto;background:rgba(0,0,0,.2);padding:.5rem;border-radius:4px">${d.requestHeaders ? esc(JSON.stringify(d.requestHeaders, null, 2)) : '<span class="text-muted">N/A</span>'}</pre>
      </div>
      <div>
        <div style="font-weight:600;margin-bottom:.3rem;color:#93c5fd">Request Headers (upstream)</div>
        <pre style="margin:0;white-space:pre-wrap;word-break:break-all;max-height:200px;overflow:auto;background:rgba(0,0,0,.2);padding:.5rem;border-radius:4px">${d.upstreamRequestHeaders ? esc(JSON.stringify(d.upstreamRequestHeaders, null, 2)) : '<span class="text-muted">N/A</span>'}</pre>
      </div>
    </div>
    ${headerDiff ? `<div style="margin-top:.5rem">
      <div style="font-weight:600;margin-bottom:.3rem;color:#f59e0b">Relay Modifications</div>
      <pre style="margin:0;white-space:pre-wrap;word-break:break-all;max-height:150px;overflow:auto;background:rgba(0,0,0,.2);padding:.5rem;border-radius:4px">${headerDiff}</pre>
    </div>` : ''}
    <div style="margin-top:.75rem">
      <div style="font-weight:600;margin-bottom:.3rem;color:#93c5fd">Response Headers</div>
      <pre style="margin:0;white-space:pre-wrap;word-break:break-all;max-height:200px;overflow:auto;background:rgba(0,0,0,.2);padding:.5rem;border-radius:4px">${d.responseHeaders ? esc(JSON.stringify(d.responseHeaders, null, 2)) : '<span class="text-muted">N/A</span>'}</pre>
    </div>
    <div style="margin-top:.75rem">
      <div style="font-weight:600;margin-bottom:.3rem;color:#93c5fd">Request Body (preview, max 2KB)</div>
      <pre style="margin:0;white-space:pre-wrap;word-break:break-all;max-height:300px;overflow:auto;background:rgba(0,0,0,.2);padding:.5rem;border-radius:4px">${d.requestBodyPreview ? esc(fmtJson(d.requestBodyPreview)) : '<span class="text-muted">N/A</span>'}</pre>
    </div>
    <div style="margin-top:.75rem">
      <div style="font-weight:600;margin-bottom:.3rem;color:#93c5fd">Response Body (preview, max 2KB)</div>
      <pre style="margin:0;white-space:pre-wrap;word-break:break-all;max-height:300px;overflow:auto;background:rgba(0,0,0,.2);padding:.5rem;border-radius:4px">${d.responseBodyPreview ? esc(fmtJson(d.responseBodyPreview)) : '<span class="text-muted">N/A</span>'}</pre>
    </div>
  </div>`
}

function detailMetaBadge(label, value) {
  return `<span class="badge badge-gray"><strong>${esc(label)}:</strong> <span class="mono">${esc(value)}</span></span>`
}

function detailSessionBadge(sessionKey, clientDeviceId) {
  if (!sessionKey) {
    return detailMetaBadge('Session', '-')
  }
  return `<button type="button" class="session-focus-btn" data-session-focus="${esc(sessionKey)}" data-session-device-id="${esc(clientDeviceId || '')}">Session: <span class="mono">${esc(sessionKey)}</span></button>`
}

function detailDeviceBadge(clientDeviceId) {
  const normalized = normalizeClientDeviceId(clientDeviceId)
  if (!normalized) {
    return detailMetaBadge('Device', '-')
  }
  return `<button type="button" class="device-focus-btn" data-device-focus="${esc(normalized)}">Device: <span class="mono">${esc(normalized)}</span></button>`
}

function bindDeviceFocusButtons(container, userId, accounts, focusSection = 'sessions') {
  container.querySelectorAll('.device-focus-btn[data-device-focus]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation()
      await focusClientDeviceForUser(userId, accounts, button.dataset.deviceFocus, focusSection)
    })
  })
}

function bindSessionFocusButtons(container, userId, accounts) {
  container.querySelectorAll('.session-focus-btn[data-session-focus]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation()
      await focusSessionForUser(
        userId,
        accounts,
        button.dataset.sessionFocus,
        button.dataset.sessionDeviceId,
      )
    })
  })
}

function bindExpandableRequestRows(container, userId, accounts, reqDetailCache, colspan, focusSection, autoExpandRequestId = null) {
  if (!container) return
  const detailEl = document.getElementById('user-detail')
  bindDeviceFocusButtons(container, userId, accounts, focusSection)
  bindSessionFocusButtons(container, userId, accounts)
  container.querySelectorAll('.req-row').forEach((row) => {
    row.addEventListener('click', async () => {
      const reqId = row.dataset.requestId
      const existing = row.nextElementSibling
      if (existing && existing.classList.contains('req-detail-row')) {
        existing.remove()
        if (detailEl) {
          updateUserFocusBar(detailEl, userId, accounts, {
            focusSection,
            requestId: null,
          })
        }
        return
      }
      container.querySelectorAll('.req-detail-row').forEach((requestRow) => requestRow.remove())

      const detailRow = document.createElement('tr')
      detailRow.className = 'req-detail-row'
      detailRow.innerHTML = `<td colspan="${colspan}" style="padding:.5rem"><span class="text-dim">Loading...</span></td>`
      row.after(detailRow)

      try {
        if (!reqDetailCache[reqId]) {
          const { request } = await api.getRequestDetail(userId, reqId)
          reqDetailCache[reqId] = request
        }
        const detail = reqDetailCache[reqId]
        detailRow.innerHTML = `<td colspan="${colspan}" style="padding:0">${renderRequestDetail(detail)}</td>`
        bindDeviceFocusButtons(detailRow, userId, accounts, focusSection)
        bindSessionFocusButtons(detailRow, userId, accounts)
        if (detailEl) {
          updateUserFocusBar(detailEl, userId, accounts, {
            focusSection,
            sessionKey: detail.sessionKey || row.dataset.sessionKey || null,
            requestId: reqId,
          })
        }
      } catch (error) {
        detailRow.innerHTML = `<td colspan="${colspan}" style="padding:.5rem"><span class="text-red">Failed: ${esc(error.message)}</span></td>`
      }
    })
  })
  if (autoExpandRequestId) {
    const targetRow = [...container.querySelectorAll('.req-row')]
      .find((row) => row.dataset.requestId === autoExpandRequestId)
    if (targetRow) {
      targetRow.click()
    }
  }
}

async function focusClientDeviceForUser(userId, accounts, clientDeviceId, focusSection = 'sessions') {
  const normalized = normalizeClientDeviceId(clientDeviceId)
  if (!normalized) return
  await loadUserDetail(userId, accounts, {
    selectedClientDeviceId: normalized,
    focusSection,
  })
}

async function focusSessionForUser(userId, accounts, sessionKey, clientDeviceId) {
  if (!sessionKey) return
  await loadUserDetail(userId, accounts, {
    selectedClientDeviceId: normalizeClientDeviceId(clientDeviceId),
    focusSection: 'sessions',
    autoExpandSessionKey: sessionKey,
  })
}

// Copy buttons in table
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.btn-copy')
  if (btn && btn.dataset.copy) {
    e.stopPropagation()
    navigator.clipboard.writeText(btn.dataset.copy)
    toast('Copied')
  }
})

function diffHeaders(incoming, upstream) {
  if (!incoming || !upstream) return ''
  const lines = []
  const allKeys = new Set([...Object.keys(incoming), ...Object.keys(upstream)])
  for (const k of [...allKeys].sort()) {
    const a = String(incoming[k] ?? '')
    const b = String(upstream[k] ?? '')
    if (!(k in incoming)) {
      lines.push(`<span style="color:#4ade80">+ ${esc(k)}: ${esc(b)}</span>`)
    } else if (!(k in upstream)) {
      lines.push(`<span style="color:#f87171">- ${esc(k)}: ${esc(a)}</span>`)
    } else if (a !== b) {
      lines.push(`<span style="color:#fbbf24">~ ${esc(k)}: ${esc(a)} -> ${esc(b)}</span>`)
    }
  }
  return lines.length ? lines.join('\n') : ''
}

function fmtJson(str) {
  try { return JSON.stringify(JSON.parse(str), null, 2) } catch { return str }
}

function fmtNum(n) {
  return Number(n || 0).toLocaleString()
}

function fmtTokens(n) {
  if (!n) return '0'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

function timeAgo(iso) {
  if (!iso) return '-'
  const diff = Date.now() - new Date(iso).getTime()
  const secs = Math.floor(diff / 1000)
  if (secs < 5) return 'just now'
  if (secs < 60) return secs + 's ago'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return mins + 'm ago'
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return hrs + 'h ago'
  return Math.floor(hrs / 24) + 'd ago'
}

function routingModeBadge(mode) {
  if (mode === 'pinned_account') return '<span class="badge badge-blue">Pinned</span>'
  if (mode === 'preferred_group') return '<span class="badge badge-yellow">Preferred Group</span>'
  return '<span class="badge badge-green">Auto</span>'
}

function routingModeHelp(mode) {
  if (mode === 'pinned_account') return '当前 user 会固定命中所选账号，不参与自动调度。'
  if (mode === 'preferred_group') return '当前 user 只在指定 routing group 内调度，仍会走额度、健康度和 session affinity 评分。'
  return '当前 user 不固定账号，由调度器根据额度、session、健康度和代理质量自动决策。'
}

function normalizeGroup(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function resolveUserRoutingGroupId(user) {
  return normalizeGroup(user?.routingGroupId) || normalizeGroup(user?.preferredGroup)
}

function resolveAccountRoutingGroupId(account) {
  return normalizeGroup(account?.routingGroupId) || normalizeGroup(account?.group)
}

function describeRoutingGroup(routingGroupId) {
  if (!routingGroupId) {
    return 'default'
  }
  const routingGroup = cachedRoutingGroupMap[routingGroupId] ?? null
  return routingGroup?.name || routingGroupId
}

function buildRoutingGroupOptionsHtml(selectedId, includeDefault = true) {
  const normalizedSelectedId = normalizeGroup(selectedId)
  const options = []
  if (includeDefault) {
    options.push(`<option value="" ${normalizedSelectedId ? '' : 'selected'}>Default Pool</option>`)
  }
  for (const group of cachedRoutingGroups) {
    options.push(
      `<option value="${esc(group.id)}" ${group.id === normalizedSelectedId ? 'selected' : ''}>${esc(formatRoutingGroupOptionLabel(group))}</option>`,
    )
  }
  if (normalizedSelectedId && !cachedRoutingGroups.some((group) => group.id === normalizedSelectedId)) {
    options.push(`<option value="${esc(normalizedSelectedId)}" selected>${esc(`${normalizedSelectedId} [unknown]`)}</option>`)
  }
  return options.join('')
}

function formatRoutingGroupOptionLabel(group) {
  const namePart = group.name && group.name !== group.id ? `${group.name} (${group.id})` : group.id
  return group.isActive ? namePart : `${namePart} [disabled]`
}

function renderRoutingGroupSelectionHint(routingGroupId) {
  if (!routingGroupId) {
    return '留空表示该 user 不绑定正式 routing group，Auto 模式会在默认候选池里调度。'
  }
  const routingGroup = cachedRoutingGroupMap[routingGroupId] ?? null
  if (!routingGroup) {
    return `当前选择的 routing group 不存在：${esc(routingGroupId)}。建议先去 <a href="#scheduler">Routing</a> 页面修复。`
  }
  const namePart = routingGroup.name && routingGroup.name !== routingGroup.id
    ? `${routingGroup.name} (${routingGroup.id})`
    : routingGroup.id
  const description = routingGroup.description ? ` · ${esc(routingGroup.description)}` : ''
  const status = routingGroup.isActive ? '启用中' : '已禁用'
  return `${esc(namePart)} · ${status}${description}`
}

function getCandidateAccounts(accounts, routingMode, routingGroupId) {
  if (routingMode === 'preferred_group' && routingGroupId) {
    return accounts.filter((account) => resolveAccountRoutingGroupId(account) === routingGroupId)
  }
  return accounts
}

function renderCandidateAccountsList(accounts, routingMode, routingGroupId) {
  const heading = routingMode === 'preferred_group' && routingGroupId
    ? `${accounts.length} accounts in ${esc(describeRoutingGroup(routingGroupId))}`
    : `${accounts.length} accounts visible`
  if (!accounts.length) {
    return `
      <div class="text-dim" style="font-size:.75rem;margin-bottom:.2rem">${heading}</div>
      <div class="text-muted">No accounts match the current routing scope.</div>
    `
  }
  return `
    <div class="text-dim" style="font-size:.75rem;margin-bottom:.2rem">${heading}</div>
    ${accounts.map((account) => `
      <div style="display:flex;justify-content:space-between;gap:.75rem;padding:.45rem .55rem;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.05);border-radius:6px">
        <span>${esc(account.emailAddress || account.id)}</span>
        <span class="text-dim">${esc(account.provider || 'unknown')} · ${esc(describeRoutingGroup(resolveAccountRoutingGroupId(account)))} · ${esc(account.schedulerState || 'enabled')}</span>
      </div>
    `).join('')}
  `
}

function renderPinnedAccountOptions(accounts, selectedAccountId) {
  return accounts.map((account) => {
    const labelParts = [
      account.emailAddress || account.id,
      describeRoutingGroup(resolveAccountRoutingGroupId(account)),
      account.provider || 'unknown',
    ]
    return `<option value="${esc(account.id)}" ${account.id === selectedAccountId ? 'selected' : ''}>${esc(labelParts.join(' · '))}</option>`
  }).join('')
}

function esc(str) {
  const d = document.createElement('div')
  d.textContent = str ?? ''
  return d.innerHTML
}
