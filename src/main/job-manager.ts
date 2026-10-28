import { parseRunDiagnostics } from '../shared/run-diagnostics'
import { parseStages } from '../shared/job-progress'
import { join } from 'path'
import { cancelJob as cancelRunningJob, startClipJob, type ClipJobConfig, type JobEventSink } from './pipeline-runner'
import { finishRunRecord } from './run-history'
import { logger } from './logger'
import { parseJobOutput } from '../shared/job-output'
import { isActiveJobStatus, MAX_FINISHED_JOBS, MAX_PARALLEL_JOBS, type JobSnapshot, type JobStatus } from '../shared/jobs'

interface TrackedJob {
  snapshot: JobSnapshot
  config: ClipJobConfig
  outputDirectory: string
}

const jobs = new Map<string, TrackedJob>()
const queue: string[] = []

const running = new Set<string>()
let getSink: () => JobEventSink | null = () => null
const listeners = new Set<(snapshot: JobSnapshot) => void>()

export function initJobManager(windowGetter: () => JobEventSink | null): void {
  getSink = windowGetter
}

export function onJobUpdate(listener: (snapshot: JobSnapshot) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function broadcast(snapshot: JobSnapshot): void {
  const sink = getSink()
  if (sink && !sink.isDestroyed() && !sink.webContents.isDestroyed()) sink.webContents.send('jobs:update', snapshot)
  for (const listener of listeners) {
    try { listener(snapshot) } catch {  }
  }
}

function update(jobId: string, patch: Partial<Omit<JobSnapshot, 'id' | 'revision'>>): void {
  const job = jobs.get(jobId)
  if (!job) return
  job.snapshot = { ...job.snapshot, ...patch, revision: job.snapshot.revision + 1 }
  broadcast(job.snapshot)
}

function finish(jobId: string, status: Extract<JobStatus, 'completed' | 'failed' | 'cancelled'>, patch: Partial<JobSnapshot> = {}): void {
  const previous = jobs.get(jobId)?.snapshot
  const now = Date.now()
  const stages = previous?.stages?.map(stage => stage.state !== 'running' ? stage : {
    ...stage, state: status, percent: status === 'completed' ? 100 : stage.percent,
    elapsed_ms: stage.elapsed_ms + Math.max(0, now - (previous.progressAt ?? now))
  })
  update(jobId, { ...patch, ...(stages ? { stages, progressAt: now } : {}), status, finishedAt: new Date(now).toISOString() })
  pruneFinished()
}

function pruneFinished(): void {
  const finished = [...jobs.values()].filter((job) => !isActiveJobStatus(job.snapshot.status))
  for (const job of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_JOBS))) jobs.delete(job.snapshot.id)
}

export function enqueueJob(jobId: string, config: ClipJobConfig, outputDirectory: string): JobSnapshot {
  const snapshot: JobSnapshot = {
    id: jobId,
    revision: 0,
    request: config,
    status: 'queued',
    percent: 0,
    step: 'Waiting for a free slot',
    clipsDone: 0,
    clipsTotal: 0,
    error: null,
    errorHint: null,
    failureCode: null,
    failureStage: null,
    httpStatus: null,
    output: null,
    outputDir: join(outputDirectory, jobId),
    queuedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null
  }
  jobs.set(jobId, { snapshot, config, outputDirectory })
  queue.push(jobId)
  broadcast(snapshot)
  pump()
  return jobs.get(jobId)!.snapshot
}

function pump(): void {
  while (running.size < MAX_PARALLEL_JOBS && queue.length > 0) {
    const jobId = queue.shift()!
    const job = jobs.get(jobId)
    if (!job || job.snapshot.status !== 'queued') continue
    running.add(jobId)
    update(jobId, { status: 'pending', step: 'Starting…', startedAt: new Date().toISOString() })
    logger.info('jobs.start', { jobId, running: running.size, queued: queue.length })
    const sink: JobEventSink = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: (channel, payload) => onRunnerEvent(jobId, channel, payload) }
    }
    try {
      startClipJob(jobId, job.config, sink, () => onExit(jobId), job.outputDirectory)
    } catch {
      running.delete(jobId)
      try { finishRunRecord(job.outputDirectory, jobId, 'failed', 'Could not start this run.') } catch {  }
      finish(jobId, 'failed', { error: 'Could not start this run.', step: 'Failed' })
    }
  }
}

