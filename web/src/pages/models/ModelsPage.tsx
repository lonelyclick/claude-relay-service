import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import {
  bulkAdjustChannelMultipliers,
  copyChannelMultipliers,
  deleteBaseSku,
  deleteChannelMultiplier,
  listBaseSkus,
  listChannelMultipliers,
  upsertBaseSku,
  upsertChannelMultiplier,
} from '~/api/billing'
import { listRoutingGroups } from '~/api/routing'
import type {
  BillingBaseSku,
  BillingChannelMultiplier,
  BillingCurrency,
  BillingModelProvider,
  BillingModelProtocol,
  BillingModelVendor,
  RoutingGroup,
} from '~/api/types'
import { Badge } from '~/components/Badge'
import { PageSkeleton } from '~/components/LoadingSkeleton'
import { useToast } from '~/components/Toast'
import { fmtMoneyMicros, timeAgo } from '~/lib/format'

const vendors: BillingModelVendor[] = ['anthropic', 'openai', 'google', 'deepseek', 'zhipu', 'mimo', 'custom']
const protocols: BillingModelProtocol[] = ['anthropic_messages', 'openai_chat', 'openai_responses', 'gemini']
const currencies: BillingCurrency[] = ['USD', 'CNY']

const BASE_VIEW = '__base__' as const
type ProtocolFilter = '' | BillingModelProtocol
type VendorFilter = '' | BillingModelVendor
type CurrencyFilter = '' | BillingCurrency

function vendorLabel(vendor: BillingModelVendor): string {
  if (vendor === 'zhipu') return 'Zhipu / GLM'
  return vendor[0].toUpperCase() + vendor.slice(1)
}

function protocolLabel(protocol: BillingModelProtocol): string {
  if (protocol === 'anthropic_messages') return 'Anthropic Messages'
  if (protocol === 'openai_chat') return 'OpenAI Chat'
  if (protocol === 'openai_responses') return 'OpenAI Responses'
  return 'Gemini'
}

function providerForProtocol(protocol: BillingModelProtocol): BillingModelProvider {
  if (protocol === 'anthropic_messages') return 'anthropic'
  if (protocol === 'gemini') return 'google'
  return 'openai'
}

function matchesProtocolVendorFilters(
  item: { protocol: BillingModelProtocol; modelVendor: BillingModelVendor },
  protocol: ProtocolFilter,
  vendor: VendorFilter,
): boolean {
  if (protocol && item.protocol !== protocol) return false
  if (vendor && item.modelVendor !== vendor) return false
  return true
}

function inferVendor(model: string, protocol: BillingModelProtocol): BillingModelVendor {
  const normalized = model.trim().toLowerCase()
  if (normalized.startsWith('claude')) return 'anthropic'
  if (normalized.startsWith('gpt') || normalized.startsWith('o1') || normalized.startsWith('o3') || normalized.startsWith('o4')) return 'openai'
  if (normalized.startsWith('gemini')) return 'google'
  if (normalized.startsWith('deepseek')) return 'deepseek'
  if (normalized.startsWith('glm')) return 'zhipu'
  if (normalized.startsWith('mimo')) return 'mimo'
  return providerForProtocol(protocol)
}

function skuKey(input: { protocol: BillingModelProtocol; modelVendor: BillingModelVendor; model: string }): string {
  return `${input.protocol}|${input.modelVendor}|${input.model}`
}

function baseSkuKey(input: { protocol: BillingModelProtocol; modelVendor: BillingModelVendor; model: string; currency: BillingCurrency }): string {
  return `${skuKey(input)}|${input.currency}`
}

function microsToHuman(micros: string): string {
  try {
    const v = BigInt(micros || '0')
    return (Number(v) / 1_000_000).toString()
  } catch {
    return '0'
  }
}

function humanToMicros(human: string): string {
  const trimmed = human.trim()
  if (!trimmed) return '0'
  const num = Number(trimmed)
  if (!Number.isFinite(num) || num < 0) return '0'
  return Math.round(num * 1_000_000).toString()
}

function applyMul(basePriceMicros: string, multiplierMicros: string): string {
  try {
    const base = BigInt(basePriceMicros || '0')
    const mul = BigInt(multiplierMicros || '1000000')
    const half = 500_000n
    const product = base * mul
    if (product === 0n) return '0'
    return ((product + half) / 1_000_000n).toString()
  } catch {
    return basePriceMicros
  }
}

