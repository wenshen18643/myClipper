
export type UpdatesOffReason =
  | 'development'
  | 'unofficial'
  | 'move-to-applications'
  | 'disabled'

export interface UpdateProgress {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

type Base = {
  currentVersion: string
  lastCheckedAt: string | null
}

export type UpdateState = Base & (
  | { status: 'off'; reason: UpdatesOffReason }
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'up-to-date' }
  | { status: 'downloading'; version: string; progress: UpdateProgress | null }
  | { status: 'ready'; version: string }
  | { status: 'error'; message: string }
)

export type UpdateStatus = UpdateState['status']

export const UPDATE_CHECK_DELAY_MS = 15_000
export const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

export function updateErrorMessage(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : ''
  const message = error instanceof Error ? error.message : ''
  if (/^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH)$/.test(code) ||
      /net::ERR_(INTERNET_DISCONNECTED|NETWORK_CHANGED|NAME_NOT_RESOLVED|CONNECTION_\w+|TIMED_OUT|ADDRESS_UNREACHABLE|PROXY_CONNECTION_FAILED)/.test(message)) {
    return 'Could not reach GitHub. Check your connection and try again.'
  }
  if (code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' || code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' || code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS') {
    return 'No release for this platform yet.'
  }
  if (code === 'ENOSPC') return 'Not enough disk space to download the update.'
  if (code === 'ERR_CHECKSUM_MISMATCH' || code === 'ERR_UPDATER_INVALID_SIGNATURE') {
    return 'The downloaded update failed verification and was discarded.'
  }
  return 'Could not check for or download the update. Try again later.'
}
