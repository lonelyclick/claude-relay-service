import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import {
  getSupportTicket,
  replySupportTicket,
  updateSupportTicketStatus,
  type SupportTicket,
  type SupportTicketMessage,
  type SupportTicketStatus,
} from '~/api/support'
import { Badge } from '~/components/Badge'
import { PageSkeleton } from '~/components/LoadingSkeleton'

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

const AUTHOR_TONE: Record<SupportTicketMessage['authorKind'], string> = {
  user: 'border-border-default bg-bg-card',
  agent: 'border-cyan-400/30 bg-cyan-400/10',
  system: 'border-slate-600/30 bg-slate-600/10',
}

const AUTHOR_LABEL: Record<SupportTicketMessage['authorKind'], string> = {
  user: '用户',
  agent: '客服',
  system: '系统',
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

export function SupportDetailPage() {
  const params = useParams()
  const ticketId = params.id ?? ''
  const queryClient = useQueryClient()
  const [reply, setReply] = useState('')
  const [error, setError] = useState<string | null>(null)

  const detail = useQuery({
    queryKey: ['support-ticket', ticketId],
    queryFn: () => getSupportTicket(ticketId),
    enabled: Boolean(ticketId),
  })

  const replyMut = useMutation({
    mutationFn: (body: string) => replySupportTicket(ticketId, { body, authorName: '客服' }),
    onSuccess: () => {
      setReply('')
      setError(null)
      void queryClient.invalidateQueries({ queryKey: ['support-ticket', ticketId] })
      void queryClient.invalidateQueries({ queryKey: ['support-tickets'] })
    },
    onError: (err) => setError(err instanceof Error ? err.message : '回复失败'),
  })

  const statusMut = useMutation({
    mutationFn: (status: SupportTicketStatus) => updateSupportTicketStatus(ticketId, status),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['support-ticket', ticketId] })
      void queryClient.invalidateQueries({ queryKey: ['support-tickets'] })
    },
    onError: (err) => setError(err instanceof Error ? err.message : '状态变更失败'),
  })

  if (!ticketId) {
    return <div className="p-5 text-sm text-slate-400">缺少工单 ID</div>
  }
  if (detail.isLoading) {
    return <PageSkeleton />
  }
  if (detail.error || !detail.data) {
    return (
      <div className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs text-sm text-slate-400">
        无法加载工单：{detail.error instanceof Error ? detail.error.message : '未知错误'}
      </div>
    )
  }

  const { ticket, messages } = detail.data

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <Link
          to="/support"
          className="inline-flex h-9 items-center rounded-md border border-border-default px-3 text-xs font-medium text-slate-200 hover:bg-bg-card-raised/40"
        >
          ← 返回工单列表
        </Link>
        <div className="flex items-center gap-2">
          <Badge tone={STATUS_TONE[ticket.status]}>{STATUS_LABEL[ticket.status]}</Badge>
          <Badge tone="gray">{CATEGORY_LABEL[ticket.category]}</Badge>
          <Badge tone={ticket.organizationId ? 'cyan' : 'blue'}>{ownerLabel(ticket)}</Badge>
        </div>
      </div>

      <section className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs space-y-4">
        <div>
          <div className="flex flex-wrap items-baseline gap-2 text-xs text-slate-500">
            <span className="font-mono">{ticket.id}</span>
            <span>·</span>
            <span>创建 {fmtDate(ticket.createdAt)}</span>
            <span>·</span>
            <span>最近活动 {fmtDate(ticket.updatedAt)}</span>
          </div>
          <h2 className="mt-2 text-xl font-semibold text-slate-100">{ticket.title}</h2>
        </div>

        <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
          <div className="rounded-lg border border-border-default bg-bg-card-raised/30 p-3">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">工单归属</div>
            <div className="mt-1 text-sm font-medium text-slate-100">{ownerLabel(ticket)}</div>
            {ticket.organizationId ? (
              <div className="mt-1 break-all font-mono text-[11px] text-slate-500">{ticket.organizationId}</div>
            ) : (
              <div className="mt-1 text-[11px] text-slate-500">不关联组织账本</div>
            )}
          </div>
          <div className="rounded-lg border border-border-default bg-bg-card-raised/30 p-3">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">提交用户</div>
            <div className="mt-1 text-sm font-medium text-slate-100">{submitterLabel(ticket)}</div>
            <div className="mt-1 break-all font-mono text-[11px] text-slate-500">{ticket.userId || '无个人 relay user id'}</div>
          </div>
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-slate-500 mr-2">变更状态：</span>
        {(['open', 'in_progress', 'resolved', 'closed'] as SupportTicketStatus[]).map((s) => (
          <button
            key={s}
            type="button"
            disabled={statusMut.isPending || ticket.status === s}
            onClick={() => statusMut.mutate(s)}
            className="inline-flex h-8 items-center rounded-md border border-border-default px-3 text-xs text-slate-200 hover:bg-bg-card-raised/40 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {STATUS_LABEL[s]}
          </button>
        ))}
      </div>

      <section className="space-y-3">
        {messages.map((message) => (
          <article
            key={message.id}
            className={`rounded-xl border p-4 ${AUTHOR_TONE[message.authorKind]}`}
          >
            <div className="flex items-center justify-between gap-2 text-xs text-slate-400">
              <span className="font-medium text-slate-100">
                {AUTHOR_LABEL[message.authorKind]}
                {message.authorName ? ` · ${message.authorName}` : ''}
              </span>
              <span>{fmtDate(message.createdAt)}</span>
            </div>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-7 text-slate-200">{message.body}</p>
          </article>
        ))}
      </section>

      <section className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs space-y-3">
        <label className="block">
          <span className="text-xs text-slate-400">客服回复</span>
          <textarea
            value={reply}
            onChange={(event) => setReply(event.target.value)}
            rows={6}
            maxLength={8000}
            placeholder={ticket.status === 'closed' ? '工单已关闭，不能回复' : '客服回复内容会同步邮件给用户。'}
            disabled={ticket.status === 'closed'}
            className="mt-1 w-full bg-bg-input border border-border-default rounded-lg px-3 py-2 text-sm leading-6 text-slate-200 placeholder:text-slate-600 disabled:opacity-60"
          />
          <div className="mt-1 text-[11px] text-slate-500">{reply.length} / 8000</div>
        </label>
        {error ? (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            {error}
          </div>
        ) : null}
        <div className="flex justify-end">
          <button
            type="button"
            disabled={replyMut.isPending || ticket.status === 'closed' || !reply.trim()}
            onClick={() => replyMut.mutate(reply.trim())}
            className="rounded-md bg-cyan-500/90 px-4 py-2 text-sm font-medium text-slate-900 hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {replyMut.isPending ? '发送中…' : '发送回复'}
          </button>
        </div>
      </section>
    </div>
  )
}
