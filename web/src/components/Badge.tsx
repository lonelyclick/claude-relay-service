import { cn } from '~/lib/cn'

const toneClasses = {
  green: 'bg-green-500/15 text-green-400 border-green-500/30',
  red: 'bg-red-500/15 text-red-400 border-red-500/30',
  yellow: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  blue: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  gray: 'bg-slate-500/15 text-slate-400 border-slate-500/30',
  orange: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  cyan: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30',
} as const

export type BadgeTone = keyof typeof toneClasses

export function Badge({ tone = 'gray', children, className }: {
  tone?: BadgeTone
  children: React.ReactNode
  className?: string
}) {
  return (
    <span className={cn(
      'inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border',
      toneClasses[tone],
      className,
    )}>
      {children}
    </span>
  )
}
