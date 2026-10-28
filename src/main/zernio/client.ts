import { isZernioId, isZernioPlatform, type ZernioAccount, type ZernioPlatform, type ZernioProfile } from '../../shared/zernio'
import { isIP } from 'net'
import { readResponseText } from '../http-response'
import { assertPublicWebUrl, isPublicAddress } from '../network-policy'
import { randomUUID } from 'crypto'
import { logger } from '../logger'

const BASE_URL = 'https://zernio.com/api/v1'
const REQUEST_TIMEOUT_MS = 30_000
const MAX_RATE_LIMIT_WAIT_S = 3600

type JsonRecord = Record<string, unknown>

export class ZernioApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
    readonly retryAfterSeconds: number | null = null,
    readonly rateLimitScope: 'api' | 'request' | null = null
  ) {
    super(message)
  }
}

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {}
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

function extractCollection(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  const record = asRecord(value)
  for (const key of ['profiles', 'accounts', 'data', 'items']) {
    if (Array.isArray(record[key])) return record[key] as unknown[]
  }
  return []
}

function unwrap(value: unknown, key: string): JsonRecord {
  const record = asRecord(value)
  const inner = asRecord(record[key])
  return Object.keys(inner).length > 0 ? inner : record
}

export function sanitizeProviderText(value: unknown, max = 160): string | undefined {
  if (typeof value !== 'string') return undefined
  let text = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[link]')
    .replace(/\bwww\.\S+/gi, '[link]')
    .replace(/\b(?:bearer|basic)\s+\S+/gi, '[redacted]')
    .replace(/\b(?:sk|pk|rk|zrk|key|token|secret)[_-][A-Za-z0-9_-]{6,}/gi, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*){0,2}/g, '[redacted]')
    .replace(/[A-Za-z0-9+/_=-]{24,}/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length > max) text = `${text.slice(0, max - 1).trimEnd()}…`
  return text || undefined
}

export function cleanHandle(value: unknown, max = 120): string | null {
  if (typeof value !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim().replace(/^@+/, '').slice(0, max).trim()
  return text || null
}

function stableCode(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{1,63}$/.test(value) ? value : null
}

function clampWait(seconds: number): number {
  return Math.min(Math.max(1, Math.ceil(seconds)), MAX_RATE_LIMIT_WAIT_S)
}

function retryAfterSeconds(headers: Headers | string | null, body: JsonRecord, apiWindow = true): number | null {
  const wait = (seconds: number): number => apiWindow ? clampWait(seconds) : Math.min(Math.max(1, Math.ceil(seconds)), 7 * 86400)
  const retryAfter = typeof headers === 'string' || headers === null ? headers : headers.get('retry-after')
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return wait(seconds)
    const date = Date.parse(retryAfter)
    if (Number.isFinite(date)) return wait((date - Date.now()) / 1000)
  }
  const fromBody = Number(asRecord(body.details).retryAfterSeconds)
  if (Number.isFinite(fromBody) && fromBody > 0) return wait(fromBody)
  if (!apiWindow) return null
  const reset = headers && typeof headers !== 'string' ? Number(headers.get('x-ratelimit-reset')) : NaN
  if (Number.isFinite(reset) && reset * 1000 > Date.now()) return clampWait(reset - Date.now() / 1000)
  return null
}

function waitText(seconds: number | null): string {
  if (!seconds) return 'a minute'
  if (seconds >= 3600) return `${Math.ceil(seconds / 3600)} hr`
  return seconds < 90 ? `${seconds}s` : `${Math.ceil(seconds / 60)} min`
}

export function paymentMessage(reason: string | null | undefined): string {
  switch (reason) {
    case 'free_tier_exceeded':
      return "Your Zernio workspace has used its free connected accounts. Add a payment method on Zernio's billing page to connect more."
    case 'twitter_passthrough':
      return "Zernio needs a payment method on file before it can connect X, because X charges for every API call. Add one on Zernio's billing page."
    case 'card_verification_required':
      return "Zernio needs to verify your card before it can continue. Finish the verification on Zernio's billing page."
    case 'enterprise_required':
      return "Your Zernio contract's connected-account limit is reached. Contact Zernio to raise it."
    default:
      return 'Zernio needs a payment method for this. Check the billing page in your Zernio dashboard.'
  }
}

let rateLimitedUntil = 0

function rateLimitError(seconds: number | null): ZernioApiError {
  return new ZernioApiError(`Zernio's API request limit was reached. Try again in ${waitText(seconds)}.`, 429, 'rate_limited', seconds, 'api')
}

