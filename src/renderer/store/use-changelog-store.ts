import { create } from 'zustand'

interface ChangelogStore {
  open: boolean
  setOpen: (open: boolean) => void
}

export const useChangelogStore = create<ChangelogStore>((set) => ({
  open: false,
  setOpen: (open) => set({ open })
}))
