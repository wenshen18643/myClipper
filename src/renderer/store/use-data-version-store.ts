import { create } from 'zustand'
import type { AppDataScope } from '../../shared/assistant'

interface DataVersionState {
  versions: Record<AppDataScope, number>
  bump: (scope: AppDataScope) => void
}

export const useDataVersionStore = create<DataVersionState>((set) => ({
  versions: { library: 0, automations: 0, posts: 0, settings: 0, accounts: 0 },
  bump: (scope) => set((state) => ({ versions: { ...state.versions, [scope]: state.versions[scope] + 1 } }))
}))

export function useDataVersion(scope: AppDataScope): number {
  return useDataVersionStore((state) => state.versions[scope])
}
