import { cn } from '~/lib/cn'

export function LoadingSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn('animate-pulse rounded-lg bg-bg-card', className)} />
  )
}

export function PageSkeleton() {
  return (
    <div className="space-y-5">
      <LoadingSkeleton className="h-32 w-full rounded-xl" />
      <div className="grid grid-cols-3 gap-4 max-md:grid-cols-1">
        <LoadingSkeleton className="h-20 rounded-xl" />
        <LoadingSkeleton className="h-20 rounded-xl" />
        <LoadingSkeleton className="h-20 rounded-xl" />
      </div>
      <LoadingSkeleton className="h-64 w-full rounded-xl" />
    </div>
  )
}