function isApiRateLimit(body: JsonRecord, headers: Headers | string | null): boolean {
  if (body.type || body.code || body.platform) return false
  const remaining = headers && typeof headers !== 'string' ? headers.get('x-ratelimit-remaining') : null
  if (remaining !== null && remaining.trim() !== '' && Number.isFinite(Number(remaining))) return Number(remaining) <= 0
  return true
}

export function throwIfRateLimited(): void {
  const waitMs = rateLimitedUntil - Date.now()
  if (waitMs > 0) throw rateLimitError(clampWait(waitMs / 1000))
}

export function resetRateLimit(): void {
  rateLimitedUntil = 0
}

export function noteRateLimit(headers: Headers): void {
  if (headers.get('x-ratelimit-remaining') !== '0') return
  const reset = Number(headers.get('x-ratelimit-reset'))
  if (Number.isFinite(reset) && reset * 1000 > Date.now()) {
    rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + clampWait(reset - Date.now() / 1000) * 1000)
  }
}

function errorFor(status: number, body: JsonRecord, headers: Headers | string | null): ZernioApiError {
  const code = stableCode(body.code)
  if (status === 429) {
    const apiWindow = isApiRateLimit(body, headers)
    const seconds = retryAfterSeconds(headers, body, apiWindow)
    const detail = sanitizeProviderText(body.error ?? body.message, 500)
    if (apiWindow) rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + (seconds ?? 60) * 1000)
    else if (headers && typeof headers !== 'string') noteRateLimit(headers)
    if (!detail && apiWindow) return rateLimitError(seconds)
    const message = detail ? `Zernio: ${detail}` : 'Zernio temporarily limited this request.'
    return new ZernioApiError(`${message}${seconds ? ` Retry after at least ${waitText(seconds)}.` : ''}`, status, code ?? 'rate_limited', seconds, apiWindow ? 'api' : 'request')
  }
  if (status === 401) return new ZernioApiError('Zernio rejected your API key. Check the key in Settings.', status, code ?? 'invalid_credentials')
  if (status === 402) return new ZernioApiError(paymentMessage(str(body.reason)), status, code ?? 'PAYMENT_REQUIRED')
  if (status === 403) {
    if (/this api key does not have access to this profile/i.test(String(body.error ?? body.message ?? '')) || code === 'profile_access_denied') {
      return new ZernioApiError("This Zernio API key cannot access this profile. In Zernio's API keys, use a key with access to this profile, or Full access for new profiles, and Read & Write permission. Update the key in myClipper Settings.", status, 'profile_access_denied')
    }
    if (code === 'PLATFORM_BETA_RESTRICTED') return new ZernioApiError("This platform is in a closed beta on Zernio and isn't enabled for your workspace yet.", status, code)
    if (code === 'PLATFORM_DISABLED') return new ZernioApiError('Zernio has temporarily disabled this platform. Try again later.', status, code)
    if (code === 'PROFILE_OVER_LIMIT') return new ZernioApiError("This Zernio profile is over your plan's limit. Pick another profile or upgrade in Zernio.", status, code)
    if (code === 'ACCOUNT_DISCONNECTED') return new ZernioApiError('That account needs to sign in again. Reconnect it on the Accounts page.', status, code)
    if (code === 'insufficient_permissions') return new ZernioApiError("This Zernio API key isn't allowed to do that. Check its profile access, Read & Write permission, and enabled resources in Zernio, then update the key in myClipper Settings.", status, code)
  }
  if (status === 400 && code === 'INVALID_REDIRECT_URL') {
    return new ZernioApiError("Zernio didn't accept myClipper's local sign-in return address. Please report this issue.", status, code)
  }
  if (status === 409 && code === 'ads_connection_required') {
    return new ZernioApiError('That account needs to sign in again. Reconnect it on the Accounts page.', status, code)
  }
  if (status === 503) {
    const seconds = retryAfterSeconds(headers, body)
    return new ZernioApiError(`Zernio is temporarily unavailable. Try again in ${waitText(seconds)}.`, status, code, seconds)
  }
  if (status >= 500) return new ZernioApiError(`Zernio had a problem on its side (HTTP ${status}). Try again in a minute.`, status, code)
  const zernioText = sanitizeProviderText(body.error ?? body.message)
  if (status === 404) return new ZernioApiError(zernioText ? `Zernio couldn't find that: ${zernioText}` : "Zernio couldn't find that. Refresh and try again.", status, code)
  const detail = zernioText ? `: ${zernioText}` : ` (HTTP ${status}${code ? `, ${code}` : ''}).`
  return new ZernioApiError(`Zernio couldn't complete the request${detail}`, status, code)
}

