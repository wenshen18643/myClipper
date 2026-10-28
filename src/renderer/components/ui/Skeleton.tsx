import { cn } from '../../lib/utils'

export function Skeleton({ className }: { className?: string }): React.JSX.Element {
  return <span aria-hidden className={cn('block animate-pulse rounded-lg bg-white/[0.05]', className)} />
}
