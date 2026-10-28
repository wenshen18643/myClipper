export const OPUS_CLIP = {
  checked: 'Sep 2026',
  usdPerCredit: 29 / 300,
  priceTerms: 'Pro, $29 for 300 credits',
  processingMinutes: 20,
  processingTerms: '20–40 minutes'
} as const

export function comparisonDurationSeconds(sourceSeconds: number, analysisSeconds: unknown): number | null {
  return Number.isFinite(sourceSeconds) && typeof analysisSeconds === 'number' &&
    Number.isFinite(analysisSeconds) && analysisSeconds > 0 && analysisSeconds <= sourceSeconds
    ? analysisSeconds : null
}

export function opusClipCredits(sourceSeconds: number): number {
  return Math.max(1, Math.floor(Math.max(0, sourceSeconds) / 60))
}

export function opusClipCostUsd(sourceSeconds: number): number | null {
  if (!Number.isFinite(sourceSeconds) || sourceSeconds <= 0) return null
  return opusClipCredits(sourceSeconds) * OPUS_CLIP.usdPerCredit
}

export function percentLessThanOpusClip(runUsd: number, sourceSeconds: number): number | null {
  const theirs = opusClipCostUsd(sourceSeconds)
  if (theirs === null || !Number.isFinite(runUsd) || runUsd < 0 || runUsd >= theirs) return null
  const percent = Math.floor((1 - runUsd / theirs) * 100)
  return percent > 0 ? percent : null
}

export function timesFasterThanOpusClip(processingSeconds: number, analyzedSeconds: number | null): number | null {
  if (!Number.isFinite(processingSeconds) || processingSeconds <= 0) return null
  if (analyzedSeconds === null || !Number.isFinite(analyzedSeconds) || analyzedSeconds < OPUS_CLIP.processingMinutes * 60) return null
  const times = (OPUS_CLIP.processingMinutes * 60) / processingSeconds
  return times >= 1.1 ? times : null
}

export function formatTimes(times: number): string {
  return `${times >= 10 ? Math.floor(times) : Math.floor(times * 10) / 10}×`
}
