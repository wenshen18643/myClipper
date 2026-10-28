import { randomUUID } from 'crypto'
import { loadSettings } from './settings-store'
import { ensureOutputDir } from './file-manager'
import { getBridgeRunnerPath, getEnginePath, preflightCheck, resolvePythonPath, validatePython, type ClipJobConfig } from './pipeline-runner'
import { createRunRecord, finishRunRecord } from './run-history'
import { enqueueJob } from './job-manager'
import { logger } from './logger'
import { assertMediaPath, isWebUrl } from './security'
import { assertPublicWebUrl } from './network-policy'
import { validateJobConfig } from './validation'
import { resolveAdvancedModels } from './openrouter-models'
import { supportsCaptionFilter } from './tools'
import type { JobSnapshot } from '../shared/jobs'

const ENGINE_CHECK_TTL_MS = 5 * 60 * 1000
let lastEngineCheck: { key: string; at: number } | null = null

export type StartJobResult = { jobId: string; queued: boolean; job: JobSnapshot } | { error: string }

export async function startClipJobRequest(request: unknown): Promise<StartJobResult> {
  let config: ClipJobConfig
  try {
    config = validateJobConfig(request)
    if (config.clippingMode === 'advanced') {
      config.plannerCapabilities = await resolveAdvancedModels(config.plannerModel!, config.transcriptionModel!)
    }
    if (isWebUrl(config.videoUrl)) await assertPublicWebUrl(config.videoUrl)
    else assertMediaPath(config.videoUrl, loadSettings().outputDirectory)
    if (config.bannerChannelUrl) await assertPublicWebUrl(config.bannerChannelUrl)
  } catch (error) { return { error: error instanceof Error ? error.message : 'Invalid job options' } }
  const settings = loadSettings()

  if (config.clippingMode === 'local') {
    if (!settings.anthropicApiKey) {
      logger.warn('job.start.missingKey', { key: 'ANTHROPIC_API_KEY' })
      return { error: 'A Claude API key is required for Local mode. Go to Settings to add it.' }
    }
  } else if (!settings.openrouterApiKey) {
    logger.warn('job.start.missingKey', { key: 'OPENROUTER_API_KEY' })
    return { error: 'OpenRouter API key is required for AI clip planning. Go to Settings to add it.' }
  }

  const enginePath = getEnginePath()
  const bridgePath = getBridgeRunnerPath()
  const pythonPath = resolvePythonPath(enginePath, settings.pythonPath)

  const preflight = preflightCheck({ pythonPath, bridgePath, enginePath })
  if (!preflight.ok) {
    const message = preflight.hint
      ? `${preflight.error}\n\n${preflight.hint}`
      : preflight.error!
    logger.error('job.start.preflight.failed', {
      error: preflight.error,
      hint: preflight.hint,
      pythonPath,
      bridgePath,
      enginePath
    })
    return { error: message }
  }
  const engineKey = `${pythonPath}\0${enginePath}`
  if (!lastEngineCheck || lastEngineCheck.key !== engineKey || Date.now() - lastEngineCheck.at > ENGINE_CHECK_TTL_MS) {
    const pythonValidation = await validatePython(pythonPath, enginePath)
    if (!pythonValidation.ok) {
      lastEngineCheck = null
      return { error: 'The clipping engine is incomplete or incompatible. Open Settings → System check, then repair the myClipper installation before starting.' }
    }
    lastEngineCheck = { key: engineKey, at: Date.now() }
  }
  if (config.includeCaptions && !(await supportsCaptionFilter())) {
    return { error: 'FFmpeg cannot render captions because its ass filter is missing. Install an FFmpeg build with libass, or turn captions off.' }
  }

  ensureOutputDir(settings.outputDirectory)

  const jobId = randomUUID()
  logger.info('job.start.request', { jobId, sourceType: isWebUrl(config.videoUrl) ? 'remote' : 'local', aspectRatio: config.aspectRatio })
  try {
    createRunRecord(settings.outputDirectory, jobId, config.videoUrl)
  } catch {
    try { finishRunRecord(settings.outputDirectory, jobId, 'failed', 'Could not start this run.') } catch {  }
    return { error: 'Could not create the clipping run. Check the output folder and retry.' }
  }
  const job = enqueueJob(jobId, config, settings.outputDirectory)
  return { jobId, queued: job.status === 'queued', job }
}
