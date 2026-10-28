
export const ZERNIO_PLATFORMS = ['tiktok', 'youtube', 'instagram', 'facebook', 'twitter', 'linkedin', 'threads'] as const
export type ZernioPlatform = (typeof ZERNIO_PLATFORMS)[number]

export const ZERNIO_PLATFORM_NAMES: Record<ZernioPlatform, string> = {
  tiktok: 'TikTok',
  youtube: 'YouTube',
  instagram: 'Instagram',
  facebook: 'Facebook',
  twitter: 'X',
  linkedin: 'LinkedIn',
  threads: 'Threads'
}

export function isZernioPlatform(value: unknown): value is ZernioPlatform {
  return typeof value === 'string' && (ZERNIO_PLATFORMS as readonly string[]).includes(value)
}

export function isZernioId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
}

export interface ZernioProfile {
  id: string
  name: string
  isDefault?: boolean
  isOverLimit?: boolean
}

export const ZERNIO_PROFILE_NAME_MAX = 80

export function isValidProfileName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= ZERNIO_PROFILE_NAME_MAX &&
    !Array.from(value).some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)
}

export interface ZernioAccount {
  id: string
  platform: string
  username: string | null
  displayName: string | null
  profileId: string | null
  isActive: boolean
  health: 'healthy' | 'warning' | 'error' | null
  needsReconnect: boolean
  issue: string | null
  canPost?: boolean | null
  integrationLane?: 'business' | 'developer' | null
  overLimit?: boolean
}

export interface ZernioOverview {
  profiles: ZernioProfile[]
  accounts: ZernioAccount[]
  syncedAt?: number
}

export interface ZernioStatusCheck {
  checkedAt: number
  accounts: (Pick<ZernioAccount, 'health' | 'needsReconnect' | 'issue' | 'canPost'> & { accountId: string })[]
}

export interface ZernioConnectResult {
  platform: string
  success: boolean
  username?: string
  error?: string
  accountId?: string
  billing?: boolean
  ended?: 'timeout' | 'unknown'
}

export function isPostableAccount(account: ZernioAccount): boolean {
  return account.isActive && !account.needsReconnect && account.canPost !== false && !account.overLimit
}

export type ZernioErrorKind = 'auth' | 'offline' | 'rate_limit' | 'payment' | 'not_found' | 'other'

export interface ZernioErrorInfo {
  message: string
  kind: ZernioErrorKind
  billing?: boolean
  retryAfterSeconds?: number
}

export interface ZernioSyncResult {
  overview: ZernioOverview | null
  stale: boolean
  error: ZernioErrorInfo | null
}

export interface ZernioConnectOptions {
  reconnect?: boolean
  newProfileName?: string
}

export type ZernioConnectStart =
  | { status: 'pending'; platform: ZernioPlatform; profileId: string; createdProfile?: ZernioProfile }
  | { status: 'connected'; platform: ZernioPlatform; profileId: string; accountId: string | null; username: string | null; createdProfile?: ZernioProfile }
  | { status: 'failed'; platform: ZernioPlatform; profileId: string | null; error: ZernioErrorInfo; createdProfile?: ZernioProfile }

export interface ZernioPendingConnect {
  platform: ZernioPlatform
  profileId: string
  reconnect: boolean
  startedAt: number
  createdProfile?: boolean
}
