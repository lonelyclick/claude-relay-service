import * as api from '../api.js'
import { toast } from '../app.js'

let currentSession = null
let cachedRoutingGroups = []

export async function renderAddAccount(container = null) {
  const target = container
    || document.getElementById('page-add-account')
    || document.querySelector('#page-accounts [data-accounts-panel]')
  return mountAddAccount(target)
}

export async function mountAddAccount(container, options = {}) {
  if (!container) return

  const { embedded = false } = options
  cachedRoutingGroups = await loadRoutingGroups()

  container.innerHTML = `
    ${embedded ? '' : '<h2 style="margin-bottom:1rem">Add Account</h2>'}
    ${renderRoutingGroupBanner()}

    <div class="tabs">
      <div class="tab active" data-tab="oauth">OAuth Flow</div>
      <div class="tab" data-tab="openai-codex">OpenAI Codex</div>
      <div class="tab" data-tab="session-key">Session Key</div>
      <div class="tab" data-tab="import-tokens">Import Tokens</div>
      <div class="tab" data-tab="openai-compatible">OpenAI Compatible</div>
    </div>

    <div id="tab-oauth">
      ${renderOAuthTab()}
    </div>
    <div id="tab-openai-codex" hidden>
      ${renderOpenAICodexTab()}
    </div>
    <div id="tab-session-key" hidden>
      ${renderSessionKeyTab()}
    </div>
    <div id="tab-import-tokens" hidden>
      ${renderImportTokensTab()}
    </div>
    <div id="tab-openai-compatible" hidden>
      ${renderOpenAICompatibleTab()}
    </div>
  `

  // Tab switching
  container.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      container.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'))
      tab.classList.add('active')
      getEl(container, 'tab-oauth').hidden = tab.dataset.tab !== 'oauth'
      getEl(container, 'tab-openai-codex').hidden = tab.dataset.tab !== 'openai-codex'
      getEl(container, 'tab-session-key').hidden = tab.dataset.tab !== 'session-key'
      getEl(container, 'tab-import-tokens').hidden = tab.dataset.tab !== 'import-tokens'
      getEl(container, 'tab-openai-compatible').hidden = tab.dataset.tab !== 'openai-compatible'
    })
  })

  bindOAuthEvents(container)
  bindOpenAICodexEvents(container)
  bindSessionKeyEvents(container)
  bindImportTokensEvents(container)
  bindOpenAICompatibleEvents(container)
}

function getEl(container, id) {
  return container.querySelector(`#${id}`)
}

async function loadRoutingGroups() {
  try {
    const { routingGroups } = await api.listRoutingGroups()
    return (routingGroups ?? []).filter((group) => normalizeGroup(group.id)).sort((left, right) =>
      left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
    )
  } catch {
    return []
  }
}

function renderRoutingGroupBanner() {
  if (!cachedRoutingGroups.length) {
    return `
      <div class="card" style="margin-bottom:1rem">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:.75rem;flex-wrap:wrap">
          <div>
            <div class="text-dim" style="font-size:.8rem;margin-bottom:.25rem">Routing Groups</div>
            <div style="font-size:.9rem">还没有创建 routing group。账号可以先按默认池接入，也可以先去 Routing 页面建组。</div>
          </div>
          <a class="btn btn-sm" href="#scheduler">Open Routing</a>
        </div>
      </div>
    `
  }

  const activeCount = cachedRoutingGroups.filter((group) => group.isActive).length
  return `
    <div class="card" style="margin-bottom:1rem">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:.75rem;flex-wrap:wrap">
        <div>
          <div class="text-dim" style="font-size:.8rem;margin-bottom:.25rem">Routing Groups</div>
          <div style="font-size:.9rem">当前已有 ${cachedRoutingGroups.length} 个路由组，其中 ${activeCount} 个启用。新增账号时可以直接挂到对应池。</div>
        </div>
        <a class="btn btn-sm" href="#scheduler">Manage Routing</a>
      </div>
    </div>
  `
}

function renderGroupField({ id, label = 'Routing Group', placeholder = 'e.g. team-a' }) {
  const options = buildRoutingGroupOptionsHtml('', true)
  const helper = cachedRoutingGroups.length
    ? '建议直接绑定到正式 routing group，避免手工输入字符串造成错组。'
    : '当前还没有 routing group；你可以先留空，或去 Routing 页面创建。'
  return `
    <div class="form-group">
      <label>${label} (optional)</label>
      <select id="${id}" class="input">
        ${options}
      </select>
      <div class="text-dim" style="font-size:.75rem;margin-top:.35rem">${helper} <a href="#scheduler">Routing</a></div>
    </div>
  `
}

