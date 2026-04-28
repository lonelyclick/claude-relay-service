import { cn } from '~/lib/cn'

export function LoadingSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn('animate-pulse rounded-xl bg-ccdash-card', className)} />
  )
}

export function PageSkeleton() {
  return (
    <div className="space-y-4">
      <LoadingSkeleton className="h-32 w-full" />
      <div className="grid grid-cols-3 gap-4 max-md:grid-cols-1">
        <LoadingSkeleton className="h-20" />
        <LoadingSkeleton className="h-20" />
        <LoadingSkeleton className="h-20" />
      </div>
      <LoadingSkeleton className="h-64 w-full" />
    </div>
  )
}
