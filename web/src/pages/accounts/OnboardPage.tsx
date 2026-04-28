import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { generateAuthUrl, exchangeCode, loginWithSessionKey, importTokens, createOpenAICompatibleAccount, createClaudeCompatibleAccount, startGeminiLogin, getGeminiLoginStatus, manualExchangeGemini } from '~/api/accounts'
import { listRoutingGroups } from '~/api/routing'
import { listProxies } from '~/api/proxies'
import type { Proxy } from '~/api/types'
import { useToast } from '~/components/Toast'
import { cn } from '~/lib/cn'

type Provider =
  | 'claude-official'
  | 'openai-codex'
  | 'openai-compatible'
  | 'claude-compatible'
  | 'google-gemini-oauth'
type ClaudeAuthMethod = 'oauth' | 'session-key' | 'import-tokens'

const providers: { id: Provider; label: string }[] = [
  { id: 'claude-official', label: 'Claude Official' },
  { id: 'openai-codex', label: 'OpenAI Codex' },
  { id: 'openai-compatible', label: 'OpenAI Compatible' },
  { id: 'claude-compatible', label: 'Claude Compatible' },
  { id: 'google-gemini-oauth', label: 'Google Gemini (OAuth)' },
]

const claudeAuthMethods: { id: ClaudeAuthMethod; label: string }[] = [
  { id: 'oauth', label: 'OAuth Flow' },
  { id: 'session-key', label: 'Session Key' },
  { id: 'import-tokens', label: 'Import Tokens' },
]

export function OnboardPage() {
  const [provider, setProvider] = useState<Provider>('claude-official')
  const [authMethod, setAuthMethod] = useState<ClaudeAuthMethod>('oauth')

  return (
    <div className="space-y-4">
      <div className="flex gap-2 flex-wrap">
        {providers.map((p) => (
          <button
            key={p.id}
            onClick={() => setProvider(p.id)}
            className={cn(
              'px-3 py-1.5 rounded-lg text-sm font-medium transition-colors',
              provider === p.id
                ? 'bg-blue-500/20 text-blue-400 border border-blue-500/40'
                : 'bg-ccdash-card border border-ccdash-border text-slate-400 hover:text-slate-200',
            )}
          >
            {p.label}
          </button>
        ))}
      </div>

      {provider === 'claude-official' && (
        <div className="flex gap-1.5 flex-wrap">
          {claudeAuthMethods.map((m) => (
            <button
              key={m.id}
              onClick={() => setAuthMethod(m.id)}
              className={cn(
                'px-2.5 py-1 rounded-md text-xs font-medium transition-colors',
                authMethod === m.id
                  ? 'bg-slate-500/20 text-slate-200 border border-slate-500/40'
                  : 'bg-ccdash-card border border-ccdash-border text-slate-500 hover:text-slate-300',
              )}
            >
              {m.label}
            </button>
          ))}
        </div>
      )}

      {provider === 'claude-official' && authMethod === 'oauth' && <OAuthForm />}
      {provider === 'claude-official' && authMethod === 'session-key' && <SessionKeyForm />}
      {provider === 'claude-official' && authMethod === 'import-tokens' && <ImportTokensForm />}
      {provider === 'openai-codex' && <CodexForm />}
      {provider === 'openai-compatible' && <OpenAICompatibleForm />}
      {provider === 'claude-compatible' && <ClaudeCompatibleForm />}
      {provider === 'google-gemini-oauth' && <GeminiForm />}
    </div>
  )
}

function GroupSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { data } = useQuery({ queryKey: ['routing-groups'], queryFn: listRoutingGroups })
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="bg-ccdash-input border border-ccdash-border rounded-lg px-3 py-1.5 text-sm text-slate-200 w-full"
    >
      <option value="">Default (no group)</option>
      {(data?.routingGroups ?? []).map((g) => (
        <option key={g.id} value={g.id}>{g.name || g.id}</option>
      ))}
    </select>
  )
}

export function getUsableProxyUrl(proxy: Pick<Proxy, 'localUrl'>): string | null {
  const localUrl = proxy.localUrl?.trim()
  if (!localUrl || !/^https?:\/\//i.test(localUrl)) {
    return null
  }
  return localUrl
}

