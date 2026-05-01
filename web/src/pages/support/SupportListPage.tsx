import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'

import { listSupportTickets, type SupportTicket, type SupportTicketStatus } from '~/api/support'
import { Badge } from '~/components/Badge'
import { PageSkeleton } from '~/components/LoadingSkeleton'

const STATUS_ORDER: Array<SupportTicketStatus | 'all'> = ['all', 'open', 'in_progress', 'resolved', 'closed']

const STATUS_LABEL: Record<SupportTicketStatus, string> = {
  open: '待处理',
  in_progress: '处理中',
  resolved: '已解决',
  closed: '已关闭',
}

const STATUS_TONE: Record<SupportTicketStatus, 'orange' | 'blue' | 'green' | 'gray'> = {
  open: 'orange',
  in_progress: 'blue',
  resolved: 'green',
  closed: 'gray',
}

const CATEGORY_LABEL: Record<SupportTicket['category'], string> = {
  billing: '计费',
  account: '账号',
  integration: '接入',
  bug: 'Bug',
  other: '其他',
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return iso
  }
}

function ownerLabel(ticket: SupportTicket): string {
  if (ticket.organizationId) {
    const name = ticket.organizationName || ticket.organizationId
    return ticket.organizationKind === 'personal' ? `个人组织：${name}` : `团队组织：${name}`
  }
  return '个人用户工单'
}

function submitterLabel(ticket: SupportTicket): string {
  return ticket.userEmail || ticket.userName || ticket.userId || '未知提交人'
}

export function SupportListPage() {
  const [status, setStatus] = useState<SupportTicketStatus | 'all'>('all')
  const [search, setSearch] = useState('')

  const tickets = useQuery({
    queryKey: ['support-tickets', status, search],
    queryFn: () =>
      listSupportTickets({
        status: status === 'all' ? undefined : status,
        search: search.trim() || undefined,
      }),
  })

  const totals = useMemo(() => {
    const items = tickets.data?.tickets ?? []
    return {
      all: items.length,
      open: items.filter((t) => t.status === 'open').length,
      in_progress: items.filter((t) => t.status === 'in_progress').length,
      resolved: items.filter((t) => t.status === 'resolved').length,
      closed: items.filter((t) => t.status === 'closed').length,
    }
  }, [tickets.data])

  if (tickets.isLoading) {
    return <PageSkeleton />
  }

  const list = tickets.data?.tickets ?? []

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300">Support Tickets</div>
          <h2 className="text-xl font-bold text-slate-100">客服工单</h2>
          <div className="text-sm text-slate-500 mt-1">用户提交的工单按最近活动倒序展示。点击进入回复 / 改状态。</div>
        </div>
        <div className="flex gap-2 flex-wrap text-xs text-slate-400">
          <Badge tone="blue">{totals.all} 条</Badge>
          <Badge tone="orange">{totals.open} 待处理</Badge>
          <Badge tone="cyan">{totals.in_progress} 处理中</Badge>
          <Badge tone="green">{totals.resolved} 已解决</Badge>
          <Badge tone="gray">{totals.closed} 已关闭</Badge>
        </div>
      </div>

      <section className="bg-bg-card border border-border-default rounded-xl p-4 shadow-xs space-y-3">
        <div className="grid grid-cols-[1fr_auto] gap-3 max-md:grid-cols-1">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索工单 ID、标题、用户邮箱/姓名、组织 ID/名称"
            className="block w-full bg-bg-input border border-border-default rounded-lg px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600"
          />
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as SupportTicketStatus | 'all')}
            className="bg-bg-input border border-border-default rounded-lg px-3 py-2 text-sm text-slate-200"
          >
            {STATUS_ORDER.map((value) => (
              <option key={value} value={value}>
                {value === 'all' ? '全部状态' : STATUS_LABEL[value as SupportTicketStatus]}
              </option>
            ))}
          </select>
        </div>
      </section>

      {list.length === 0 ? (
        <div className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs text-sm text-slate-500">
          暂无工单匹配当前筛选条件。
        </div>
      ) : (
        <div className="bg-bg-card border border-border-default rounded-xl divide-y divide-border-default">
          {list.map((ticket) => (
            <Link
              key={ticket.id}
              to={`/support/${encodeURIComponent(ticket.id)}`}
              className="block px-4 py-3 hover:bg-bg-card-raised/40 transition-colors"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={STATUS_TONE[ticket.status]}>{STATUS_LABEL[ticket.status]}</Badge>
                    <Badge tone="gray">{CATEGORY_LABEL[ticket.category]}</Badge>
                    <Badge tone={ticket.organizationId ? 'cyan' : 'blue'}>{ownerLabel(ticket)}</Badge>
                    <span className="text-base font-semibold text-slate-100 truncate">{ticket.title}</span>
                  </div>
                  <div className="mt-1 text-xs text-slate-500 font-mono truncate">
                    {ticket.id} · 提交人 {submitterLabel(ticket)}
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    创建 {fmtDate(ticket.createdAt)} · 最近活动 {fmtDate(ticket.updatedAt)} · {ticket.messageCount} 条消息
                    {ticket.organizationId ? ` · 组织 ID ${ticket.organizationId}` : ''}
                  </div>
                </div>
                <span className="text-slate-500">→</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
