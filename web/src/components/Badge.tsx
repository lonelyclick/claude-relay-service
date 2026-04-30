import { cn } from '~/lib/cn'

const toneClasses = {
  green: 'bg-emerald-500/10 text-emerald-400 ring-emerald-500/20',
  red: 'bg-rose-500/10 text-rose-400 ring-rose-500/20',
  yellow: 'bg-amber-500/10 text-amber-400 ring-amber-500/20',
  blue: 'bg-sky-500/10 text-sky-400 ring-sky-500/20',
  gray: 'bg-slate-500/10 text-slate-400 ring-slate-500/20',
  orange: 'bg-orange-500/10 text-orange-400 ring-orange-500/20',
  cyan: 'bg-cyan-500/10 text-cyan-400 ring-cyan-500/20',
} as const

export type BadgeTone = keyof typeof toneClasses

export function Badge({ tone = 'gray', children, className }: {
  tone?: BadgeTone
  children: React.ReactNode
  className?: string
}) {
  return (
    <span className={cn(
      'inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium ring-1',
      toneClasses[tone],
      className,
    )}>
      {children}
    </span>
  )
}