export function ModelsPage() {
  const toast = useToast()
  const qc = useQueryClient()
  const baseQ = useQuery({ queryKey: ['billing-base-skus'], queryFn: () => listBaseSkus() })
  const mulQ = useQuery({ queryKey: ['billing-channel-multipliers'], queryFn: () => listChannelMultipliers() })
  const groupQ = useQuery({ queryKey: ['routing-groups'], queryFn: () => listRoutingGroups() })

  const groups = groupQ.data?.routingGroups ?? []
  const baseSkus = baseQ.data?.skus ?? []
  const multipliers = mulQ.data?.multipliers ?? []

  const groupSummaries = useMemo(() => {
    const map = new Map<string, { id: string; name: string; type?: string; total: number; active: number }>()
    for (const g of groups) {
      map.set(g.id, { id: g.id, name: g.name, type: g.type, total: 0, active: 0 })
    }
    for (const m of multipliers) {
      const e = map.get(m.routingGroupId) ?? { id: m.routingGroupId, name: m.routingGroupId, total: 0, active: 0 }
      e.total += 1
      if (m.isActive) e.active += 1
      map.set(m.routingGroupId, e)
    }
    return [...map.values()].sort((l, r) => l.name.localeCompare(r.name))
  }, [groups, multipliers])

  const [selected, setSelected] = useState<string>(BASE_VIEW)
  const [filterProtocol, setFilterProtocol] = useState<ProtocolFilter>('')
  const [filterVendor, setFilterVendor] = useState<VendorFilter>('')
  const [filterCurrency, setFilterCurrency] = useState<CurrencyFilter>('')
  const [showAddBase, setShowAddBase] = useState(false)
  const [showAddMultiplier, setShowAddMultiplier] = useState(false)
  const [showBulk, setShowBulk] = useState(false)
  const [showCopy, setShowCopy] = useState(false)

  const filteredGroupSummaries = filterProtocol
    ? groupSummaries.filter((g) => g.type === providerForProtocol(filterProtocol))
    : groupSummaries

  useEffect(() => {
    if (selected !== BASE_VIEW && !filteredGroupSummaries.some((g) => g.id === selected)) {
      setSelected(BASE_VIEW)
    }
  }, [filteredGroupSummaries, selected])

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['billing-base-skus'] })
    qc.invalidateQueries({ queryKey: ['billing-channel-multipliers'] })
  }

  if (baseQ.isLoading || mulQ.isLoading || groupQ.isLoading) {
    return <PageSkeleton />
  }

  const allGroupMultipliers = selected === BASE_VIEW
    ? []
    : multipliers
        .filter((m) => m.routingGroupId === selected)
        .sort((l, r) => l.protocol.localeCompare(r.protocol) || l.modelVendor.localeCompare(r.modelVendor) || l.model.localeCompare(r.model))
  const visibleGroupMultipliers = allGroupMultipliers.filter((m) =>
    matchesProtocolVendorFilters(m, filterProtocol, filterVendor),
  )
  const hasModelFilters = Boolean(filterProtocol || filterVendor)

  const selectedGroup = selected === BASE_VIEW ? null : groupSummaries.find((g) => g.id === selected) ?? null

  return (
    <div className="space-y-5">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300">Models &amp; Pricing</div>
          <h2 className="text-xl font-bold text-slate-100">模型与定价</h2>
          <div className="text-sm text-slate-500 mt-1">
            「基准价」维护每个模型的标准价格（USD / CNY 各一份）；每个渠道在基准上设倍率，最终价 = 基准价 × 倍率。
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <section className="bg-bg-card border border-border-default rounded-xl p-3 shadow-xs space-y-3">
          <div className="space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300">视图</div>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-slate-500 shrink-0">协议</span>
                {(['', ...protocols] as const).map((p) => (
                  <button
                    key={p}
                    onClick={() => setFilterProtocol(p)}
                    className={`px-2.5 py-1 rounded-md text-xs transition-colors ${
                      filterProtocol === p
                        ? 'bg-accent-muted text-indigo-200 border border-accent'
                        : 'border border-border-default/60 text-slate-400 hover:text-slate-200 hover:bg-bg-card-raised/40'
                    }`}
                  >
                    {p === '' ? 'All' : protocolLabel(p)}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-slate-500 shrink-0">Vendor</span>
                {(['', ...vendors] as const).map((v) => (
                  <button
                    key={v}
                    onClick={() => setFilterVendor(v)}
                    className={`px-2.5 py-1 rounded-md text-xs transition-colors ${
                      filterVendor === v
                        ? 'bg-emerald-500/20 text-emerald-200 border border-emerald-500/40'
                        : 'border border-border-default/60 text-slate-400 hover:text-slate-200 hover:bg-bg-card-raised/40'
                    }`}
                  >
                    {v === '' ? 'All' : vendorLabel(v)}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-slate-500 shrink-0">币种</span>
                {(['', 'USD', 'CNY'] as const).map((c) => (
                  <button
                    key={c}
                    onClick={() => setFilterCurrency(c)}
                    className={`px-2.5 py-1 rounded-md text-xs transition-colors ${
                      filterCurrency === c
                        ? 'bg-amber-500/20 text-amber-200 border border-amber-500/40'
                        : 'border border-border-default/60 text-slate-400 hover:text-slate-200 hover:bg-bg-card-raised/40'
                    }`}
                  >
                    {c === '' ? 'All' : c}
                  </button>
                ))}
              </div>
              <div className="text-xs text-slate-600">{filteredGroupSummaries.length} 个渠道</div>
            </div>
          </div>

          <div>
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              className="w-full bg-bg-input border border-border-default rounded-lg px-3 py-2 text-sm text-slate-200"
            >
              <option value={BASE_VIEW}>⭐ 基准价 ({baseSkus.length} SKU)</option>
              {filteredGroupSummaries.length === 0 && groupSummaries.length > 0 ? (
                <option disabled>— 没有匹配的渠道 —</option>
              ) : (
                filteredGroupSummaries.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.type ? `${g.type} · ` : ''}{g.name}  [{g.id}]  {g.active}/{g.total}
                  </option>
                ))
              )}
            </select>
          </div>
        </section>

        <main className="space-y-3 min-w-0">
          {selected === BASE_VIEW ? (
            <BaseSkuView
              skus={baseSkus}
              filterProtocol={filterProtocol}
              filterVendor={filterVendor}
              filterCurrency={filterCurrency}
              onAdd={() => setShowAddBase(true)}
              invalidate={invalidate}
            />
          ) : selectedGroup ? (
            <ChannelMultiplierView
              group={selectedGroup}
              multipliers={visibleGroupMultipliers}
              allMultiplierCount={allGroupMultipliers.length}
              isFiltered={hasModelFilters}
              baseSkus={baseSkus}
              onAdd={() => setShowAddMultiplier(true)}
              onBulk={() => setShowBulk(true)}
              onCopy={() => setShowCopy(true)}
              invalidate={invalidate}
            />
          ) : null}
        </main>
      </div>

      {showAddBase && (
        <AddBaseSkuDialog
          existing={baseSkus}
          onClose={() => setShowAddBase(false)}
          onAdded={() => {
            invalidate()
            setShowAddBase(false)
            toast.success('基准 SKU 已保存')
          }}
        />
      )}
      {showAddMultiplier && selectedGroup && (
        <AddMultiplierDialog
          group={selectedGroup}
          baseSkus={baseSkus}
          existing={allGroupMultipliers}
          onClose={() => setShowAddMultiplier(false)}
          onAdded={() => {
            invalidate()
            setShowAddMultiplier(false)
            toast.success('已启用模型')
          }}
        />
      )}
      {showBulk && selectedGroup && (
        <BulkAdjustMultipliersDialog
          groupId={selectedGroup.id}
          multipliers={visibleGroupMultipliers}
          onClose={() => setShowBulk(false)}
          onDone={(updated) => {
            invalidate()
            setShowBulk(false)
            toast.success(`已更新 ${updated} 条倍率`)
          }}
        />
      )}
      {showCopy && selectedGroup && (
        <CopyMultipliersDialog
          target={selectedGroup}
          allGroups={groupSummaries}
          onClose={() => setShowCopy(false)}
          onDone={(copied, skipped) => {
            invalidate()
            setShowCopy(false)
            toast.success(`已复制 ${copied} 条新增 / ${skipped} 条已存在跳过`)
          }}
        />
      )}
    </div>
  )
}

function BaseSkuView({
  skus,
  filterProtocol,
  filterVendor,
  filterCurrency,
  onAdd,
  invalidate,
}: {
  skus: BillingBaseSku[]
  filterProtocol: ProtocolFilter
  filterVendor: VendorFilter
  filterCurrency: CurrencyFilter
  onAdd: () => void
  invalidate: () => void
}) {
  const visibleSkus = skus.filter((s) => {
    if (!matchesProtocolVendorFilters(s, filterProtocol, filterVendor)) return false
    if (filterCurrency && s.currency !== filterCurrency) return false
    return true
  })
  return (
    <>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <div className="text-base font-semibold text-slate-100">⭐ 基准价</div>
          <div className="text-xs text-slate-500 mt-1">每个 (protocol, vendor, model, currency) 一行；渠道倍率在这个基础上乘。</div>
        </div>
        <button
          onClick={onAdd}
          className="px-3 py-1.5 rounded-lg text-sm font-medium bg-amber-600 text-white hover:bg-amber-500"
        >
          + 添加模型基准
        </button>
      </div>
      <div className="bg-bg-card border border-border-default rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-slate-500 uppercase tracking-wider border-b border-border-default">
              <th className="text-left py-3 px-3">Vendor</th>
              <th className="text-left py-3 px-3">Protocol</th>
              <th className="text-left py-3 px-3">Model</th>
              <th className="text-center py-3 px-3">Currency</th>
              <th className="text-right py-3 px-3">Input / 1M</th>
              <th className="text-right py-3 px-3">Output / 1M</th>
              <th className="text-right py-3 px-3">Cache W / 1M</th>
              <th className="text-right py-3 px-3">Cache R / 1M</th>
              <th className="text-center py-3 px-3">Active</th>
              <th className="text-right py-3 px-3">Updated</th>
              <th className="py-3 px-3"></th>
            </tr>
          </thead>
          <tbody>
            {visibleSkus.length === 0 && (
              <tr>
                <td colSpan={11} className="text-center py-10 text-sm text-slate-500">
                  {skus.length === 0 ? '还没有基准 SKU。点右上角「+ 添加模型基准」开始。' : '没有匹配的基准 SKU。'}
                </td>
              </tr>
            )}
            {visibleSkus.map((sku) => (
              <BaseSkuRow key={sku.id} sku={sku} onSaved={invalidate} />
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

function BaseSkuRow({ sku, onSaved }: { sku: BillingBaseSku; onSaved: () => void }) {
  const toast = useToast()

  const upsert = useMutation({
    mutationFn: (patch: Partial<BillingBaseSku>) =>
      upsertBaseSku({
        provider: sku.provider,
        modelVendor: sku.modelVendor,
        protocol: sku.protocol,
        model: sku.model,
        currency: sku.currency,
        displayName: sku.displayName,
        isActive: sku.isActive,
        supportsPromptCaching: sku.supportsPromptCaching,
        inputPriceMicrosPerMillion: sku.inputPriceMicrosPerMillion,
        outputPriceMicrosPerMillion: sku.outputPriceMicrosPerMillion,
        cacheCreationPriceMicrosPerMillion: sku.cacheCreationPriceMicrosPerMillion,
        cacheReadPriceMicrosPerMillion: sku.cacheReadPriceMicrosPerMillion,
        topupCurrency: sku.topupCurrency,
        topupAmountMicros: sku.topupAmountMicros,
        creditAmountMicros: sku.creditAmountMicros,
        ...patch,
      }),
    onSuccess: () => onSaved(),
    onError: (err) => toast.error(err.message),
  })

  const del = useMutation({
    mutationFn: () => deleteBaseSku(sku.id),
    onSuccess: () => {
      onSaved()
      toast.success('已删除')
    },
    onError: (err) => toast.error(err.message),
  })

  return (
    <tr className="border-b border-border-default/40 hover:bg-bg-card-raised/20">
      <td className="py-2 px-3 text-slate-300">{vendorLabel(sku.modelVendor)}</td>
      <td className="py-2 px-3 text-slate-300">{protocolLabel(sku.protocol)}</td>
      <td className="py-2 px-3 text-slate-100 font-mono text-xs">{sku.model}</td>
      <td className="py-2 px-3 text-center"><Badge tone="gray">{sku.currency}</Badge></td>
      <PriceCell value={sku.inputPriceMicrosPerMillion} currency={sku.currency} disabled={upsert.isPending} onSave={(v) => upsert.mutate({ inputPriceMicrosPerMillion: v })} />
      <PriceCell value={sku.outputPriceMicrosPerMillion} currency={sku.currency} disabled={upsert.isPending} onSave={(v) => upsert.mutate({ outputPriceMicrosPerMillion: v })} />
      <PriceCell value={sku.cacheCreationPriceMicrosPerMillion} currency={sku.currency} disabled={upsert.isPending} onSave={(v) => upsert.mutate({ cacheCreationPriceMicrosPerMillion: v })} />
      <PriceCell value={sku.cacheReadPriceMicrosPerMillion} currency={sku.currency} disabled={upsert.isPending} onSave={(v) => upsert.mutate({ cacheReadPriceMicrosPerMillion: v })} />
      <td className="py-2 px-3 text-center">
        <input type="checkbox" checked={sku.isActive} disabled={upsert.isPending}
          onChange={(e) => upsert.mutate({ isActive: e.target.checked })} />
      </td>
      <td className="py-2 px-3 text-right text-[11px] text-slate-500">{timeAgo(sku.updatedAt)}</td>
      <td className="py-2 px-3 text-right">
        <button
          onClick={() => { if (confirm(`删除该基准 SKU? ${baseSkuKey(sku)}`)) del.mutate() }}
          disabled={del.isPending}
          className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50"
        >删除</button>
      </td>
    </tr>
  )
}

function ChannelMultiplierView({
  group,
  multipliers,
  allMultiplierCount,
  isFiltered,
  baseSkus,
  onAdd,
  onBulk,
  onCopy,
  invalidate,
}: {
  group: { id: string; name: string; type?: string; total: number; active: number }
  multipliers: BillingChannelMultiplier[]
  allMultiplierCount: number
  isFiltered: boolean
  baseSkus: BillingBaseSku[]
  onAdd: () => void
  onBulk: () => void
  onCopy: () => void
  invalidate: () => void
}) {
  return (
    <>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <div className="text-base font-semibold text-slate-100">{group.name}</div>
          <div className="text-xs text-slate-500 mt-1 flex items-center gap-2">
            <span className="font-mono">{group.id}</span>
            {group.type && <Badge tone="gray">{group.type}</Badge>}
            <Badge tone="blue">{group.active}/{group.total} 倍率</Badge>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={onAdd} className="px-3 py-1.5 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-500">+ 启用模型</button>
          <button onClick={onBulk} disabled={multipliers.length === 0}
            className="px-3 py-1.5 rounded-lg text-sm font-medium border border-border-default text-slate-200 hover:bg-bg-card-raised/40 disabled:opacity-50">批量调倍率</button>
          <button onClick={onCopy}
            className="px-3 py-1.5 rounded-lg text-sm font-medium border border-border-default text-slate-200 hover:bg-bg-card-raised/40">从其他渠道复制</button>
        </div>
      </div>
      <div className="bg-bg-card border border-border-default rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-slate-500 uppercase tracking-wider border-b border-border-default">
              <th className="text-left py-3 px-3">Vendor</th>
              <th className="text-left py-3 px-3">Protocol</th>
              <th className="text-left py-3 px-3">Model</th>
              <th className="text-right py-3 px-3">倍率</th>
              <th className="text-right py-3 px-3">USD 实际价 (input/output)</th>
              <th className="text-right py-3 px-3">CNY 实际价 (input/output)</th>
              <th className="text-center py-3 px-3">启用</th>
              <th className="text-center py-3 px-3">售卖</th>
              <th className="text-center py-3 px-3">前台</th>
              <th className="text-right py-3 px-3">Updated</th>
              <th className="py-3 px-3"></th>
            </tr>
          </thead>
          <tbody>
            {multipliers.length === 0 && (
              <tr>
                <td colSpan={11} className="text-center py-10 text-sm text-slate-500">
                  {allMultiplierCount === 0
                    ? '这个渠道还没启用任何模型。点右上角「+ 启用模型」从基准选。'
                    : isFiltered
                      ? '没有匹配当前协议 / Vendor 过滤的模型。'
                      : '这个渠道还没启用任何模型。点右上角「+ 启用模型」从基准选。'}
                </td>
              </tr>
            )}
            {multipliers.map((m) => {
              const baseUsd = baseSkus.find((b) => skuKey(b) === skuKey(m) && b.currency === 'USD')
              const baseCny = baseSkus.find((b) => skuKey(b) === skuKey(m) && b.currency === 'CNY')
              return <MultiplierRow key={m.id} m={m} baseUsd={baseUsd} baseCny={baseCny} onSaved={invalidate} />
            })}
          </tbody>
        </table>
      </div>
    </>
  )
}

function MultiplierRow({
  m,
  baseUsd,
  baseCny,
  onSaved,
}: {
  m: BillingChannelMultiplier
  baseUsd?: BillingBaseSku
  baseCny?: BillingBaseSku
  onSaved: () => void
}) {
  const toast = useToast()
  const upsert = useMutation({
    mutationFn: (patch: Partial<{ multiplierMicros: string; isActive: boolean; showInFrontend: boolean; allowCalls: boolean }>) =>
      upsertChannelMultiplier({
        routingGroupId: m.routingGroupId,
        provider: m.provider,
        modelVendor: m.modelVendor,
        protocol: m.protocol,
        model: m.model,
        multiplierMicros: m.multiplierMicros,
        isActive: m.isActive,
        showInFrontend: m.showInFrontend,
        allowCalls: m.allowCalls,
        ...patch,
      }),
    onSuccess: () => onSaved(),
    onError: (err) => toast.error(err.message),
  })
  const del = useMutation({
    mutationFn: () => deleteChannelMultiplier(m.id),
    onSuccess: () => { onSaved(); toast.success('已禁用') },
    onError: (err) => toast.error(err.message),
  })

  const previewPair = (base?: BillingBaseSku) => {
    if (!base) return <span className="text-slate-600">— (基准缺失)</span>
    const inp = applyMul(base.inputPriceMicrosPerMillion, m.multiplierMicros)
    const out = applyMul(base.outputPriceMicrosPerMillion, m.multiplierMicros)
    return (
      <span className="text-[11px] text-slate-400 font-mono">
        {fmtMoneyMicros(inp, base.currency)} / {fmtMoneyMicros(out, base.currency)}
      </span>
    )
  }

  return (
    <tr className="border-b border-border-default/40 hover:bg-bg-card-raised/20">
      <td className="py-2 px-3 text-slate-300">{vendorLabel(m.modelVendor)}</td>
      <td className="py-2 px-3 text-slate-300">{protocolLabel(m.protocol)}</td>
      <td className="py-2 px-3 text-slate-100 font-mono text-xs">{m.model}</td>
      <MultiplierCell value={m.multiplierMicros} disabled={upsert.isPending} onSave={(v) => upsert.mutate({ multiplierMicros: v })} />
      <td className="py-2 px-3 text-right">{previewPair(baseUsd)}</td>
      <td className="py-2 px-3 text-right">{previewPair(baseCny)}</td>
      <td className="py-2 px-3 text-center">
        <input type="checkbox" checked={m.isActive} disabled={upsert.isPending}
          onChange={(e) => upsert.mutate({ isActive: e.target.checked })} />
      </td>
      <td className="py-2 px-3 text-center">
        <input
          type="checkbox"
          checked={m.allowCalls}
          disabled={upsert.isPending}
          title="是否允许用户实际调用/售卖该渠道模型"
          onChange={(e) => upsert.mutate({ allowCalls: e.target.checked })}
        />
      </td>
      <td className="py-2 px-3 text-center">
        <input
          type="checkbox"
          checked={m.showInFrontend}
          disabled={upsert.isPending}
          title="是否显示到 cc-webapp 模型广场和价格页"
          onChange={(e) => upsert.mutate({ showInFrontend: e.target.checked })}
        />
      </td>
      <td className="py-2 px-3 text-right text-[11px] text-slate-500">{timeAgo(m.updatedAt)}</td>
      <td className="py-2 px-3 text-right">
        <button onClick={() => { if (confirm(`从该渠道移除 ${m.protocol}/${m.modelVendor}/${m.model}?`)) del.mutate() }}
          disabled={del.isPending} className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50">移除</button>
      </td>
    </tr>
  )
}

function PriceCell({
  value, currency, disabled, onSave,
}: { value: string; currency: BillingCurrency; disabled: boolean; onSave: (microsString: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(microsToHuman(value))
  useEffect(() => { setDraft(microsToHuman(value)) }, [value])
  const commit = () => {
    setEditing(false)
    const next = humanToMicros(draft)
    if (next !== value) onSave(next)
  }
  return (
    <td className="py-2 px-3 text-right text-slate-200">
      {editing ? (
        <input autoFocus value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') { setDraft(microsToHuman(value)); setEditing(false) }
          }}
          disabled={disabled}
          className="w-24 bg-bg-input border border-border-default rounded px-2 py-1 text-right text-sm text-slate-200" />
      ) : (
        <button onClick={() => setEditing(true)} disabled={disabled}
          className="text-right hover:bg-bg-card-raised/40 rounded px-2 py-1 disabled:opacity-50" title="点击编辑">
          {fmtMoneyMicros(value, currency)}
        </button>
      )}
    </td>
  )
}

function MultiplierCell({
  value, disabled, onSave,
}: { value: string; disabled: boolean; onSave: (microsString: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(microsToHuman(value))
  useEffect(() => { setDraft(microsToHuman(value)) }, [value])
  const commit = () => {
    setEditing(false)
    const next = humanToMicros(draft)
    if (next !== value && next !== '0') onSave(next)
    else setDraft(microsToHuman(value))
  }
  return (
    <td className="py-2 px-3 text-right">
      {editing ? (
        <input autoFocus value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') { setDraft(microsToHuman(value)); setEditing(false) }
          }}
          disabled={disabled}
          inputMode="decimal"
          placeholder="1.0"
          className="w-20 bg-bg-input border border-border-default rounded px-2 py-1 text-right text-sm text-slate-200" />
      ) : (
        <button onClick={() => setEditing(true)} disabled={disabled}
          className="text-right hover:bg-bg-card-raised/40 rounded px-2 py-1 disabled:opacity-50 font-mono text-slate-100" title="点击编辑">
          ×{microsToHuman(value)}
        </button>
      )}
    </td>
  )
}

function AddBaseSkuDialog({
  existing, onClose, onAdded,
}: { existing: BillingBaseSku[]; onClose: () => void; onAdded: () => void }) {
  const toast = useToast()
  const [modelVendor, setModelVendor] = useState<BillingModelVendor>('anthropic')
  const [protocol, setProtocol] = useState<BillingModelProtocol>('anthropic_messages')
  const [model, setModel] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [currency, setCurrency] = useState<BillingCurrency>('USD')
  const [input, setInput] = useState('0')
  const [output, setOutput] = useState('0')
  const [cacheW, setCacheW] = useState('0')
  const [cacheR, setCacheR] = useState('0')
  const [supportsCache, setSupportsCache] = useState(true)

  const create = useMutation({
    mutationFn: () => upsertBaseSku({
      provider: providerForProtocol(protocol), modelVendor, protocol, model: model.trim(), currency,
      displayName: displayName.trim() || undefined,
      isActive: true,
      supportsPromptCaching: supportsCache,
      inputPriceMicrosPerMillion: humanToMicros(input),
      outputPriceMicrosPerMillion: humanToMicros(output),
      cacheCreationPriceMicrosPerMillion: humanToMicros(cacheW),
      cacheReadPriceMicrosPerMillion: humanToMicros(cacheR),
    }),
    onSuccess: () => onAdded(),
    onError: (err) => toast.error(err.message),
  })

  const exists = existing.some((s) => s.protocol === protocol && s.modelVendor === modelVendor && s.model === model.trim() && s.currency === currency)
  const sibling = existing.find((s) => s.protocol === protocol && s.modelVendor === modelVendor && s.model === model.trim() && s.currency !== currency)

  return (
    <Modal title="添加 / 更新基准 SKU" onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Protocol">
          <select value={protocol} onChange={(e) => setProtocol(e.target.value as BillingModelProtocol)}
            className="w-full bg-bg-input border border-border-default rounded px-2 py-1 text-sm text-slate-200">
            {protocols.map((p) => <option key={p} value={p}>{protocolLabel(p)}</option>)}
          </select>
        </Field>
        <Field label="Model Vendor">
          <select value={modelVendor} onChange={(e) => setModelVendor(e.target.value as BillingModelVendor)}
            className="w-full bg-bg-input border border-border-default rounded px-2 py-1 text-sm text-slate-200">
            {vendors.map((v) => <option key={v} value={v}>{vendorLabel(v)}</option>)}
          </select>
        </Field>
        <Field label="Currency">
          <select value={currency} onChange={(e) => setCurrency(e.target.value as BillingCurrency)}
            className="w-full bg-bg-input border border-border-default rounded px-2 py-1 text-sm text-slate-200">
            {currencies.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="Model ID *" full>
          <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="claude-sonnet-4-6"
            className="w-full bg-bg-input border border-border-default rounded px-2 py-1 text-sm text-slate-200" />
        </Field>
        <div className="col-span-2 flex flex-wrap gap-2 text-[11px] text-slate-500">
          <button type="button" onClick={() => setModelVendor(inferVendor(model, protocol))} className="text-indigo-400 hover:underline">按 Model ID 推断厂商</button>
          <span>内部兼容家族会按协议自动保存。</span>
        </div>
        <Field label="Display Name (可选)" full>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Claude Sonnet 4.6"
            className="w-full bg-bg-input border border-border-default rounded px-2 py-1 text-sm text-slate-200" />
        </Field>
        <Field label={`Input / 1M (${currency})`}><PriceInput value={input} onChange={setInput} /></Field>
        <Field label={`Output / 1M (${currency})`}><PriceInput value={output} onChange={setOutput} /></Field>
        <Field label={`Cache Write / 1M (${currency})`}><PriceInput value={cacheW} onChange={setCacheW} /></Field>
        <Field label={`Cache Read / 1M (${currency})`}><PriceInput value={cacheR} onChange={setCacheR} /></Field>
        <label className="flex items-center gap-2 col-span-2 text-sm text-slate-300">
          <input type="checkbox" checked={supportsCache} onChange={(e) => setSupportsCache(e.target.checked)} />
          支持 Prompt Caching
        </label>
      </div>
      {exists && <div className="text-xs text-amber-300 mt-2">该 (protocol, vendor, model, currency) 已存在，提交会覆盖。</div>}
      {!exists && sibling && <div className="text-xs text-slate-500 mt-2">提示：已有 {sibling.currency} 基准（{fmtMoneyMicros(sibling.inputPriceMicrosPerMillion, sibling.currency)} / {fmtMoneyMicros(sibling.outputPriceMicrosPerMillion, sibling.currency)}），现在添加 {currency} 配套基准。</div>}
      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-sm border border-border-default text-slate-300">取消</button>
        <button onClick={() => create.mutate()} disabled={create.isPending || !model.trim()}
          className="px-3 py-1.5 rounded-lg text-sm bg-amber-600 text-white hover:bg-amber-500 disabled:opacity-50">保存</button>
      </div>
    </Modal>
  )
}

function AddMultiplierDialog({
  group, baseSkus, existing, onClose, onAdded,
}: {
  group: { id: string; name: string }
  baseSkus: BillingBaseSku[]
  existing: BillingChannelMultiplier[]
  onClose: () => void
  onAdded: () => void
}) {
  const toast = useToast()
  const enabledKeys = useMemo(() => new Set(existing.map(skuKey)), [existing])
  const candidates = useMemo(() => {
    const seen = new Set<string>()
    const out: Array<{ provider: BillingModelProvider; modelVendor: BillingModelVendor; protocol: BillingModelProtocol; model: string; displayName: string }> = []
    for (const b of baseSkus) {
      const key = skuKey(b)
      if (seen.has(key) || enabledKeys.has(key)) continue
      seen.add(key)
      out.push({ provider: b.provider, modelVendor: b.modelVendor, protocol: b.protocol, model: b.model, displayName: b.displayName })
    }
    return out.sort((l, r) => l.protocol.localeCompare(r.protocol) || l.modelVendor.localeCompare(r.modelVendor) || l.model.localeCompare(r.model))
  }, [baseSkus, enabledKeys])

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [multiplier, setMultiplier] = useState('1.0')

  const toggle = (key: string) => setSelected((prev) => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })

  const create = useMutation({
    mutationFn: async () => {
      let added = 0
      for (const key of selected) {
        const candidate = candidates.find((c) => skuKey(c) === key)
        if (!candidate) throw new Error(`Selected model is no longer available: ${key}`)
        await upsertChannelMultiplier({
          routingGroupId: group.id,
          provider: candidate.provider,
          modelVendor: candidate.modelVendor,
          protocol: candidate.protocol,
          model: candidate.model,
          multiplierMicros: humanToMicros(multiplier),
          isActive: true,
          showInFrontend: true,
          allowCalls: true,
        })
        added += 1
      }
      return { added }
    },
    onSuccess: () => onAdded(),
    onError: (err) => toast.error(err.message),
  })

  return (
    <Modal title={`在「${group.name}」启用模型`} onClose={onClose} wide>
      <div className="space-y-3">
        <Field label="初始倍率">
          <PriceInput value={multiplier} onChange={setMultiplier} />
        </Field>
        <div>
          <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
            <span>从基准选模型（{selected.size}/{candidates.length}）</span>
            <div className="flex gap-2">
              <button onClick={() => setSelected(new Set(candidates.map(skuKey)))} className="text-indigo-400 hover:underline">全选</button>
              <button onClick={() => setSelected(new Set())} className="text-slate-400 hover:underline">清空</button>
            </div>
          </div>
          <div className="max-h-64 overflow-y-auto bg-bg-input border border-border-default rounded-lg p-2 space-y-1">
            {candidates.length === 0 && (
              <div className="text-xs text-slate-500 py-3 text-center">所有基准 SKU 已启用，或基准列表为空。</div>
            )}
            {candidates.map((c) => {
              const key = skuKey(c)
              return (
                <label key={key} className="flex items-center gap-2 text-xs text-slate-300 hover:bg-bg-card-raised/30 rounded px-2 py-1">
                  <input type="checkbox" checked={selected.has(key)} onChange={() => toggle(key)} />
                  <span className="font-mono">{c.protocol} / {c.modelVendor} / {c.model}</span>
                  <span className="ml-2 text-slate-500">{c.displayName}</span>
                </label>
              )
            })}
          </div>
        </div>
      </div>
      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-sm border border-border-default text-slate-300">取消</button>
        <button onClick={() => create.mutate()} disabled={create.isPending || selected.size === 0}
          className="px-3 py-1.5 rounded-lg text-sm bg-indigo-600 text-white hover:bg-indigo-500 transition-colors duration-150 disabled:opacity-50">启用</button>
      </div>
    </Modal>
  )
}

function BulkAdjustMultipliersDialog({
  groupId, multipliers, onClose, onDone,
}: {
  groupId: string
  multipliers: BillingChannelMultiplier[]
  onClose: () => void
  onDone: (updated: number) => void
}) {
  const toast = useToast()
  const [mode, setMode] = useState<'scale' | 'fixed'>('scale')
  const [scale, setScale] = useState('1.1')
  const [setMul, setSetMul] = useState('1.0')
  const [selected, setSelected] = useState<Set<string>>(new Set(multipliers.map((m) => m.id)))
  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next
  })

  const adjust = useMutation({
    mutationFn: () => {
      const payload: Parameters<typeof bulkAdjustChannelMultipliers>[0] = {
        routingGroupId: groupId,
        multiplierIds: [...selected],
      }
      if (mode === 'scale') {
        const s = Number(scale)
        if (!Number.isFinite(s) || s <= 0) throw new Error('缩放系数需为正数')
        payload.scale = s
      } else {
        payload.setMultiplierMicros = humanToMicros(setMul)
      }
      return bulkAdjustChannelMultipliers(payload)
    },
    onSuccess: (res) => onDone(res.updated),
    onError: (err) => toast.error(err.message),
  })

  return (
    <Modal title="批量调倍率" onClose={onClose} wide>
      <div className="space-y-3">
        <div className="flex gap-2">
          <button onClick={() => setMode('scale')}
            className={`px-3 py-1.5 rounded-lg text-sm ${mode === 'scale' ? 'bg-accent-muted text-indigo-200 border border-accent' : 'border border-border-default text-slate-300'}`}>缩放当前倍率</button>
          <button onClick={() => setMode('fixed')}
            className={`px-3 py-1.5 rounded-lg text-sm ${mode === 'fixed' ? 'bg-accent-muted text-indigo-200 border border-accent' : 'border border-border-default text-slate-300'}`}>设为统一倍率</button>
        </div>
        {mode === 'scale' ? (
          <Field label="缩放系数（如 1.1 表示提价 10%，0.9 表示降价 10%）">
            <PriceInput value={scale} onChange={setScale} />
          </Field>
        ) : (
          <Field label="新倍率（如 0.7 表示七折）">
            <PriceInput value={setMul} onChange={setSetMul} />
          </Field>
        )}
        <div>
          <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
            <span>选择应用范围（{selected.size}/{multipliers.length}）</span>
            <div className="flex gap-2">
              <button onClick={() => setSelected(new Set(multipliers.map((m) => m.id)))} className="text-indigo-400 hover:underline">全选</button>
              <button onClick={() => setSelected(new Set())} className="text-slate-400 hover:underline">清空</button>
            </div>
          </div>
          <div className="max-h-56 overflow-y-auto bg-bg-input border border-border-default rounded-lg p-2 space-y-1">
            {multipliers.map((m) => (
              <label key={m.id} className="flex items-center gap-2 text-xs text-slate-300 hover:bg-bg-card-raised/30 rounded px-2 py-1">
                <input type="checkbox" checked={selected.has(m.id)} onChange={() => toggle(m.id)} />
                <span className="font-mono">{m.protocol} / {m.modelVendor} / {m.model}</span>
                <span className="ml-auto text-slate-500">×{microsToHuman(m.multiplierMicros)}</span>
              </label>
            ))}
          </div>
        </div>
      </div>
      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-sm border border-border-default text-slate-300">取消</button>
        <button onClick={() => adjust.mutate()} disabled={adjust.isPending || selected.size === 0}
          className="px-3 py-1.5 rounded-lg text-sm bg-indigo-600 text-white hover:bg-indigo-500 transition-colors duration-150 disabled:opacity-50">应用</button>
      </div>
    </Modal>
  )
}

function CopyMultipliersDialog({
  target, allGroups, onClose, onDone,
}: {
  target: { id: string; name: string }
  allGroups: Array<{ id: string; name: string; total: number }>
  onClose: () => void
  onDone: (copied: number, skipped: number) => void
}) {
  const toast = useToast()
  const sources = allGroups.filter((g) => g.id !== target.id)
  const [from, setFrom] = useState(sources[0]?.id ?? '')
  const [overwrite, setOverwrite] = useState(false)
  const copy = useMutation({
    mutationFn: () => copyChannelMultipliers({ fromRoutingGroupId: from, toRoutingGroupId: target.id, overwrite }),
    onSuccess: (res) => onDone(res.copied, res.skipped),
    onError: (err) => toast.error(err.message),
  })

  return (
    <Modal title={`从其他渠道复制倍率到「${target.name}」`} onClose={onClose}>
      {sources.length === 0 ? (
        <div className="text-sm text-slate-400">没有可复制的源渠道。</div>
      ) : (
        <div className="space-y-3">
          <Field label="来源渠道">
            <select value={from} onChange={(e) => setFrom(e.target.value)}
              className="w-full bg-bg-input border border-border-default rounded px-2 py-1 text-sm text-slate-200">
              {sources.map((g) => (
                <option key={g.id} value={g.id}>{g.name} ({g.total} 倍率)</option>
              ))}
            </select>
          </Field>
          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
            如果目标已有同 (protocol, vendor, model) 倍率，覆盖（默认跳过）
          </label>
        </div>
      )}
      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-sm border border-border-default text-slate-300">取消</button>
        <button onClick={() => copy.mutate()} disabled={copy.isPending || !from}
          className="px-3 py-1.5 rounded-lg text-sm bg-indigo-600 text-white hover:bg-indigo-500 transition-colors duration-150 disabled:opacity-50">复制</button>
      </div>
    </Modal>
  )
}

function Modal({
  title, onClose, wide, children,
}: { title: string; onClose: () => void; wide?: boolean; children: ReactNode }) {
  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}
        className={`bg-bg-card border border-border-default rounded-xl p-5 shadow-xs ${wide ? 'max-w-2xl w-full' : 'max-w-lg w-full'}`}>
        <div className="flex items-center justify-between mb-3">
          <div className="text-base font-semibold text-slate-100">{title}</div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl leading-none">×</button>
        </div>
        {children}
      </div>
    </div>
  )
}

function Field({ label, full, children }: { label: string; full?: boolean; children: ReactNode }) {
  return (
    <label className={`space-y-1 ${full ? 'col-span-2' : ''}`}>
      <span className="text-xs text-slate-400">{label}</span>
      {children}
    </label>
  )
}

function PriceInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input value={value} onChange={(e) => onChange(e.target.value)}
      placeholder="0" inputMode="decimal"
      className="w-full bg-bg-input border border-border-default rounded px-2 py-1 text-sm text-slate-200 text-right" />
  )
}

export type _UnusedRoutingGroup = RoutingGroup