function buildRoutingGroupOptionsHtml(selectedId = '', includeDefault = true) {
  const normalizedSelectedId = normalizeGroup(selectedId)
  const options = []
  if (includeDefault) {
    options.push(`<option value="" ${normalizedSelectedId ? '' : 'selected'}>Default Pool</option>`)
  }
  for (const group of cachedRoutingGroups) {
    const label = formatRoutingGroupLabel(group)
    options.push(`<option value="${esc(group.id)}" ${group.id === normalizedSelectedId ? 'selected' : ''}>${esc(label)}</option>`)
  }
  if (normalizedSelectedId && !cachedRoutingGroups.some((group) => group.id === normalizedSelectedId)) {
    options.push(`<option value="${esc(normalizedSelectedId)}" selected>${esc(`${normalizedSelectedId} [unknown]`)}</option>`)
  }
  return options.join('')
}

function formatRoutingGroupLabel(group) {
  const namePart = group.name && group.name !== group.id ? `${group.name} (${group.id})` : group.id
  return group.isActive ? namePart : `${namePart} [disabled]`
}

function normalizeGroup(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

// ── OAuth Flow ──

function renderOAuthTab() {
  return `
    <div class="card">
      <h3 class="card-title mb-1">Step 1: Generate Auth URL</h3>
      <p class="text-dim mb-2" style="font-size:.85rem">Generate a URL to start the OAuth flow with Claude.ai</p>
      <div class="form-row">
        <div class="form-group">
          <label>Link Expiry (seconds, optional)</label>
          <input id="oauth-expires" type="number" min="60" placeholder="300">
        </div>
        <div></div>
      </div>
      <button class="btn btn-primary" id="generate-url-btn">Generate Auth URL</button>
      <div id="auth-url-result" hidden class="mt-2">
        <label class="text-dim" style="font-size:.8rem">Auth URL (open in browser):</label>
        <div style="display:flex;gap:.5rem;margin-top:.3rem">
          <input id="auth-url-display" readonly style="font-family:monospace;font-size:.8rem">
          <button class="btn btn-sm" id="copy-url-btn">Copy</button>
        </div>
        <p class="text-dim mt-1" style="font-size:.8rem">Session ID: <span id="session-id-display" class="mono"></span></p>
      </div>
    </div>

    <div class="card">
      <h3 class="card-title mb-1">Step 2: Exchange Code</h3>
      <p class="text-dim mb-2" style="font-size:.85rem">After completing OAuth in browser, paste the callback URL or authorization code</p>
      <div class="form-group">
        <label>Authorization (callback URL or code)</label>
        <input id="oauth-code" placeholder="Paste callback URL or code here">
      </div>
      <div class="form-group">
        <label>Label (optional)</label>
        <input id="oauth-label" placeholder="e.g. my-max-account">
      </div>
      ${renderGroupField({ id: 'oauth-group', placeholder: 'e.g. team-a' })}
      <button class="btn btn-primary" id="exchange-code-btn" disabled>Exchange Code</button>
      <div id="exchange-result" hidden class="mt-2"></div>
    </div>
  `
}

function bindOAuthEvents(container) {
  const byId = (id) => getEl(container, id)

  byId('generate-url-btn').onclick = async () => {
    try {
      const expiresIn = byId('oauth-expires').value.trim()
      const result = await api.generateAuthUrl(expiresIn ? Number(expiresIn) : undefined)
      currentSession = result.session
      byId('auth-url-display').value = result.session.authUrl
      byId('session-id-display').textContent = result.session.sessionId || result.session.id
      byId('auth-url-result').hidden = false
      byId('exchange-code-btn').disabled = false
      toast('Auth URL generated')
    } catch (e) { toast(e.message, 'error') }
  }

  byId('copy-url-btn').onclick = () => {
    const url = byId('auth-url-display').value
    navigator.clipboard.writeText(url).then(
      () => toast('Copied to clipboard'),
      () => toast('Failed to copy', 'error'),
    )
  }

  byId('exchange-code-btn').onclick = async () => {
    if (!currentSession) {
      toast('Generate an auth URL first', 'error')
      return
    }
    const code = byId('oauth-code').value.trim()
    if (!code) {
      toast('Enter the authorization code or callback URL', 'error')
      return
    }
    const label = byId('oauth-label').value.trim() || undefined
    const routingGroupId = normalizeGroup(byId('oauth-group').value) || undefined

    try {
      const result = await api.exchangeCode(currentSession.sessionId || currentSession.id, code, label, undefined, {
        routingGroupId,
      })
      const el = byId('exchange-result')
      el.hidden = false
      el.innerHTML = `
        <div class="badge badge-green" style="margin-bottom:.5rem">Account added successfully</div>
        <div class="text-dim" style="font-size:.85rem">
          <div>ID: <span class="mono">${esc(result.account?.id ?? '-')}</span></div>
          <div>Email: ${esc(result.account?.emailAddress ?? '-')}</div>
        </div>
      `
      currentSession = null
      toast('Account added!')
    } catch (e) {
      const el = byId('exchange-result')
      el.hidden = false
      el.innerHTML = `<p class="text-red">${esc(e.message)}</p>`
    }
  }
}

// ── Session Key ──

function renderOpenAICodexTab() {
  return `
    <div class="card">
      <h3 class="card-title mb-1">Step 1: Generate Codex Auth URL</h3>
      <p class="text-dim mb-2" style="font-size:.85rem">Generate a ChatGPT OAuth URL for OpenAI Codex. The browser will redirect to a localhost callback URL at the end.</p>
      <button class="btn btn-primary" id="codex-generate-url-btn">Generate Auth URL</button>
      <div id="codex-auth-url-result" hidden class="mt-2">
        <label class="text-dim" style="font-size:.8rem">Auth URL (open in browser):</label>
        <div style="display:flex;gap:.5rem;margin-top:.3rem">
          <input id="codex-auth-url-display" readonly style="font-family:monospace;font-size:.8rem">
          <button class="btn btn-sm" id="codex-copy-url-btn">Copy</button>
        </div>
        <p class="text-dim mt-1" style="font-size:.8rem">Session ID: <span id="codex-session-id-display" class="mono"></span></p>
        <p class="text-dim mt-1" style="font-size:.8rem">Login completes on a localhost callback URL. If the page fails to load, copy the final URL from the address bar and paste it below.</p>
      </div>
    </div>

    <div class="card">
      <h3 class="card-title mb-1">Step 2: Exchange Code</h3>
      <p class="text-dim mb-2" style="font-size:.85rem">After the browser redirects to localhost, paste the full callback URL or the code here.</p>
      <div class="form-group">
        <label>Authorization (callback URL or code)</label>
        <input id="codex-oauth-code" placeholder="Paste callback URL or code here">
      </div>
      <div class="form-group">
        <label>Model (optional)</label>
        <input id="codex-model-name" placeholder="gpt-5-codex" value="gpt-5-codex">
      </div>
      <div class="form-group">
        <label>API Base URL (optional)</label>
        <input id="codex-api-base-url" placeholder="https://chatgpt.com/backend-api/codex" value="https://chatgpt.com/backend-api/codex">
      </div>
      <div class="form-group">
        <label>Proxy URL (optional)</label>
        <input id="codex-proxy-url" placeholder="http://127.0.0.1:10810">
      </div>
      <div class="form-group">
        <label>Label (optional)</label>
        <input id="codex-oauth-label" placeholder="e.g. codex-main">
      </div>
      ${renderGroupField({ id: 'codex-group', placeholder: 'e.g. team-a' })}
      <button class="btn btn-primary" id="codex-exchange-code-btn" disabled>Exchange Code</button>
      <div id="codex-exchange-result" hidden class="mt-2"></div>
    </div>
  `
}

function bindOpenAICodexEvents(container) {
  const byId = (id) => getEl(container, id)
  let codexSession = null

  byId('codex-generate-url-btn').onclick = async () => {
    try {
      const result = await api.generateAuthUrl(undefined, 'openai-codex')
      codexSession = result.session
      byId('codex-auth-url-display').value = result.session.authUrl
      byId('codex-session-id-display').textContent = result.session.sessionId || result.session.id
      byId('codex-auth-url-result').hidden = false
      byId('codex-exchange-code-btn').disabled = false
      toast('Codex auth URL generated')
    } catch (e) {
      toast(e.message, 'error')
    }
  }

  byId('codex-copy-url-btn').onclick = () => {
    const url = byId('codex-auth-url-display').value
    navigator.clipboard.writeText(url).then(
      () => toast('Copied to clipboard'),
      () => toast('Failed to copy', 'error'),
    )
  }

  byId('codex-exchange-code-btn').onclick = async () => {
    if (!codexSession) {
      toast('Generate an auth URL first', 'error')
      return
    }
    const authorizationInput = byId('codex-oauth-code').value.trim()
    const label = byId('codex-oauth-label').value.trim() || undefined
    const modelName = byId('codex-model-name').value.trim() || undefined
    const apiBaseUrl = byId('codex-api-base-url').value.trim() || undefined
    const proxyUrl = byId('codex-proxy-url').value.trim() || undefined
    const routingGroupId = normalizeGroup(byId('codex-group').value) || undefined

    if (!authorizationInput) {
      toast('Enter the authorization code or callback URL', 'error')
      return
    }

    try {
      const result = await api.exchangeCode(
        codexSession.sessionId || codexSession.id,
        authorizationInput,
        label,
        undefined,
        {
          modelName,
          apiBaseUrl,
          proxyUrl,
          routingGroupId,
        },
      )
      const el = byId('codex-exchange-result')
      el.hidden = false
      el.innerHTML = `
        <div class="badge badge-green" style="margin-bottom:.5rem">Codex account added successfully</div>
        <div class="text-dim" style="font-size:.85rem">
          <div>ID: <span class="mono">${esc(result.account?.id ?? '-')}</span></div>
          <div>Email: ${esc(result.account?.emailAddress ?? '-')}</div>
          <div>Model: ${esc(result.account?.modelName ?? modelName ?? '-')}</div>
        </div>
      `
      codexSession = null
      toast('Codex account added!')
    } catch (e) {
      const el = byId('codex-exchange-result')
      el.hidden = false
      el.innerHTML = `<p class="text-red">${esc(e.message)}</p>`
    }
  }
}

// ── Session Key ──

function renderSessionKeyTab() {
  return `
    <div class="card">
      <h3 class="card-title mb-1">Login with Session Key</h3>
      <p class="text-dim mb-2" style="font-size:.85rem">Use a Claude.ai session key (sk-ant-...) to add an account directly</p>
      <div class="form-group">
        <label>Session Key</label>
        <input id="sk-input" type="password" placeholder="sk-ant-...">
      </div>
      <div class="form-group">
        <label>Label (optional)</label>
        <input id="sk-label" placeholder="e.g. my-pro-account">
      </div>
      ${renderGroupField({ id: 'sk-group', placeholder: 'e.g. team-a' })}
      <button class="btn btn-primary" id="sk-login-btn">Login</button>
      <div id="sk-result" hidden class="mt-2"></div>
    </div>
  `
}

function bindSessionKeyEvents(container) {
  const byId = (id) => getEl(container, id)

  byId('sk-login-btn').onclick = async () => {
    const sessionKey = byId('sk-input').value.trim()
    if (!sessionKey) {
      toast('Enter a session key', 'error')
      return
    }
    const label = byId('sk-label').value.trim() || undefined
    const routingGroupId = normalizeGroup(byId('sk-group').value) || undefined

    try {
      const result = await api.loginWithSessionKey(sessionKey, label, { routingGroupId })
      const el = byId('sk-result')
      el.hidden = false
      el.innerHTML = `
        <div class="badge badge-green" style="margin-bottom:.5rem">Account added successfully</div>
        <div class="text-dim" style="font-size:.85rem">
          <div>ID: <span class="mono">${esc(result.account?.id ?? '-')}</span></div>
          <div>Email: ${esc(result.account?.emailAddress ?? '-')}</div>
        </div>
      `
      byId('sk-input').value = ''
      toast('Account added!')
    } catch (e) {
      const el = byId('sk-result')
      el.hidden = false
      el.innerHTML = `<p class="text-red">${esc(e.message)}</p>`
    }
  }
}

// ── Import Tokens ──

function renderImportTokensTab() {
  return `
    <div class="card">
      <h3 class="card-title mb-1">Import OAuth Tokens</h3>
      <p class="text-dim mb-2" style="font-size:.85rem">Directly import an existing access token + refresh token (e.g. from ~/.claude/.credentials.json)</p>
      <div class="form-group">
        <label>Access Token <span class="text-red">*</span></label>
        <input id="it-access" type="password" placeholder="sk-ant-oat01-...">
      </div>
      <div class="form-group">
        <label>Refresh Token (optional)</label>
        <input id="it-refresh" type="password" placeholder="sk-ant-ort01-...">
      </div>
      <div class="form-group">
        <label>Label (optional)</label>
        <input id="it-label" placeholder="e.g. main-max">
      </div>
      ${renderGroupField({ id: 'it-group', placeholder: 'e.g. team-a' })}
      <button class="btn btn-primary" id="it-submit-btn">Import</button>
      <div id="it-result" hidden class="mt-2"></div>
    </div>
  `
}

function bindImportTokensEvents(container) {
  const byId = (id) => getEl(container, id)

  byId('it-submit-btn').onclick = async () => {
    const accessToken = byId('it-access').value.trim()
    if (!accessToken) {
      toast('Access token is required', 'error')
      return
    }
    const refreshToken = byId('it-refresh').value.trim() || undefined
    const label = byId('it-label').value.trim() || undefined
    const routingGroupId = normalizeGroup(byId('it-group').value) || undefined

    try {
      const result = await api.importTokens(accessToken, refreshToken, label, { routingGroupId })
      const el = byId('it-result')
      el.hidden = false
      el.innerHTML = `
        <div class="badge badge-green" style="margin-bottom:.5rem">Account imported successfully</div>
        <div class="text-dim" style="font-size:.85rem">
          <div>ID: <span class="mono">${esc(result.account?.id ?? '-')}</span></div>
          <div>Email: ${esc(result.account?.emailAddress ?? '-')}</div>
        </div>
      `
      byId('it-access').value = ''
      byId('it-refresh').value = ''
      toast('Account imported!')
    } catch (e) {
      const el = byId('it-result')
      el.hidden = false
      el.innerHTML = `<p class="text-red">${esc(e.message)}</p>`
    }
  }
}

// ── OpenAI Compatible ──

function renderOpenAICompatibleTab() {
  return `
    <div class="card">
      <h3 class="card-title mb-1">Add OpenAI Compatible Account</h3>
      <p class="text-dim mb-2" style="font-size:.85rem">Create an API-key-based upstream account for providers exposing an OpenAI-compatible chat completions API</p>
      <div class="form-group">
        <label>API Base URL <span class="text-red">*</span></label>
        <input id="oc-base-url" placeholder="https://api.openai.com/v1">
      </div>
      <div class="form-group">
        <label>Model <span class="text-red">*</span></label>
        <input id="oc-model-name" placeholder="gpt-4.1">
      </div>
      <div class="form-group">
        <label>API Key <span class="text-red">*</span></label>
        <input id="oc-api-key" type="password" placeholder="sk-...">
      </div>
      <div class="form-group">
        <label>Proxy URL (optional)</label>
        <input id="oc-proxy-url" placeholder="http://127.0.0.1:10810">
      </div>
      <div class="form-group">
        <label>Label (optional)</label>
        <input id="oc-label" placeholder="e.g. openai-main">
      </div>
      ${renderGroupField({ id: 'oc-group', placeholder: 'e.g. team-a' })}
      <button class="btn btn-primary" id="oc-submit-btn">Create Account</button>
      <div id="oc-result" hidden class="mt-2"></div>
    </div>
  `
}

function bindOpenAICompatibleEvents(container) {
  const byId = (id) => getEl(container, id)

  byId('oc-submit-btn').onclick = async () => {
    const apiBaseUrl = byId('oc-base-url').value.trim()
    const modelName = byId('oc-model-name').value.trim()
    const apiKey = byId('oc-api-key').value.trim()
    const proxyUrl = byId('oc-proxy-url').value.trim() || undefined
    const label = byId('oc-label').value.trim() || undefined
    const routingGroupId = normalizeGroup(byId('oc-group').value) || undefined

    if (!apiBaseUrl) {
      toast('API base URL is required', 'error')
      return
    }
    if (!modelName) {
      toast('Model is required', 'error')
      return
    }
    if (!apiKey) {
      toast('API key is required', 'error')
      return
    }

    try {
      const result = await api.createOpenAICompatibleAccount({
        apiBaseUrl,
        modelName,
        apiKey,
        proxyUrl,
        label,
        routingGroupId,
      })
      const el = byId('oc-result')
      el.hidden = false
      el.innerHTML = `
        <div class="badge badge-green" style="margin-bottom:.5rem">Account created successfully</div>
        <div class="text-dim" style="font-size:.85rem">
          <div>ID: <span class="mono">${esc(result.account?.id ?? '-')}</span></div>
          <div>Model: ${esc(result.account?.modelName ?? modelName)}</div>
        </div>
      `
      byId('oc-api-key').value = ''
      toast('OpenAI compatible account added!')
    } catch (e) {
      const el = byId('oc-result')
      el.hidden = false
      el.innerHTML = `<p class="text-red">${esc(e.message)}</p>`
    }
  }
}

function esc(str) {
  const d = document.createElement('div')
  d.textContent = str
  return d.innerHTML
}
