
import type { ZernioPlatform } from './zernio'

export interface ClipMediaInfo {
  durationMs: number | null
  width: number | null
  height: number | null
  sizeBytes: number
}

export interface PlatformRules {
  captionMax: number
  
  captionStrict: boolean
  minSec: number
  maxSec: number | null
  maxBytes: number | null
}

const MB = 1024 * 1024

export const PRESIGN_MAX_BYTES = 5 * 1024 * MB

export const PLATFORM_RULES: Record<ZernioPlatform, PlatformRules> = {
  
  tiktok: { captionMax: 2200, captionStrict: true, minSec: 3, maxSec: 600, maxBytes: 4096 * MB },
  
  youtube: { captionMax: 5000, captionStrict: true, minSec: 1, maxSec: 12 * 3600, maxBytes: null },
  
  instagram: { captionMax: 2200, captionStrict: true, minSec: 3, maxSec: 90, maxBytes: null },
  
  facebook: { captionMax: 63206, captionStrict: true, minSec: 1, maxSec: 240 * 60, maxBytes: 4096 * MB },
  
  twitter: { captionMax: 280, captionStrict: false, minSec: 0.5, maxSec: null, maxBytes: 512 * MB },
  
  linkedin: { captionMax: 3000, captionStrict: true, minSec: 3, maxSec: 30 * 60, maxBytes: 5120 * MB },
  threads: { captionMax: 500, captionStrict: true, minSec: 0, maxSec: 5 * 60, maxBytes: 1024 * MB }
}

export const FACEBOOK_REEL = { minSec: 3, maxSec: 60 }

export const YOUTUBE_SHORT_MAX_SEC = 180
export const YOUTUBE_UNVERIFIED_MAX_SEC = 15 * 60
export const YOUTUBE_TITLE_MAX = 100
export const LINKEDIN_PERSONAL_MAX_SEC = 10 * 60

export const SCHEDULE_MIN_LEAD_MS = 5 * 60_000

export const UPLOAD_RETENTION_MS = 7 * 86_400_000

export const SCHEDULE_SAFETY_MARGIN_MS = 12 * 3_600_000

export function scheduleWindow(now: number, uploadedAt: number = now): { min: number; max: number } {
  return { min: now + SCHEDULE_MIN_LEAD_MS, max: uploadedAt + UPLOAD_RETENTION_MS - SCHEDULE_SAFETY_MARGIN_MS }
}

export function scheduleError(at: number, now: number, uploadedAt: number = now, graceMs = 0): string | null {
  if (!Number.isFinite(at)) return 'Choose a date and time.'
  const { min, max } = scheduleWindow(now, uploadedAt)
  if (at < min - graceMs) return 'Pick a time at least 5 minutes from now.'
  if (at > max) {
    return uploadedAt < now
      ? 'Zernio keeps this upload for 7 days, so pick an earlier time or post the clip again.'
      : 'Zernio keeps uploads for 7 days, so schedule at most 6½ days ahead.'
  }
  return null
}

export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(value)) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}

export function formatClipDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const m = Math.floor(total / 60)
  const s = total % 60
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

function platformLabel(platform: ZernioPlatform): string {
  return { tiktok: 'TikTok', youtube: 'YouTube', instagram: 'Instagram', facebook: 'Facebook', twitter: 'X', linkedin: 'LinkedIn', threads: 'Threads' }[platform]
}

export function isVertical(media: Pick<ClipMediaInfo, 'width' | 'height'>): boolean | null {
  return media.width && media.height ? media.height > media.width : null
}

export interface ClipCheckContext {
  
  tiktokMaxSec?: number | null
  facebookFormat?: FacebookFormat
}

export interface ClipCheck {
  
  blocking: string | null
  notes: string[]
}

