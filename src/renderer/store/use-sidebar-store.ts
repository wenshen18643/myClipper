import { useSyncExternalStore } from 'react'
import { create } from 'zustand'

const COLLAPSED_STORAGE_KEY = 'myclipper.sidebar.collapsed'

const WIDE_QUERY = '(min-width: 1024px)'

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function saveCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0')
  } catch {
  }
}

interface SidebarState {
  collapsed: boolean
  toggle: () => void
}

export const useSidebarStore = create<SidebarState>((set, get) => ({
  collapsed: readCollapsed(),
  toggle: () => {
    const collapsed = !get().collapsed
    saveCollapsed(collapsed)
    set({ collapsed })
  }
}))

function subscribeWide(onChange: () => void): () => void {
  const query = window.matchMedia(WIDE_QUERY)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

export function useIsWide(): boolean {
  return useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE_QUERY).matches)
}

export function useSidebarExpanded(): boolean {
  const collapsed = useSidebarStore((s) => s.collapsed)
  return useIsWide() && !collapsed
}