const CONNECT_HOSTS: Record<ZernioPlatform, readonly string[]> = {
  tiktok: ['www.tiktok.com', 'tiktok.com', 'business-api.tiktok.com'],
  youtube: ['accounts.google.com'],
  instagram: ['www.instagram.com', 'instagram.com', 'api.instagram.com', 'www.facebook.com', 'facebook.com'],
  facebook: ['www.facebook.com', 'facebook.com'],
  twitter: ['x.com', 'twitter.com', 'api.x.com', 'api.twitter.com'],
  linkedin: ['www.linkedin.com', 'linkedin.com'],
  threads: ['threads.net', 'www.threads.net', 'threads.com', 'www.threads.com', 'www.instagram.com', 'instagram.com']
}
const ZERNIO_CONNECT_HOSTS = new Set(['zernio.com', 'app.zernio.com', 'connect.zernio.com'])

export function isTrustedConnectUrl(value: string, platform: ZernioPlatform): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || (url.port !== '' && url.port !== '443') || url.username || url.password) return false
    const host = url.hostname
    return ZERNIO_CONNECT_HOSTS.has(host) || (CONNECT_HOSTS[platform] ?? []).includes(host)
  } catch { return false }
}

export function connectUrlHost(value: string): string {
  try {
    return new URL(value).hostname.slice(0, 80) || 'unknown'
  } catch { return 'an invalid link' }
}

export type ZernioConnectStartResult =
  | { kind: 'redirect'; authUrl: string }
  | { kind: 'connected'; accountId: string | null; username: string | null }

const ACCOUNTS_PAGE_SIZE = 100
const PROFILES_PAGE_SIZE = 100
const MAX_LIST_PAGES = 50

function parseProfile(item: unknown): ZernioProfile | null {
  const profile = asRecord(item)
  const id = str(profile._id) ?? str(profile.id)
  if (!isZernioId(id)) return null
  return {
    id,
    name: cleanHandle(profile.name, 80) ?? 'Untitled profile',
    ...(profile.isDefault === true ? { isDefault: true } : {}),
    ...(profile.isOverLimit === true ? { isOverLimit: true } : {})
  }
}

function parseAccount(item: unknown): ZernioAccount | null {
  const account = asRecord(item)
  const id = str(account._id) ?? str(account.id)
  const platform = str(account.platform)?.toLowerCase().slice(0, 40) ?? ''
  if (!isZernioId(id) || !/^[a-z][a-z0-9_-]*$/.test(platform)) return null
  const rawProfile = account.profileId
  return {
    id,
    platform,
    username: cleanHandle(account.username),
    displayName: cleanHandle(account.displayName),
    profileId: (typeof rawProfile === 'object' ? str(asRecord(rawProfile)._id) : str(rawProfile)) ?? null,
    isActive: account.isActive !== false,
    health: null,
    needsReconnect: account.needsReconnection === true,
    issue: null,
    canPost: null
  }
}

function profileError(error: unknown, name: string): unknown {
  if (!(error instanceof ZernioApiError)) return error
  if (error.status === 409) {
    return new ZernioApiError(`A Zernio profile named “${cleanHandle(name, 80) ?? name}” already exists. Pick another name.`, 409, error.code ?? 'profile_name_conflict')
  }
  if (error.status === 403 && (error.code === 'profile_limit_exceeded' || (!error.code && /profile limit|maximum number of profiles/i.test(error.message)))) {
    return new ZernioApiError("Your Zernio plan's profile limit is reached. Delete an unused profile, or switch to usage-based billing in Zernio (it has no profile limit).", 403, 'profile_limit')
  }
  return error
}

export class ZernioClient {
  readonly traceId = randomUUID()
  constructor(private readonly apiKey: string, private readonly baseUrl: string = BASE_URL) {}