export function checkClip(platform: ZernioPlatform, media: ClipMediaInfo, context: ClipCheckContext = {}): ClipCheck {
  const rules = PLATFORM_RULES[platform]
  const name = platformLabel(platform)
  const seconds = media.durationMs == null ? null : media.durationMs / 1000
  const vertical = isVertical(media)
  const notes: string[] = []

  let maxSec = rules.maxSec
  if (platform === 'tiktok' && context.tiktokMaxSec && context.tiktokMaxSec > 0) maxSec = Math.min(maxSec ?? Infinity, context.tiktokMaxSec)
  let minSec = rules.minSec
  if (platform === 'facebook' && context.facebookFormat === 'reel') {
    minSec = FACEBOOK_REEL.minSec
    maxSec = FACEBOOK_REEL.maxSec
    if (vertical === false) return { blocking: 'Facebook Reels need a vertical video. Post it to the feed instead.', notes }
  }

  if (media.sizeBytes > PRESIGN_MAX_BYTES) return { blocking: 'Zernio accepts uploads up to 5 GB.', notes }
  if (rules.maxBytes != null && media.sizeBytes > rules.maxBytes) {
    const size = rules.maxBytes >= 1024 * MB ? `${rules.maxBytes / (1024 * MB)} GB` : `${rules.maxBytes / MB} MB`
    return { blocking: `${name} accepts videos up to ${size}.`, notes }
  }
  if (seconds != null) {
    if (seconds < minSec) return { blocking: `${name} needs clips of at least ${minSec} seconds.`, notes }
    if (maxSec != null && seconds > maxSec + 0.5) {
      const what = platform === 'instagram' ? 'Instagram Reels' : platform === 'facebook' && context.facebookFormat === 'reel' ? 'Facebook Reels' : name
      const why = platform === 'tiktok' && maxSec < (rules.maxSec ?? Infinity) ? ' for this account' : ''
      return { blocking: `${what} can be at most ${formatClipDuration(maxSec)}${why}. This clip is ${formatClipDuration(seconds)}.`, notes }
    }
  }

  if (platform === 'youtube' && seconds != null) {
    notes.push(vertical !== false && seconds <= YOUTUBE_SHORT_MAX_SEC ? 'Posts as a Short.' : 'Posts as a regular video.')
    if (seconds > YOUTUBE_UNVERIFIED_MAX_SEC) notes.push('Channels need phone verification for videos over 15 minutes.')
  }
  if (platform === 'tiktok' && vertical === false) notes.push('TikTok works best with vertical 9:16 video.')
  if (platform === 'instagram' && vertical === false) notes.push('Reels are 9:16, so Instagram will letterbox this clip.')
  if (platform === 'linkedin' && seconds != null && seconds > LINKEDIN_PERSONAL_MAX_SEC) notes.push('Personal profiles allow up to 10 minutes; Pages allow 30.')
  return { blocking: null, notes }
}

export function defaultFacebookFormat(media: ClipMediaInfo): FacebookFormat {
  if (media.durationMs == null || media.width == null || media.height == null) return 'feed'
  return checkClip('facebook', media, { facebookFormat: 'reel' }).blocking ? 'feed' : 'reel'
}

export function captionLength(caption: string): number {
  return [...caption].length
}

export interface CaptionCheck {
  error: string | null
  warning: string | null
}

export function checkCaption(platform: ZernioPlatform, caption: string): CaptionCheck {
  const rules = PLATFORM_RULES[platform]
  const length = captionLength(caption)
  if (length <= rules.captionMax) return { error: null, warning: null }
  const text = `${platformLabel(platform)} allows ${rules.captionMax.toLocaleString('en-US')} characters.`
  return rules.captionStrict
    ? { error: text, warning: null }
    : { error: null, warning: `${text} Only X Premium accounts can post longer captions.` }
}

export function hashtagFor(tag: string): string | null {
  const words = tag.normalize('NFKC').split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  if (words.length === 0) return null
  const joined = words.length === 1 ? words[0] : words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('')
  return `#${joined.slice(0, 60)}`
}

export function defaultCaption(title: string, tags: string[], maxTags = 5): string {
  const seen = new Set<string>()
  const hashtags: string[] = []
  for (const tag of tags) {
    const hashtag = hashtagFor(tag)
    if (!hashtag || seen.has(hashtag.toLowerCase())) continue
    seen.add(hashtag.toLowerCase())
    hashtags.push(hashtag)
    if (hashtags.length === maxTags) break
  }
  return [title.trim(), hashtags.join(' ')].filter(Boolean).join('\n\n')
}

export function youtubeTitleFor(title: string): string {
  const cleaned = title.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim()
  const chars = [...cleaned]
  if (chars.length <= YOUTUBE_TITLE_MAX) return cleaned
  return `${chars.slice(0, YOUTUBE_TITLE_MAX - 1).join('').trimEnd()}…`
}

export interface TikTokCreatorInfo {
  accountId: string
  nickname: string | null
  
  canPostMore: boolean
  
  privacyLevels: { value: string; label: string }[]
  maxVideoDurationSec: number | null
  
  interactions: { comment: boolean; duet: boolean; stitch: boolean }
  
  commercialContentTypes: string[]
}

export const TIKTOK_PRIVACY_LABELS: Record<string, string> = {
  PUBLIC_TO_EVERYONE: 'Everyone',
  MUTUAL_FOLLOW_FRIENDS: 'Friends',
  FOLLOWER_OF_CREATOR: 'Followers',
  SELF_ONLY: 'Only me'
}

export function sharedCommercialTypes(infos: TikTokCreatorInfo[]): string[] {
  const [first, ...rest] = infos
  if (!first) return []
  return first.commercialContentTypes.filter((type) => rest.every((info) => info.commercialContentTypes.includes(type)))
}

export function tiktokAccountError(options: TikTokPostOptions, account: TikTokAccountOptions | undefined, info: TikTokCreatorInfo): string | null {
  const privacy = account?.privacyLevel ?? ''
  if (!privacy) return 'Choose who can view the TikTok post.'
  if (!info.privacyLevels.some((level) => level.value === privacy)) return 'That TikTok privacy option isn’t available for this account. Choose another.'
  if (options.disclose && options.brandedContent && privacy === 'SELF_ONLY') return 'Branded content can’t be private on TikTok. Choose another privacy option.'
  if (!options.draft && !info.canPostMore) return 'TikTok isn’t accepting more posts from this account right now. Try later, or send it to your TikTok inbox.'
  return null
}

