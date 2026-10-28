import type { ReactNode } from 'react'
import { Sidebar, type Page } from './Sidebar'

interface LayoutProps {
  children: ReactNode
  currentPage: Page
  onNavigate: (page: Page) => void
}

export function Layout({ children, currentPage, onNavigate }: LayoutProps): React.JSX.Element {
  return (
    <div className="app-backdrop drag relative flex h-screen w-screen overflow-hidden">
      <Sidebar currentPage={currentPage} onNavigate={onNavigate} />
      <main className="relative min-w-0 flex-1">
        <div id="page-scroll" className="no-drag h-full overflow-y-auto pt-10">
          {children}
        </div>
        {}
        <div aria-hidden className="scroll-edge drag absolute left-0 right-3 top-0 z-30 h-10" />
      </main>
    </div>
  )
}
