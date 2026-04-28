import { cn } from '~/lib/cn'

export function StatCard({ value, label, caption, className }: {
  value: string | number
  label: string
  caption?: string
  className?: string
}) {
  return (
    <div className={cn('bg-ccdash-card border border-ccdash-border rounded-xl p-4', className)}>
      <div className="text-2xl font-bold text-slate-100">{value}</div>
      <div className="text-xs text-slate-400 mt-1">{label}</div>
      {caption && <div className="text-[11px] text-slate-500 mt-0.5">{caption}</div>}
    </div>
  )
}