  private async request(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
    const startedAt = Date.now()
    const labels = new Set(['profiles', 'accounts', 'connect', 'health', 'tiktok', 'youtube', 'instagram', 'facebook', 'twitter', 'linkedin', 'threads'])
    const operation = path.split('?')[0].split('/').filter(Boolean).map((part) => labels.has(part) ? part : 'item').join('.')
    const context = { traceId: this.traceId, requestId: randomUUID(), method, operation }
    logger.info('zernio.request.start', context)
    try { throwIfRateLimited() } catch (error) {
      logger.warn('zernio.request.blocked', { ...context, status: 429 })
      throw error
    }
    let response: Response
    let raw: string
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
      raw = await readResponseText(response, 2 * 1024 * 1024)
    } catch {
      logger.warn('zernio.request.failed', { ...context, status: 0, category: 'network', durationMs: Date.now() - startedAt })
      throw new ZernioApiError('Could not reach Zernio. Check your internet connection and try again.', 0, 'network_error')
    }
    if (response.status !== 429) noteRateLimit(response.headers)
    const parsed = raw ? safeJson(raw) : {}
    if (!response.ok) {
      const error = errorFor(response.status, asRecord(parsed), response.headers)
      const category = error.code === 'profile_access_denied' ? 'profile_access_denied'
        : error.code === 'insufficient_permissions' ? 'insufficient_permissions' : 'provider_failure'
      logger.warn('zernio.request.failed', { ...context, status: response.status, category, durationMs: Date.now() - startedAt })
      throw error
    }
    logger.info('zernio.request.completed', { ...context, status: response.status, durationMs: Date.now() - startedAt })
    return parsed
  }

  async listProfiles(): Promise<ZernioProfile[]> {
    const profiles: ZernioProfile[] = []
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const response = await this.request('GET', `/profiles?includeOverLimit=true&limit=${PROFILES_PAGE_SIZE}&skip=${page * PROFILES_PAGE_SIZE}`)
      const result = asRecord(response)
      const batch = extractCollection(response)
      for (const item of batch) {
        const profile = parseProfile(item)
        if (profile && !profiles.some((p) => p.id === profile.id)) profiles.push(profile)
      }
      const total = Number(result.total)
      if (batch.length < PROFILES_PAGE_SIZE || (Number.isFinite(total) && (page + 1) * PROFILES_PAGE_SIZE >= total)) break
    }
    return profiles
  }

  async createProfile(name: string): Promise<ZernioProfile> {
    try {
      const profile = parseProfile(unwrap(await this.request('POST', '/profiles', { name }), 'profile'))
      if (!profile) throw new ZernioApiError('Zernio did not return the new profile.', 502)
      return profile
    } catch (error) {
      throw profileError(error, name)
    }
  }

  async renameProfile(profileId: string, name: string): Promise<ZernioProfile> {
    try {
      const result = unwrap(await this.request('PUT', `/profiles/${encodeURIComponent(profileId)}`, { name }), 'profile')
      return parseProfile(result) ?? { id: profileId, name }
    } catch (error) {
      throw profileError(error, name)
    }
  }

  async deleteProfile(profileId: string): Promise<boolean> {
    try {
      await this.request('DELETE', `/profiles/${encodeURIComponent(profileId)}`)
      return true
    } catch (error) {
      if (error instanceof ZernioApiError && error.status === 404) return false
      if (error instanceof ZernioApiError && error.status === 400) {
        throw new ZernioApiError('This profile still has connected accounts. Disconnect them first, then delete the profile.', 400, error.code ?? 'profile_has_accounts')
      }
      throw error
    }
  }

  async listAccounts(filter: { profileId?: string; platform?: string } = {}): Promise<ZernioAccount[]> {
    const accounts: ZernioAccount[] = []
    for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
      const params = new URLSearchParams({ includeOverLimit: 'true', page: String(page), limit: String(ACCOUNTS_PAGE_SIZE) })
      if (filter.profileId) params.set('profileId', filter.profileId)
      if (filter.platform) params.set('platform', filter.platform)
      const response = await this.request('GET', `/accounts?${params}`)
      const result = asRecord(response)
      const batch = extractCollection(response)
      for (const item of batch) {
        const account = parseAccount(item)
        if (account && !accounts.some((a) => a.id === account.id)) accounts.push(account)
      }
      const pages = Number(asRecord(result.pagination).pages)
      if (!Number.isFinite(pages) || page >= pages || batch.length === 0) break
    }
    return accounts
  }

  async getAccountsHealth(): Promise<Map<string, Pick<ZernioAccount, 'health' | 'needsReconnect' | 'issue' | 'canPost'>>> {
    const result = await this.request('GET', '/accounts/health')
    const health = new Map<string, Pick<ZernioAccount, 'health' | 'needsReconnect' | 'issue' | 'canPost'>>()
    for (const item of extractCollection(result)) {
      const row = asRecord(item)
      const id = str(row.accountId) ?? str(row.id) ?? str(row._id)
      if (!id) continue
      const status = str(row.status)
      const issues = Array.isArray(row.issues) ? row.issues.filter((issue): issue is string => typeof issue === 'string') : []
      health.set(id, {
        health: status === 'healthy' || status === 'warning' || status === 'error' ? status : null,
        needsReconnect: row.needsReconnect === true,
        issue: sanitizeProviderText(issues[0], 120) ?? null,
        canPost: typeof row.canPost === 'boolean' ? row.canPost : null
      })
    }
    return health
  }

  async getTikTokIntegrationLane(accountId: string): Promise<ZernioAccount['integrationLane']> {
    if (!isZernioId(accountId)) throw new Error('Invalid TikTok account')
    const row = unwrap(await this.request('GET', `/accounts/${encodeURIComponent(accountId)}/health`), 'health')
    return row.integrationLane === 'business' || row.integrationLane === 'developer' ? row.integrationLane : null
  }

  async startConnect(platform: ZernioPlatform, profileId: string, redirectUrl: string, options: { force?: boolean } = {}): Promise<ZernioConnectStartResult> {
    const params = new URLSearchParams({ profileId, redirect_url: redirectUrl })
    if (options.force) params.set('force', 'true')
    const result = asRecord(await this.request('GET', `/connect/${encodeURIComponent(platform)}?${params}`))
    const authUrl = str(result.authUrl)
    if (authUrl) return { kind: 'redirect', authUrl }

    const account = asRecord(result.account)
    const accountId = [result.accountId, account.accountId, account._id, account.id].find(isZernioId) ?? null
    if (result.alreadyConnected === true || accountId) {
      return { kind: 'connected', accountId, username: cleanHandle(result.username) ?? cleanHandle(account.username) }
    }
    throw new ZernioApiError("Zernio didn't return a sign-in link for this platform. Try again in a moment.", 502)
  }

  async deleteAccount(accountId: string): Promise<boolean> {
    try {
      await this.request('DELETE', `/accounts/${encodeURIComponent(accountId)}`)
      return true
    } catch (error) {
      if (error instanceof ZernioApiError && error.status === 404) return false
      throw error
    }
  }

  private async postingRequest(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    options: { body?: unknown; requestId?: string; timeoutMs?: number } = {}
  ): Promise<{ status: number; body: JsonRecord }> {
    const startedAt = Date.now()
    const labels = new Set(['posts', 'retry', 'media', 'presign', 'accounts', 'tiktok', 'creator-info'])
    const operation = path.split('?')[0].split('/').filter(Boolean).map((part) => labels.has(part) ? part : 'item').join('.')
    const context = { traceId: this.traceId, requestId: randomUUID(), method, operation }
    logger.info('zernio.post.request.start', context)
    try { throwIfRateLimited() } catch (error) {
      logger.warn('zernio.post.request.blocked', { ...context, status: 429, scope: 'api' })
      throw error
    }
    let response: Response
    let raw: string
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'application/json',
          ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(options.requestId ? { 'x-request-id': options.requestId } : {})
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS)
      })
      raw = await readResponseText(response, 2 * 1024 * 1024)
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError'
      logger.warn('zernio.post.request.failed', { ...context, status: 0, category: timedOut ? 'timeout' : 'network', durationMs: Date.now() - startedAt })
      throw timedOut
        ? new ZernioApiError('Zernio took too long to answer.', 0, 'timeout')
        : new ZernioApiError('Could not reach Zernio. Check your internet connection and try again.', 0, 'network_error')
    }
    if (response.status !== 429) noteRateLimit(response.headers)
    const body = asRecord(raw ? safeJson(raw) : {})
    if (response.ok) {
      logger.info('zernio.post.request.completed', { ...context, status: response.status, durationMs: Date.now() - startedAt })
      return { status: response.status, body }
    }
    if (response.status === 409 && method === 'POST' && path === '/posts') {
      const details = asRecord(body.details)
      const explicitDuplicate = body.code === 'duplicate_post' ||
        (isZernioId(details.existingPostId) && isZernioId(details.accountId) && isZernioPlatform(details.platform))
      if (explicitDuplicate) {
        throw new ZernioDuplicatePostError(
          sanitizeProviderText(body.error, 300) ?? 'Zernio already has this exact post for one of these accounts from the last 24 hours.',
          [details.existingPostId, body.existingPostId].find(isZernioId) ?? null,
          str(details.platform) ?? str(body.platform) ?? null
        )
      }
    }
    const error = errorFor(response.status, body, response.headers)
    const remaining = response.headers.get('x-ratelimit-remaining')
    logger.warn('zernio.post.request.failed', { ...context, status: response.status, scope: error.rateLimitScope,
      retryAfterSeconds: error.retryAfterSeconds, remaining: remaining !== null && Number.isFinite(Number(remaining)) ? Number(remaining) : null,
      durationMs: Date.now() - startedAt })
    throw error
  }

  async presignMedia(filename: string, contentType: string, size: number): Promise<{ uploadUrl: string; publicUrl: string }> {
    const { body } = await this.postingRequest('POST', '/media/presign', { body: { filename, contentType, size } })
    const uploadUrl = str(body.uploadUrl)
    const publicUrl = str(body.publicUrl)
    const allowLoopback = this.baseUrl !== BASE_URL && isLoopbackHttp(this.baseUrl)
    if (!uploadUrl || !isUploadUrl(uploadUrl, allowLoopback) || !publicUrl || !isUploadUrl(publicUrl, allowLoopback)) {
      throw new ZernioApiError('Zernio did not return a secure upload link.', 502)
    }
    if (!allowLoopback) {
      try {
        await Promise.all([assertPublicWebUrl(uploadUrl), assertPublicWebUrl(publicUrl)])
      } catch {
        throw new ZernioApiError('Zernio did not return a public upload link.', 502)
      }
    }
    return { uploadUrl, publicUrl }
  }

  async createPost(payload: JsonRecord, requestId: string, timeoutMs: number): Promise<CreatedPost> {
    const { status, body } = await this.postingRequest('POST', '/posts', { body: payload, requestId, timeoutMs })
    const existing = asRecord(body.existingPost)
    const replayed = Object.keys(existing).length > 0
    return {
      httpStatus: status,
      replayed,
      post: replayed ? existing : asRecord(body.post),
      platformResults: Array.isArray(body.platformResults) ? body.platformResults.map(asRecord) : [],
      error: sanitizeProviderText(body.error, 300) ?? null,
      warnings: Array.isArray(body.warnings) ? body.warnings.map((w) => sanitizeProviderText(w, 300)).filter((w): w is string => Boolean(w)) : []
    }
  }

  async getPost(postId: string): Promise<JsonRecord> {
    return unwrap((await this.postingRequest('GET', `/posts/${encodeURIComponent(postId)}`)).body, 'post')
  }

  async updatePost(postId: string, payload: JsonRecord): Promise<JsonRecord> {
    return unwrap((await this.postingRequest('PUT', `/posts/${encodeURIComponent(postId)}`, { body: payload })).body, 'post')
  }

  async deletePost(postId: string): Promise<void> {
    await this.postingRequest('DELETE', `/posts/${encodeURIComponent(postId)}`)
  }

  async retryPost(postId: string, timeoutMs: number): Promise<{ post: JsonRecord; error: string | null }> {
    const { body } = await this.postingRequest('POST', `/posts/${encodeURIComponent(postId)}/retry`, { timeoutMs })
    return { post: asRecord(body.post), error: sanitizeProviderText(body.error, 300) ?? null }
  }

  async getTikTokCreatorInfo(accountId: string): Promise<JsonRecord> {
    return (await this.postingRequest('GET', `/accounts/${encodeURIComponent(accountId)}/tiktok/creator-info?mediaType=video`)).body
  }
}

export interface CreatedPost {
  httpStatus: number
  replayed: boolean
  post: JsonRecord
  platformResults: JsonRecord[]
  error: string | null
  warnings: string[]
}

export class ZernioDuplicatePostError extends ZernioApiError {
  constructor(message: string, readonly existingPostId: string | null, readonly platform: string | null) {
    super(message, 409, 'duplicate_post')
  }
}

function isLoopbackHttp(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  } catch { return false }
}

export function isUploadUrl(value: string, allowLoopback = false): boolean {
  try {
    const url = new URL(value)
    if (url.username || url.password) return false
    if (!allowLoopback && url.port !== '' && url.port !== '443') return false
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (!allowLoopback && (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      (isIP(host) !== 0 && !isPublicAddress(host)))) return false
    return url.protocol === 'https:' || (allowLoopback && isLoopbackHttp(value))
  } catch { return false }
}
