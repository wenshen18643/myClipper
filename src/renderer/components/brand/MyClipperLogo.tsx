import lockupUrl from '../../../../resources/myclipper-logo.svg'
import iconUrl from '../../../../resources/myclipper-icon-small.svg'
import markUrl from '../../../../resources/myclipper-mark.svg'
import { cn } from '../../lib/utils'

interface MyClipperLogoProps {
  variant?: 'lockup' | 'icon' | 'mark'
  className?: string
  alt?: string
}

export function MyClipperLogo({ variant = 'lockup', className, alt = 'myClipper' }: MyClipperLogoProps): React.JSX.Element {
  return (
    <img
      src={variant === 'icon' ? iconUrl : variant === 'mark' ? markUrl : lockupUrl}
      alt={alt}
      draggable={false}
      className={cn('w-auto shrink-0 select-none', className)}
    />
  )
}