function onExit(jobId: string): void {
  if (!running.delete(jobId)) return
  pump()
}

function onRunnerEvent(jobId: string, channel: string, payload: unknown): void {
  const job = jobs.get(jobId)
  if (!job || !isActiveJobStatus(job.snapshot.status)) return
  const data = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
  const number = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)

  if (channel === 'job:progress') {
    const status = typeof data.status === 'string' && isActiveJobStatus(data.status) && data.status !== 'queued' ? data.status : job.snapshot.status
    const stages = parseStages(data.stages)
    const diagnostics = parseRunDiagnostics(data.diagnostics)
    update(jobId, {
      status,
      ...(stages ? { stages, progressAt: Date.now() } : {}),
      ...(diagnostics ? { diagnostics } : {}),
      percent: Math.max(0, Math.min(100, number(data.percent, job.snapshot.percent))),
      step: typeof data.step === 'string' ? data.step : job.snapshot.step,
      clipsDone: number(data.clips_done, job.snapshot.clipsDone),
      clipsTotal: number(data.clips_total, job.snapshot.clipsTotal)
    })
  } else if (channel === 'job:complete') {
    const output = parseJobOutput(data.output)
    if (output) {
      finish(jobId, 'completed', { output, percent: 100, step: 'Complete', clipsDone: output.total_clips, clipsTotal: output.total_clips })
    } else {
      finish(jobId, 'failed', { error: 'The clipping engine returned an unsupported result.', step: 'Failed' })
    }
  } else if (channel === 'job:error') {
    finish(jobId, 'failed', {
      error: typeof data.message === 'string' ? data.message : 'The clipping engine stopped.',
      errorHint: typeof data.hint === 'string' ? data.hint : null,
      failureCode: typeof data.failureCode === 'string' ? data.failureCode : null,
      failureStage: typeof data.failureStage === 'string' ? data.failureStage : null,
      httpStatus: typeof data.httpStatus === 'number' ? data.httpStatus : null,
      step: 'Failed'
    })
  }
}

export function cancelTrackedJob(jobId: string): boolean {
  const job = jobs.get(jobId)
  if (!job || !isActiveJobStatus(job.snapshot.status)) return false
  if (job.snapshot.status === 'queued') {
    const index = queue.indexOf(jobId)
    if (index !== -1) queue.splice(index, 1)
    try { finishRunRecord(job.outputDirectory, jobId, 'cancelled') } catch { logger.warn('job.history.writeFailed', { jobId }) }
    finish(jobId, 'cancelled', { step: 'Cancelled' })
    return true
  }
  
  if (!cancelRunningJob(jobId)) return false
  finish(jobId, 'cancelled', { step: 'Cancelled' })
  return true
}

export function dismissJob(jobId: string): boolean {
  const job = jobs.get(jobId)
  if (!job || isActiveJobStatus(job.snapshot.status)) return false
  jobs.delete(jobId)
  return true
}

export function getJob(jobId: string): JobSnapshot | null {
  return jobs.get(jobId)?.snapshot ?? null
}

export function listJobs(): JobSnapshot[] {
  return [...jobs.values()].map((job) => job.snapshot).reverse()
}

export function liveJobIds(): ReadonlySet<string> {
  return new Set([...jobs.values()].filter((job) => isActiveJobStatus(job.snapshot.status)).map((job) => job.snapshot.id))
}

export function cancelQueuedJobsForQuit(): void {
  for (const jobId of queue.splice(0)) {
    const job = jobs.get(jobId)
    if (!job) continue
    try { finishRunRecord(job.outputDirectory, jobId, 'cancelled') } catch {  }
  }
}
