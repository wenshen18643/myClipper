import type { RunDiagnostics } from './run-diagnostics'
import type { PipelineStage } from './job-progress'
import type { JobOutput } from './job-output'

export interface ClipJobRequest {
  workflow?: 'automatic' | 'review'
  videoUrl: string
  
  clippingMode?: 'quality' | 'economy' | 'advanced' | 'local'
  
  plannerModel?: string
  transcriptionModel?: string
  
  clipRequest?: string
  maxClips: number | null
  autoClipCount: boolean
  durationRanges: string[] | null
  aspectRatio: string
  layoutStyle: string
  layoutVision: boolean
  pacing: string
  
  videoSpeed?: number
  includeCaptions: boolean
  captionPreset: string
  
  includeTitle?: boolean
  startTimeSeconds: number | null
  endTimeSeconds: number | null
  bannerPlatform: string | null
  bannerChannelUrl: string | null
}

export const MAX_PARALLEL_JOBS = 2

export const MAX_FINISHED_JOBS = 50

export type ActiveJobStatus = 'queued' | 'pending' | 'downloading' | 'contextualizing' | 'transcribing' | 'planning' | 'rendering' | 'uploading'
export type TerminalJobStatus = 'completed' | 'failed' | 'cancelled'
export type JobStatus = ActiveJobStatus | TerminalJobStatus

export const ACTIVE_JOB_STATUSES: readonly ActiveJobStatus[] = ['queued', 'pending', 'downloading', 'contextualizing', 'transcribing', 'planning', 'rendering', 'uploading']

export function isActiveJobStatus(status: string): status is ActiveJobStatus {
  return (ACTIVE_JOB_STATUSES as readonly string[]).includes(status)
}

export interface JobSnapshot {
  id: string
  revision: number
  request: ClipJobRequest
  status: JobStatus
  percent: number
  stages?: PipelineStage[]
  diagnostics?: RunDiagnostics
  progressAt?: number
  step: string
  clipsDone: number
  clipsTotal: number
  error: string | null
  
  errorHint: string | null
  failureCode?: string | null
  failureStage?: string | null
  httpStatus?: number | null
  output: JobOutput | null
  
  outputDir: string
  queuedAt: string
  startedAt: string | null
  finishedAt: string | null
}
