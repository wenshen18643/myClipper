import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../../lib/utils'

interface DialogProps extends HTMLAttributes<HTMLDivElement> {
  
  onBackdropMouseDown?: () => void
  
  layer?: 'dialog' | 'system'
  panelClassName?: string
  children: ReactNode
}

export const Dialog = forwardRef<HTMLDivElement, DialogProps>(function Dialog(
  { onBackdropMouseDown, layer = 'dialog', panelClassName, className, children, ...props },
  ref
) {
  return createPortal(
    <div
      className={cn(
        'no-drag fixed inset-0 flex items-center justify-center bg-black/45 p-4 backdrop-blur-[6px] animate-fade',
        layer === 'system' ? 'z-[100]' : 'z-[90]',
        className
      )}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onBackdropMouseDown?.()
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={cn('glass-thick flex max-h-full w-full flex-col overflow-hidden rounded-3xl animate-pop-in focus:outline-none', panelClassName)}
        {...props}
      >
        {children}
      </div>
    </div>,
    document.body
  )
})

export function DialogFooter({ className, children }: { className?: string; children: ReactNode }): React.JSX.Element {
  return (
    <div className={cn('flex items-center justify-end gap-2 border-t border-white/[0.07] bg-black/20 px-4 py-3', className)}>
      {children}
    </div>
  )
}
