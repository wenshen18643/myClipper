import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

const WIDTHS = {
  
  focus: 'max-w-[720px]',
  
  narrow: 'max-w-[880px]',
  
  default: 'max-w-[1280px]',
  
  wide: 'max-w-[1680px]'
} as const

export function Page({ width = 'default', className, children }: {
  width?: keyof typeof WIDTHS
  className?: string
  children: ReactNode
}): React.JSX.Element {
  return <div className={cn('mx-auto w-full px-4 pb-10 pt-1 animate-fade-in sm:px-6 xl:px-8', WIDTHS[width], className)}>{children}</div>
}
