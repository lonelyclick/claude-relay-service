import { cn } from '~/lib/cn'

export function StatCard({ value, label, caption, className }: {
  value: string | number
  label: string
  caption?: string
  className?: string
}) {
  return (
    <div className={cn(
      'bg-bg-card border border-border-default rounded-xl p-4 shadow-xs',
      'hover:shadow-card hover:border-border-hover transition-all duration-150',
      className,
    )}>
      <div className="text-xl font-semibold text-slate-100 tracking-tight">{value}</div>
      <div className="text-[11px] text-slate-400 mt-1 font-medium">{label}</div>
      {caption && <div className="text-[10px] text-slate-500 mt-1">{caption}</div>}
    </div>
  )
}