export function tiktokOptionsError(options: TikTokPostOptions, infos: TikTokCreatorInfo[], label?: (accountId: string) => string): string | null {
  for (const info of infos) {
    const error = tiktokAccountError(options, options.accounts[info.accountId], info)
    if (error) return infos.length > 1 && label ? `${label(info.accountId)}: ${error}` : error
  }
  if (options.disclose && !options.yourBrand && !options.brandedContent) return 'Choose whether the TikTok post promotes your brand, a third party, or both.'
  if (options.disclose) {
    const requiredTypes = [options.yourBrand ? 'brand_organic' : null, options.brandedContent ? 'brand_content' : null].filter((type): type is string => type !== null)
    for (const info of infos) {
      
      if (info.commercialContentTypes.length === 0) continue
      if (requiredTypes.some((type) => !info.commercialContentTypes.includes(type))) {
        const message = 'This TikTok account does not offer the selected commercial content disclosure.'
        return infos.length > 1 && label ? `${label(info.accountId)}: ${message}` : message
      }
    }
  }
  if (!options.consent) return 'Agree to TikTok’s terms to post there.'
  return null
}

export function tiktokConsentText(brandedContent: boolean): string {
  return brandedContent
    ? "By posting, you agree to TikTok's Branded Content Policy and Music Usage Confirmation."
    : "By posting, you agree to TikTok's Music Usage Confirmation."
}

export const TIKTOK_LEGAL_LINKS = {
  musicUsage: 'https://www.tiktok.com/legal/page/global/music-usage-confirmation/en',
  brandedContent: 'https://www.tiktok.com/legal/page/global/bc-policy/en'
} as const
export type TikTokLegalLink = keyof typeof TIKTOK_LEGAL_LINKS

export type FacebookFormat = 'reel' | 'feed'
export type YouTubeVisibility = 'public' | 'unlisted' | 'private'

export interface TikTokAccountOptions {
  
  privacyLevel: string
  allowComment: boolean
  allowDuet: boolean
  allowStitch: boolean
}

export const EMPTY_TIKTOK_ACCOUNT: TikTokAccountOptions = { privacyLevel: '', allowComment: false, allowDuet: false, allowStitch: false }

export interface TikTokPostOptions {
  
  accounts: Record<string, TikTokAccountOptions>
  
  disclose: boolean
  yourBrand: boolean
  brandedContent: boolean
  madeWithAi: boolean
  
  draft: boolean
  
  consent: boolean
}

export interface YouTubePostOptions {
  title: string
  visibility: YouTubeVisibility
  madeForKids: boolean
  categoryId?: string
  tags?: string[]
}

export interface PostOptions {
  tiktok?: TikTokPostOptions
  youtube?: YouTubePostOptions
  instagram?: { shareToFeed: boolean }
  facebook?: { format: FacebookFormat; title?: string }
  threads?: { topicTag?: string }
}

export type PostTiming = { mode: 'now' } | { mode: 'schedule'; scheduledFor: string; timezone: string }

export interface PostTarget {
  platform: ZernioPlatform
  accountId: string
  
  customContent?: string
}

export interface PostClipRequest {
  
  attemptId: string
  clipPath: string
  clipTitle: string
  
  durationMs: number | null
  caption: string
  targets: PostTarget[]
  timing: PostTiming
  options: PostOptions
}

export interface PostProgress {
  attemptId: string
  phase: 'uploading' | 'publishing'
  transferred: number
  total: number
}

export type PostStatus = 'draft' | 'scheduled' | 'publishing' | 'published' | 'partial' | 'failed' | 'cancelled' | 'missing'
export type PostTargetStatus = 'pending' | 'processing' | 'uploading' | 'published' | 'failed' | 'cancelled'

export interface PostRecordTarget {
  platform: string
  accountId: string
  
  handle: string | null
  status: PostTargetStatus
  error: string | null
  url: string | null
  
  inbox: boolean
}

export interface PostRecord {
  
  automationRequeued?: boolean
  id: string
  clipPath: string
  clipTitle: string
  targets: PostRecordTarget[]
  scheduledFor: string | null
  timezone: string | null
  status: PostStatus
  error: string | null
  createdAt: string
  
  uploadedAt: string
  refreshedAt: string | null
}

export type PostOutcome = 'published' | 'scheduled' | 'partial' | 'failed' | 'retrying' | 'publishing' | 'duplicate'

export interface PostClipResult {
  post: PostRecord | null
  outcome: PostOutcome
  message: string
  warnings: string[]
}

export interface PostsRefreshResult {
  posts: PostRecord[]
  
  error: string | null
}

const ACTIVE: PostStatus[] = ['scheduled', 'publishing']
export function isPostActive(post: Pick<PostRecord, 'status'>): boolean {
  return ACTIVE.includes(post.status)
}
