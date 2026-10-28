import { create } from 'zustand'

export type WizardStep = 'video' | 'format' | 'clips' | 'captions' | 'review'

export interface StartedJob {
  jobId: string
  source: string
  
  queued: boolean
}

export interface ClipDraft {
  workflow: 'automatic' | 'review' | null
  source: string
  clippingMode: 'quality' | 'economy' | 'advanced' | 'local'
  plannerModel: string
  transcriptionModel: string
  aspectRatio: '9:16' | '16:9'
  
  layoutStyle: 'auto' | 'fill' | 'fit' | 'headline'
  
  layoutVision: boolean
  
  pacing: 'tight' | 'natural'
  videoSpeed: number
  
  clipRequest: string
  durations: string[]
  autoClipCount: boolean
  maxClips: number
  includeCaptions: boolean
  captionPreset: string
  
  includeTitle: boolean
  trimOpen: boolean
  trimStart: string
  trimEnd: string
}

interface DraftState extends ClipDraft {
  step: WizardStep
  started: StartedJob | null
  update: (patch: Partial<ClipDraft>) => void
  setStep: (step: WizardStep) => void
  clearSource: () => void
  
  markStarted: (started: StartedJob) => void
  startAnother: () => void
}

export const useDraftStore = create<DraftState>((set) => ({
  workflow: null,
  source: '',
  clippingMode: 'quality',
  plannerModel: '',
  transcriptionModel: '',
  aspectRatio: '9:16',
  layoutStyle: 'auto',
  layoutVision: true,
  pacing: 'tight',
  videoSpeed: 1,
  clipRequest: '',
  durations: ['short'],
  autoClipCount: true,
  maxClips: 5,
  includeCaptions: true,
  captionPreset: 'pop',
  includeTitle: true,
  trimOpen: false,
  trimStart: '',
  trimEnd: '',
  step: 'video',
  started: null,
  update: (patch) => set(patch),
  setStep: (step) => set({ step }),
  clearSource: () => set({ source: '', trimStart: '', trimEnd: '' }),
  markStarted: (started) => set({ started }),
  startAnother: () => set({ workflow: null, source: '', clipRequest: '', trimOpen: false, trimStart: '', trimEnd: '', step: 'video', started: null })
}))
