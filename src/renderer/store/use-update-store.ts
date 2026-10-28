import { create } from 'zustand'
import type { UpdateState } from '../../shared/updates'

interface UpdateStore {
  
  update: UpdateState | null
  set: (update: UpdateState) => void
}

export const useUpdateStore = create<UpdateStore>((set) => ({
  update: null,
  set: (update) => set({ update })
}))