export function ProxySelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { data } = useQuery({ queryKey: ['proxies'], queryFn: listProxies })
  const usableProxies = (data?.proxies ?? []).flatMap((proxy) => {
    const usableUrl = getUsableProxyUrl(proxy)
    if (!usableUrl) {
      return []
    }
    return [{
      id: proxy.id,
      label: proxy.label || proxy.url,
      localUrl: usableUrl,
    }]
  })
  const unavailableProxies = (data?.proxies ?? []).filter((proxy) => !getUsableProxyUrl(proxy))

  return (
    <div className="space-y-1.5">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-ccdash-input border border-ccdash-border rounded-lg px-3 py-1.5 text-sm text-slate-200 w-full"
      >
        <option value="">None (direct)</option>
        {usableProxies.map((proxy) => (
          <option key={proxy.id} value={proxy.localUrl}>
            {proxy.label} ({proxy.localUrl})
          </option>
        ))}
        {unavailableProxies.length > 0 && (
          <optgroup label="Unavailable (missing local HTTP proxy)">
            {unavailableProxies.map((proxy) => (
              <option key={proxy.id} value="" disabled>
                {proxy.label || proxy.url}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      <div className="text-[11px] text-slate-500">
        这里只会使用代理的 localUrl，例如 `http://127.0.0.1:10812`。
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-slate-400">{label}</span>
      {children}
    </label>
  )
}

function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cn(
        'bg-ccdash-input border border-ccdash-border rounded-lg px-3 py-1.5 text-sm text-slate-200 placeholder:text-slate-500 w-full focus:outline-none focus:border-blue-500/50',
        props.className,
      )}
    />
  )
}

function SubmitButton({ loading, children }: { loading: boolean; children: React.ReactNode }) {
  return (
    <button
      type="submit"
      disabled={loading}
      className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
    >
      {loading ? 'Processing...' : children}
    </button>
  )
}

function OAuthForm() {
  const toast = useToast()
  const qc = useQueryClient()
  const [step, setStep] = useState<'generate' | 'exchange'>('generate')
  const [sessionId, setSessionId] = useState('')
  const [authUrl, setAuthUrl] = useState('')
  const [code, setCode] = useState('')
  const [label, setLabel] = useState('')
  const [group, setGroup] = useState('')
  const [proxyUrl, setProxyUrl] = useState('')
  const [expiresIn, setExpiresIn] = useState('')

  const genMut = useMutation({
    mutationFn: () => generateAuthUrl(expiresIn ? Number(expiresIn) : undefined),
    onSuccess: (data) => {
      setSessionId(data.sessionId)
      setAuthUrl(data.authUrl)
      setStep('exchange')
    },
    onError: (e) => toast.error(e.message),
  })

  const exMut = useMutation({
    mutationFn: () =>
      exchangeCode(sessionId, code, label, undefined, {
        ...(group ? { routingGroupId: group } : {}),
        ...(proxyUrl ? { proxyUrl } : {}),
      }),
    onSuccess: () => {
      toast.success('Account created via OAuth')
      qc.invalidateQueries({ queryKey: ['accounts'] })
      setStep('generate')
      setCode('')
      setLabel('')
      setProxyUrl('')
      setAuthUrl('')
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <div className="bg-ccdash-card border border-ccdash-border rounded-xl p-5 space-y-4 max-w-lg">
      <div className="text-sm font-medium text-slate-200">OAuth Flow (Claude.ai)</div>
      {step === 'generate' ? (
        <form onSubmit={(e) => { e.preventDefault(); genMut.mutate() }} className="space-y-3">
          <Field label="Link Expiry (seconds, optional)">
            <Input type="number" value={expiresIn} onChange={(e) => setExpiresIn(e.target.value)} placeholder="3600" />
          </Field>
          <SubmitButton loading={genMut.isPending}>Generate Auth URL</SubmitButton>
        </form>
      ) : (
        <div className="space-y-3">
          <div className="text-xs text-slate-400">
            Auth URL generated. Open it, authorize, then paste the callback URL or code below.
          </div>
          <div className="flex gap-2">
            <a href={authUrl} target="_blank" rel="noopener" className="text-xs text-blue-400 hover:underline truncate">{authUrl}</a>
            <button onClick={() => navigator.clipboard.writeText(authUrl)} className="text-xs text-slate-400 hover:text-slate-200 shrink-0">Copy</button>
          </div>
          <form onSubmit={(e) => { e.preventDefault(); exMut.mutate() }} className="space-y-3">
            <Field label="Authorization Code or Callback URL">
              <Input value={code} onChange={(e) => setCode(e.target.value)} required />
            </Field>
            <Field label="Label (optional)">
              <Input value={label} onChange={(e) => setLabel(e.target.value)} />
            </Field>
            <Field label="Proxy">
              <ProxySelect value={proxyUrl} onChange={setProxyUrl} />
            </Field>
            <Field label="Routing Group">
              <GroupSelect value={group} onChange={setGroup} />
            </Field>
            <div className="flex gap-2">
              <SubmitButton loading={exMut.isPending}>Exchange Code</SubmitButton>
              <button type="button" onClick={() => setStep('generate')} className="px-4 py-2 rounded-lg text-sm text-slate-400 hover:text-slate-200">Back</button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}

function CodexForm() {
  const toast = useToast()
  const qc = useQueryClient()
  const [step, setStep] = useState<'generate' | 'exchange'>('generate')
  const [sessionId, setSessionId] = useState('')
  const [authUrl, setAuthUrl] = useState('')
  const [code, setCode] = useState('')
  const [label, setLabel] = useState('')
  const [group, setGroup] = useState('')
  const [modelName, setModelName] = useState('gpt-5-codex')
  const [apiBaseUrl, setApiBaseUrl] = useState('https://chatgpt.com/backend-api/codex')
  const [proxyUrl, setProxyUrl] = useState('')

  const genMut = useMutation({
    mutationFn: () => generateAuthUrl(undefined, 'openai-codex'),
    onSuccess: (data) => {
      setSessionId(data.sessionId)
      setAuthUrl(data.authUrl)
      setStep('exchange')
    },
    onError: (e) => toast.error(e.message),
  })

  const exMut = useMutation({
    mutationFn: () => exchangeCode(sessionId, code, label, undefined, {
      ...(group ? { routingGroupId: group } : {}),
      ...(modelName ? { modelName } : {}),
      ...(apiBaseUrl ? { apiBaseUrl } : {}),
      ...(proxyUrl ? { proxyUrl } : {}),
    }),
    onSuccess: () => {
      toast.success('Codex account created')
      qc.invalidateQueries({ queryKey: ['accounts'] })
      setStep('generate')
      setCode('')
      setLabel('')
      setAuthUrl('')
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <div className="bg-ccdash-card border border-ccdash-border rounded-xl p-5 space-y-4 max-w-lg">
      <div className="text-sm font-medium text-slate-200">OpenAI Codex</div>
      {step === 'generate' ? (
        <form onSubmit={(e) => { e.preventDefault(); genMut.mutate() }} className="space-y-3">
          <SubmitButton loading={genMut.isPending}>Generate Auth URL</SubmitButton>
        </form>
      ) : (
        <div className="space-y-3">
          <div className="flex gap-2">
            <a href={authUrl} target="_blank" rel="noopener" className="text-xs text-blue-400 hover:underline truncate">{authUrl}</a>
            <button onClick={() => navigator.clipboard.writeText(authUrl)} className="text-xs text-slate-400 hover:text-slate-200 shrink-0">Copy</button>
          </div>
          <form onSubmit={(e) => { e.preventDefault(); exMut.mutate() }} className="space-y-3">
            <Field label="Authorization Code or Callback URL">
              <Input value={code} onChange={(e) => setCode(e.target.value)} required />
            </Field>
            <Field label="Model Name">
              <Input value={modelName} onChange={(e) => setModelName(e.target.value)} />
            </Field>
            <Field label="API Base URL">
              <Input value={apiBaseUrl} onChange={(e) => setApiBaseUrl(e.target.value)} />
            </Field>
            <Field label="Proxy">
              <ProxySelect value={proxyUrl} onChange={setProxyUrl} />
            </Field>
            <Field label="Label (optional)">
              <Input value={label} onChange={(e) => setLabel(e.target.value)} />
            </Field>
            <Field label="Routing Group">
              <GroupSelect value={group} onChange={setGroup} />
            </Field>
            <div className="flex gap-2">
              <SubmitButton loading={exMut.isPending}>Exchange Code</SubmitButton>
              <button type="button" onClick={() => setStep('generate')} className="px-4 py-2 rounded-lg text-sm text-slate-400 hover:text-slate-200">Back</button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}

function SessionKeyForm() {
  const toast = useToast()
  const qc = useQueryClient()
  const [sessionKey, setSessionKey] = useState('')
  const [label, setLabel] = useState('')
  const [group, setGroup] = useState('')

  const mut = useMutation({
    mutationFn: () => loginWithSessionKey(sessionKey, label, group ? { routingGroupId: group } : undefined),
    onSuccess: () => {
      toast.success('Account created via session key')
      qc.invalidateQueries({ queryKey: ['accounts'] })
      setSessionKey('')
      setLabel('')
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <div className="bg-ccdash-card border border-ccdash-border rounded-xl p-5 max-w-lg">
      <div className="text-sm font-medium text-slate-200 mb-4">Session Key (sk-ant-...)</div>
      <form onSubmit={(e) => { e.preventDefault(); mut.mutate() }} className="space-y-3">
        <Field label="Session Key">
          <Input type="password" value={sessionKey} onChange={(e) => setSessionKey(e.target.value)} required placeholder="sk-ant-..." />
        </Field>
        <Field label="Label (optional)">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="Routing Group">
          <GroupSelect value={group} onChange={setGroup} />
        </Field>
        <SubmitButton loading={mut.isPending}>Create Account</SubmitButton>
      </form>
    </div>
  )
}

function ImportTokensForm() {
  const toast = useToast()
  const qc = useQueryClient()
  const [accessToken, setAccessToken] = useState('')
  const [refreshToken, setRefreshToken] = useState('')
  const [label, setLabel] = useState('')
  const [group, setGroup] = useState('')

  const mut = useMutation({
    mutationFn: () => importTokens(accessToken, refreshToken || undefined, label, group ? { routingGroupId: group } : undefined),
    onSuccess: () => {
      toast.success('Account created via token import')
      qc.invalidateQueries({ queryKey: ['accounts'] })
      setAccessToken('')
      setRefreshToken('')
      setLabel('')
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <div className="bg-ccdash-card border border-ccdash-border rounded-xl p-5 max-w-lg">
      <div className="text-sm font-medium text-slate-200 mb-4">Import Tokens</div>
      <form onSubmit={(e) => { e.preventDefault(); mut.mutate() }} className="space-y-3">
        <Field label="Access Token">
          <Input type="password" value={accessToken} onChange={(e) => setAccessToken(e.target.value)} required />
        </Field>
        <Field label="Refresh Token (optional)">
          <Input type="password" value={refreshToken} onChange={(e) => setRefreshToken(e.target.value)} />
        </Field>
        <Field label="Label (optional)">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="Routing Group">
          <GroupSelect value={group} onChange={setGroup} />
        </Field>
        <SubmitButton loading={mut.isPending}>Import</SubmitButton>
      </form>
    </div>
  )
}

function OpenAICompatibleForm() {
  const toast = useToast()
  const qc = useQueryClient()
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [proxyUrl, setProxyUrl] = useState('')
  const [label, setLabel] = useState('')
  const [group, setGroup] = useState('')

  const mut = useMutation({
    mutationFn: () => createOpenAICompatibleAccount({
      apiBaseUrl: baseUrl,
      apiKey,
      ...(proxyUrl ? { proxyUrl } : {}),
      ...(label ? { label } : {}),
      ...(group ? { routingGroupId: group } : {}),
    }),
    onSuccess: () => {
      toast.success('OpenAI-compatible account created')
      qc.invalidateQueries({ queryKey: ['accounts'] })
      setBaseUrl('')
      setApiKey('')
      setProxyUrl('')
      setLabel('')
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <div className="bg-ccdash-card border border-ccdash-border rounded-xl p-5 max-w-lg">
      <div className="text-sm font-medium text-slate-200 mb-4">OpenAI Compatible</div>
      <form onSubmit={(e) => { e.preventDefault(); mut.mutate() }} className="space-y-3">
        <Field label="API Base URL">
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} required placeholder="https://api.example.com/v1" />
        </Field>
        <Field label="API Key">
          <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} required />
        </Field>
        <Field label="Proxy">
          <ProxySelect value={proxyUrl} onChange={setProxyUrl} />
        </Field>
        <Field label="Label (optional)">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="Routing Group">
          <GroupSelect value={group} onChange={setGroup} />
        </Field>
        <SubmitButton loading={mut.isPending}>Create Account</SubmitButton>
      </form>
    </div>
  )
}

function ClaudeCompatibleForm() {
  const toast = useToast()
  const qc = useQueryClient()
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [modelName, setModelName] = useState('')
  const [opusModel, setOpusModel] = useState('')
  const [sonnetModel, setSonnetModel] = useState('')
  const [haikuModel, setHaikuModel] = useState('')
  const [proxyUrl, setProxyUrl] = useState('')
  const [label, setLabel] = useState('')
  const [group, setGroup] = useState('')

  const buildTierMap = () => {
    const opus = opusModel.trim()
    const sonnet = sonnetModel.trim()
    const haiku = haikuModel.trim()
    if (!opus && !sonnet && !haiku) return null
    return {
      opus: opus || null,
      sonnet: sonnet || null,
      haiku: haiku || null,
    }
  }

  const mut = useMutation({
    mutationFn: () => {
      const tierMap = buildTierMap()
      return createClaudeCompatibleAccount({
        apiBaseUrl: baseUrl,
        apiKey,
        modelName,
        ...(tierMap ? { modelTierMap: tierMap } : {}),
        ...(proxyUrl ? { proxyUrl } : {}),
        ...(label ? { label } : {}),
        ...(group ? { routingGroupId: group } : {}),
      })
    },
    onSuccess: () => {
      toast.success('Claude-compatible account created')
      qc.invalidateQueries({ queryKey: ['accounts'] })
      setBaseUrl('')
      setApiKey('')
      setModelName('')
      setOpusModel('')
      setSonnetModel('')
      setHaikuModel('')
      setProxyUrl('')
      setLabel('')
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <div className="bg-ccdash-card border border-ccdash-border rounded-xl p-5 max-w-lg">
      <div className="text-sm font-medium text-slate-200 mb-1">Claude Compatible</div>
      <div className="text-[11px] text-slate-500 mb-4">
        接入兼容 Anthropic /v1/messages 协议的服务，例如 DeepSeek (https://api.deepseek.com/anthropic)、GLM (https://open.bigmodel.cn/api/anthropic)。
      </div>
      <form onSubmit={(e) => { e.preventDefault(); mut.mutate() }} className="space-y-3">
        <Field label="API Base URL">
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} required placeholder="https://api.deepseek.com/anthropic" />
        </Field>
        <Field label="API Key">
          <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} required />
        </Field>
        <Field label="Default Model Name">
          <Input value={modelName} onChange={(e) => setModelName(e.target.value)} required placeholder="deepseek-chat / glm-4.6" />
        </Field>
        <div className="rounded-lg border border-ccdash-border bg-ccdash-bg/40 p-3 space-y-2">
          <div className="text-[11px] text-slate-400">
            按 Claude 家族分别映射到上游模型（可选，留空则走默认）。客户端发 claude-opus-* 命中 Opus，claude-sonnet-* 命中 Sonnet，claude-haiku-* 命中 Haiku。
          </div>
          <Field label="Opus → 上游模型">
            <Input value={opusModel} onChange={(e) => setOpusModel(e.target.value)} placeholder="deepseek-v4-pro" />
          </Field>
          <Field label="Sonnet → 上游模型">
            <Input value={sonnetModel} onChange={(e) => setSonnetModel(e.target.value)} placeholder="留空则用 Default Model" />
          </Field>
          <Field label="Haiku → 上游模型">
            <Input value={haikuModel} onChange={(e) => setHaikuModel(e.target.value)} placeholder="deepseek-v4-flash" />
          </Field>
        </div>
        <Field label="Proxy">
          <ProxySelect value={proxyUrl} onChange={setProxyUrl} />
        </Field>
        <Field label="Label (optional)">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="Routing Group">
          <GroupSelect value={group} onChange={setGroup} />
        </Field>
        <SubmitButton loading={mut.isPending}>Create Account</SubmitButton>
      </form>
    </div>
  )
}

function GeminiForm() {
  const toast = useToast()
  const qc = useQueryClient()
  const [step, setStep] = useState<'idle' | 'pending' | 'completed' | 'failed'>('idle')
  const [sessionId, setSessionId] = useState('')
  const [authUrl, setAuthUrl] = useState('')
  const [redirectUri, setRedirectUri] = useState('')
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const [group, setGroup] = useState('')
  const [proxyUrl, setProxyUrl] = useState('')
  const [modelName, setModelName] = useState('gemini-2.5-pro')

  const startMut = useMutation({
    mutationFn: () =>
      startGeminiLogin({
        ...(label ? { label } : {}),
        ...(modelName ? { modelName } : {}),
        ...(proxyUrl ? { proxyUrl } : {}),
        ...(group ? { routingGroupId: group } : {}),
      }),
    onSuccess: (data) => {
      setSessionId(data.session.sessionId)
      setAuthUrl(data.session.authUrl)
      setRedirectUri(data.session.redirectUri)
      setStep('pending')
      setStatusMessage('已生成 Google 授权链接，等待你在浏览器完成登录…')
      window.open(data.session.authUrl, '_blank', 'noopener,noreferrer')
    },
    onError: (e) => toast.error(e.message),
  })

  const reset = () => {
    setStep('idle')
    setSessionId('')
    setAuthUrl('')
    setRedirectUri('')
    setStatusMessage(null)
  }

  return (
    <div className="bg-ccdash-card border border-ccdash-border rounded-xl p-5 space-y-4 max-w-lg">
      <div>
        <div className="text-sm font-medium text-slate-200">Google Gemini (OAuth)</div>
        <div className="text-xs text-slate-500 mt-1">
          复用 gemini-cli 的 OAuth client。登录回调会通过 cor 进程内的 loopback HTTP 服务器接收，必须在
          cor 主机本身的浏览器里打开授权链接。
        </div>
      </div>

      {step === 'idle' && (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            startMut.mutate()
          }}
          className="space-y-3"
        >
          <Field label="Label (optional)">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. gemini-pro-main" />
          </Field>
          <Field label="Model Name">
            <Input value={modelName} onChange={(e) => setModelName(e.target.value)} />
          </Field>
          <Field label="Proxy">
            <ProxySelect value={proxyUrl} onChange={setProxyUrl} />
          </Field>
          <Field label="Routing Group">
            <GroupSelect value={group} onChange={setGroup} />
          </Field>
          <SubmitButton loading={startMut.isPending}>Start Google OAuth Login</SubmitButton>
        </form>
      )}

      {step === 'pending' && <GeminiPendingPanel
        authUrl={authUrl}
        redirectUri={redirectUri}
        sessionId={sessionId}
        statusMessage={statusMessage}
        onCancel={reset}
        onCompleted={(account) => {
          setStep('completed')
          setStatusMessage(`登录成功：${account.label ?? account.id}`)
          toast.success('Gemini account created')
          qc.invalidateQueries({ queryKey: ['accounts'] })
        }}
      />}

      {step === 'completed' && (
        <div className="space-y-3">
          <div className="text-sm text-emerald-400">{statusMessage}</div>
          <button type="button" onClick={reset} className="px-4 py-2 rounded-lg text-sm text-slate-200 bg-slate-700/40 hover:bg-slate-700/60">
            Add another account
          </button>
        </div>
      )}

      {step === 'failed' && (
        <div className="space-y-3">
          <div className="text-sm text-rose-400">{statusMessage}</div>
          <button type="button" onClick={reset} className="px-4 py-2 rounded-lg text-sm text-slate-200 bg-slate-700/40 hover:bg-slate-700/60">
            Try again
          </button>
        </div>
      )}
    </div>
  )
}

function GeminiPendingPanel(props: {
  authUrl: string
  redirectUri: string
  sessionId: string
  statusMessage: string | null
  onCancel: () => void
  onCompleted: (account: import('~/api/types').Account) => void
}) {
  const toast = useToast()
  const [callbackUrl, setCallbackUrl] = useState('')
  const [autoStatus, setAutoStatus] = useState<string | null>(null)

  useEffect(() => {
    if (!props.sessionId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      try {
        const res = await getGeminiLoginStatus(props.sessionId)
        if (cancelled) return
        if (res.status === 'completed' && res.account) {
          props.onCompleted(res.account)
          return
        }
        if (res.status === 'failed') {
          setAutoStatus(`自动接收失败：${res.error ?? '未知错误'}`)
          return
        }
        if (res.status === 'unknown') {
          setAutoStatus('登录会话已失效（可能超过 10 分钟）')
          return
        }
        timer = setTimeout(tick, 2500)
      } catch (err) {
        if (cancelled) return
        timer = setTimeout(tick, 5000)
      }
    }
    void tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.sessionId])

  const manualMut = useMutation({
    mutationFn: () =>
      manualExchangeGemini({
        callbackUrl: callbackUrl.trim(),
        sessionId: props.sessionId,
      }),
    onSuccess: (data) => {
      props.onCompleted(data.account)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : String(err)),
  })

  return (
    <div className="space-y-4">
      <div className="text-sm text-slate-300">{props.statusMessage}</div>

      <div className="rounded-lg border border-ccdash-border bg-ccdash-bg/40 p-3 space-y-2">
        <div className="text-xs text-slate-400 font-medium">1. 在浏览器打开授权 URL（如未自动打开请复制）</div>
        <div className="flex gap-2 items-start">
          <a
            href={props.authUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-400 hover:underline break-all flex-1"
          >
            {props.authUrl}
          </a>
          <button
            type="button"
            onClick={() => {
              navigator.clipboard.writeText(props.authUrl).then(
                () => toast.success('已复制 authUrl'),
                (err) => toast.error(err instanceof Error ? err.message : String(err)),
              )
            }}
            className="text-xs text-slate-400 hover:text-slate-200 shrink-0"
          >
            Copy
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-3 space-y-2">
        <div className="text-xs text-blue-300 font-medium">2A. 同机模式（推荐）</div>
        <div className="text-xs text-slate-400">
          如果你在 cor 主机本身的浏览器登录，Google 跳到 <code className="text-slate-300">{props.redirectUri}</code> 后 cor 进程内部的
          loopback server 会自动接住并完成登录，无需任何额外操作。
        </div>
        {autoStatus && <div className="text-xs text-rose-400">{autoStatus}</div>}
      </div>

      <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 space-y-2">
        <div className="text-xs text-amber-300 font-medium">2B. 异机模式（你正在远程访问 ccdash 时用这个）</div>
        <div className="text-xs text-slate-400">
          浏览器在 ncu 之外的机器上登录时，Google 跳到 <code>http://127.0.0.1:8085/...</code> 会"无法访问"——这是正常的，复制浏览器地址栏的完整 URL
          粘到下面，cor 会从中解析出 code 并完成登录。
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            manualMut.mutate()
          }}
          className="space-y-2"
        >
          <Field label="完整回调 URL（包含 ?code=...&state=...）">
            <Input
              value={callbackUrl}
              onChange={(e) => setCallbackUrl(e.target.value)}
              placeholder="http://127.0.0.1:8085/oauth/callback?state=...&code=..."
              required
            />
          </Field>
          <SubmitButton loading={manualMut.isPending}>Submit Callback URL</SubmitButton>
        </form>
      </div>

      <button type="button" onClick={props.onCancel} className="px-4 py-2 rounded-lg text-sm text-slate-400 hover:text-slate-200">
        Cancel
      </button>
    </div>
  )
}
