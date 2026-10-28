import type { ZernioPlatform } from './zernio'
import type { ClipMediaInfo, TikTokCreatorInfo, TikTokPostOptions, YouTubeVisibility } from './zernio-posts'

export const AUTOMATION_PLATFORMS = ['instagram', 'youtube', 'twitter', 'facebook', 'linkedin', 'threads', 'tiktok'] as const satisfies readonly ZernioPlatform[]

export interface AutomationTikTokApproval {
  caption: string
  options: TikTokPostOptions
  reviewedAt: string
  fileStamp: { size: number; mtimeMs: number; ino: number }
}

export interface AutomationTikTokReview {
  reviewId: string
  clipPath: string
  caption: string
  media: ClipMediaInfo
  creators: { info: TikTokCreatorInfo; businessConnection: boolean; handle: string }[]
}

export interface AutomationTikTokReviewUpdate {
  reviewId: string
  caption: string
  options: TikTokPostOptions
  previewConfirmed: boolean
}

export interface AutomationAccount {
  accountId: string
  platform: (typeof AUTOMATION_PLATFORMS)[number]
}

export type AutomationContentStatus = 'queued' | 'posting' | 'posted' | 'needs_review'

export interface GeneratedPlatformMetadata {
  platform: AutomationAccount['platform']
  caption: string
  
  title: string | null
  tags: string[]
  categoryId: string | null
  
  topicTag?: string | null
}

export interface AutomationSourceContext {
  
  videoId?: string
  title: string
  description: string
  channel: string
  
  url: string | null
}

export interface MetadataResearch {
  scope?: 'source'
  reused?: boolean
  researchedAt?: string
  status: 'complete' | 'unavailable' | 'skipped'
  summary: string
  sources: { title: string; url: string }[]
}

export const MAX_ENHANCEMENT_GUIDANCE = 2000

export const MAX_RESEARCH_URL = 2048

export interface MetadataEnhancement {
  
  guidance?: string
  id: string
  createdAt: string
  platforms: AutomationAccount['platform'][]
  posts: GeneratedPlatformMetadata[]
  source: AutomationSourceContext | null
  research: MetadataResearch
}

export interface AutomationContent {
  
  warningsAcknowledged?: boolean
  
  metadataErrorAcknowledged?: boolean
  id: string
  
  sourceClipPath?: string
  postingAttemptId?: string
  fileName: string
  title: string
  caption: string
  
  transcript: string | null
  generatedMetadata: GeneratedPlatformMetadata[] | null
  metadataError?: string | null
  sourceContext?: AutomationSourceContext | null
  
  metadataDraft?: MetadataEnhancement | null
  metadataEnhancement?: MetadataEnhancement | null
  tiktokApproval?: AutomationTikTokApproval | null
  
  tiktokDraftCaption?: string | null
  status: AutomationContentStatus
  addedAt: string
  postedAt: string | null
  postId: string | null
  error: string | null
}

export interface AutomationSourceGroup {
  sourceType: 'linked' | 'file'
  key: string
  title: string
  contentIds: string[]
}

export interface AutomationBatchResult {
  automations: Automation[]
  completed: number
  skipped: number
  errors: { contentId: string; message: string }[]
}

export interface AutomationReviewResult {
  automations: Automation[]
  outcome: 'queued' | 'submitted' | 'held'
  message: string
}

export interface Automation {
  sourceResearch?: { key: string; createdAt: string; source: AutomationSourceContext; research: MetadataResearch }[]
  id: string
  name: string
  enabled: boolean
  
  profileId: string | null
  
  metadataMode: 'ai' | 'manual'
  accounts: AutomationAccount[]
  
  times: string[]
  timezone: string
  youtubeVisibility: YouTubeVisibility
  youtubeMadeForKids: boolean
  
  lastSlots: Record<string, string>
  content: AutomationContent[]
  createdAt: string
  lastRunAt: string | null
  lastError: string | null
  lastErrorAcknowledged?: boolean
}

export function hasContentWarnings(item: AutomationContent): boolean {
  return !item.warningsAcknowledged && Boolean(item.error || (item.metadataError && !item.metadataErrorAcknowledged) || item.status === 'needs_review')
}

export function hasAutomationWarnings(automation: Automation): boolean {
  return Boolean(automation.lastError && !automation.lastErrorAcknowledged) || automation.content.some(hasContentWarnings)
}

export interface AutomationUpdate {
  name: string
  enabled: boolean
  profileId: string | null
  metadataMode: 'ai' | 'manual'
  accounts: AutomationAccount[]
  times: string[]
  timezone: string
  youtubeVisibility: YouTubeVisibility
  youtubeMadeForKids: boolean
}

export function needsTikTokReview(automation: Pick<Automation, 'accounts'>, item: AutomationContent): boolean {
  const targets = automation.accounts.filter((account) => account.platform === 'tiktok')
  return targets.length > 0 && (!item.tiktokApproval?.options.consent ||
    targets.some((target) => !item.tiktokApproval?.options.accounts[target.accountId]?.privacyLevel))
}

export function nextAutomationContent(automation: Pick<Automation, 'accounts' | 'content'>): AutomationContent | undefined {
  
  const ready = automation.content.filter((item) => item.status === 'queued' && !item.metadataDraft && !needsTikTokReview(automation, item))
  
  return ready.find((item) => !item.error) ?? ready[0]
}

export function canReorderContent(item: AutomationContent): boolean {
  return item.status === 'queued' && !item.postId
}

export function hasEnhancedMetadata(item: AutomationContent, platforms: readonly AutomationAccount['platform'][]): boolean {
  return Boolean(item.metadataEnhancement && platforms.every((platform) => item.generatedMetadata?.some((post) => post.platform === platform)))
}

export function reorderQueuedContent(content: AutomationContent[], id: string, beforeId: string | null): AutomationContent[] {
  const queue = content.filter(canReorderContent)
  const from = queue.findIndex((item) => item.id === id)
  if (from < 0 || (beforeId !== null && !queue.some((item) => item.id === beforeId))) throw new Error('Only unposted queued clips can be reordered. Refresh the queue and try again.')
  if (id === beforeId) return content
  const [item] = queue.splice(from, 1)
  queue.splice(beforeId === null ? queue.length : queue.findIndex((entry) => entry.id === beforeId), 0, item)
  let index = 0
  return content.map((entry) => canReorderContent(entry) ? queue[index++] : entry)
}

export function dueSlots(times: readonly string[], timezone: string, now: number, graceMinutes = 5): { time: string; date: string }[] {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23'
  })
  const wanted = new Set(times)
  const found = new Set<string>()
  const slots: { time: string; date: string }[] = []
  for (let minutesAgo = graceMinutes - 1; minutesAgo >= 0; minutesAgo--) {
    const parts = Object.fromEntries(formatter.formatToParts(now - minutesAgo * 60_000).map((part) => [part.type, part.value]))
    const time = `${parts.hour}:${parts.minute}`
    const date = `${parts.year}-${parts.month}-${parts.day}`
    const key = `${date}/${time}`
    if (wanted.has(time) && !found.has(key)) { found.add(key); slots.push({ time, date }) }
  }
  return slots
}
