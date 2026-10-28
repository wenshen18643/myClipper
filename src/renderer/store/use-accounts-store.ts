import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { getApi } from '../lib/ipc'
import { errorMessage } from '../lib/utils'
import { platformName } from '../components/PlatformIcon'
import {
  isPostableAccount,
  type ZernioAccount,
  type ZernioConnectResult,
  type ZernioErrorInfo,
  type ZernioOverview,
  type ZernioPlatform,
  type ZernioProfile,
  isValidProfileName
} from '../../shared/zernio'

const PROFILE_STORAGE_KEY = 'myclipper.zernio.profileId'
const FOCUS_REFRESH_MS = 60_000
const FOCUS_REFRESH_CONNECTING_MS = 8_000

interface Connecting {
  platform: ZernioPlatform
  reconnect: boolean
  profileId: string | null
  knownAccountIds: string[]
  flaggedAccountIds: string[]
}

export interface AccountsNotice {
  tone: 'success' | 'danger' | 'neutral'
  text: string
  action?: 'billing' | 'settings'
}

interface AccountsState {
  profiles: ZernioProfile[]
  accounts: ZernioAccount[]
  profileId: string | null
  syncedAt: number
  loaded: boolean
  loading: boolean
  error: ZernioErrorInfo | null
  lastAttemptAt: number
  connecting: Connecting | null
  disconnecting: string | null
  notice: AccountsNotice | null
  hydrate: () => Promise<void>
  load: () => Promise<void>
  refreshOnFocus: () => void
  setProfile: (profileId: string) => void
  createProfile: (name: string) => Promise<ZernioProfile>
  connect: (platform: ZernioPlatform, options?: { reconnect?: boolean; newProfileName?: string }) => Promise<void>
  cancelConnect: () => void
  disconnect: (accountId: string) => Promise<void>
  dismissNotice: () => void
}

function readSavedProfile(): string | null {
  try {
    return localStorage.getItem(PROFILE_STORAGE_KEY)
  } catch {
    return null
  }
}

function saveProfile(profileId: string): void {
  try {
    localStorage.setItem(PROFILE_STORAGE_KEY, profileId)
  } catch {
  }
}

function pickProfile(profiles: ZernioProfile[], current: string | null): string | null {
  for (const preferred of [current, readSavedProfile()]) {
    if (preferred && profiles.some((p) => p.id === preferred)) return preferred
  }
  return (profiles.find((p) => p.isDefault) ?? profiles.find((p) => p.name.toLowerCase() === 'default') ?? profiles[0])?.id ?? null
}

function connectedText(platform: string, username?: string | null): string {
  return `${platformName(platform)} connected${username ? ` as @${username}` : ''}.`
}

function noticeFor(error: ZernioErrorInfo): AccountsNotice {
  return { tone: 'danger', text: error.message, action: error.billing ? 'billing' : error.kind === 'auth' ? 'settings' : undefined }
}

const INITIAL = {
  profiles: [] as ZernioProfile[],
  accounts: [] as ZernioAccount[],
  profileId: null,
  syncedAt: 0,
  loaded: false,
  loading: false,
  error: null,
  lastAttemptAt: 0,
  connecting: null,
  disconnecting: null,
  notice: null
} satisfies Partial<AccountsState>

let generation = 0
let accountRevision = 0
let inFlight: Promise<void> | null = null
let hydrating: Promise<void> | null = null
let subscribed = false

export const useAccountsStore = create<AccountsState>((set, get) => {
  const refreshAfterChange = (): void => {
    const startedIn = generation
    if (inFlight) void inFlight.then(() => { if (startedIn === generation) void get().load() })
    else void get().load()
  }

  const applyOverview = (overview: ZernioOverview): void => {
    set({
      profiles: overview.profiles,
      accounts: overview.accounts,
      profileId: pickProfile(overview.profiles, get().profileId),
      syncedAt: overview.syncedAt ?? Date.now(),
      loaded: true
    })
  }

  const detectFinishedSignIn = (): void => {
    const connecting = get().connecting
    if (!connecting) return
    const candidates = get().accounts.filter((a) =>
      a.platform === connecting.platform && (!connecting.profileId || a.profileId === connecting.profileId))
    const found = candidates.find((a) => !connecting.knownAccountIds.includes(a.id)) ??
      (connecting.reconnect ? candidates.find((a) => connecting.flaggedAccountIds.includes(a.id) && !a.needsReconnect) : undefined)
    if (!found) return
    getApi().zernio.cancelConnect().catch(() => {})
    set({ connecting: null, notice: { tone: 'success', text: connectedText(found.platform, found.username) } })
  }

  const finishConnect = (result: ZernioConnectResult): void => {
    const connecting = get().connecting
    if (connecting && result.platform !== connecting.platform) return
    if (connecting && result.ended === 'timeout') {
      void get().load().then(() => {
        if (get().connecting === connecting) set({ connecting: null, notice: { tone: 'neutral', text: result.error ?? 'Stopped waiting for the browser.' } })
      })
      return
    }
    if (connecting) {
      set({
        connecting: null,
        notice: result.success
          ? { tone: 'success', text: connectedText(result.platform, result.username) }
          : { tone: 'danger', text: result.error ?? `Could not connect ${platformName(result.platform)}.`, action: result.billing ? 'billing' : undefined }
      })
    }
    if (result.success) {
      accountRevision += 1
      refreshAfterChange()
    } else void get().load()
  }

  const reset = ({ configured }: { configured: boolean }): void => {
    generation += 1
    accountRevision += 1
    inFlight = null
    hydrating = null
    set({ ...INITIAL })
    if (configured) void get().hydrate().then(() => get().load())
  }

  const ensureSubscribed = (): void => {
    if (subscribed) return
    subscribed = true
    const api = getApi().zernio
    api.onConnectResult(finishConnect)
    api.onReset(reset)
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('focus', () => {
        if (get().connecting) get().refreshOnFocus()
      })
    }
  }

  return {
    ...INITIAL,

    hydrate: () => {
      ensureSubscribed()
      const startedIn = generation
      hydrating ??= (async () => {
        const api = getApi().zernio
        const [cached, pending] = await Promise.all([api.cachedOverview().catch(() => null), api.pendingConnect().catch(() => null)])
        if (startedIn !== generation) return
        if (cached && get().syncedAt === 0) applyOverview(cached)
        if (pending && !get().connecting) {
          const onPlatform = get().accounts.filter((a) => a.platform === pending.platform)
          set({
            connecting: {
              platform: pending.platform,
              reconnect: pending.reconnect,
              profileId: pending.profileId,
              knownAccountIds: onPlatform.map((a) => a.id),
              flaggedAccountIds: onPlatform.filter((a) => a.needsReconnect).map((a) => a.id)
            }
          })
        }
      })()
      return hydrating
    },

    load: () => {
      ensureSubscribed()
      if (inFlight) return inFlight
      const startedIn = generation
      const startedRevision = accountRevision
      set({ loading: true })
      const run = async (): Promise<void> => {
        try {
          const result = await getApi().zernio.sync()
          if (startedIn !== generation) return
          if (startedRevision === accountRevision && result.overview && (!result.stale || (result.overview.syncedAt ?? 0) > get().syncedAt)) applyOverview(result.overview)
          set({ error: result.error, loaded: true, lastAttemptAt: Date.now() })
          if (!result.stale) detectFinishedSignIn()
        } catch (err) {
          if (startedIn === generation) {
            set({ error: { message: errorMessage(err, 'Could not load your Zernio accounts.'), kind: 'other' }, loaded: true, lastAttemptAt: Date.now() })
          }
        } finally {
          if (startedIn === generation) set({ loading: false })
        }
      }
      const request = run().finally(() => {
        if (inFlight === request) inFlight = null
      })
      inFlight = request
      return request
    },

    refreshOnFocus: () => {
      const state = get()
      if (state.loading) return
      const since = Date.now() - Math.max(state.syncedAt, state.lastAttemptAt)
      const waitMs = state.error?.kind === 'rate_limit' && state.error.retryAfterSeconds
        ? state.error.retryAfterSeconds * 1000
        : state.connecting ? FOCUS_REFRESH_CONNECTING_MS : FOCUS_REFRESH_MS
      if (since >= waitMs) void state.load()
    },

    setProfile: (profileId) => {
      if (!get().profiles.some((p) => p.id === profileId)) return
      saveProfile(profileId)
      set({ profileId, notice: null })
    },

    createProfile: async (name) => {
      const startedIn = generation
      const profile = await getApi().zernio.createProfile(name)
      if (startedIn !== generation) throw new Error('The Zernio workspace changed. Please try again.')
      saveProfile(profile.id)
      set((state) => ({ profiles: [...state.profiles.filter((item) => item.id !== profile.id), profile], profileId: profile.id, notice: null }))
      return profile
    },

    connect: async (platform, { reconnect = false, newProfileName } = {}) => {
      if (get().connecting) return
      ensureSubscribed()
      const name = platformName(platform)
      const profileName = newProfileName?.trim()
      if (newProfileName !== undefined && (!isValidProfileName(newProfileName) || reconnect)) {
        set({ notice: { tone: 'danger', text: 'Enter a profile name of 1–80 characters before connecting.' } })
        return
      }
      const targetProfileId = profileName ? null : get().profileId
      const onPlatform = get().accounts.filter((a) => a.platform === platform)
      const connecting: Connecting = {
        platform,
        reconnect,
        profileId: targetProfileId,
        knownAccountIds: onPlatform.map((a) => a.id),
        flaggedAccountIds: onPlatform.filter((a) => a.needsReconnect).map((a) => a.id)
      }
      set({ connecting, notice: null })
      try {
        const start = await getApi().zernio.connect(platform, targetProfileId, profileName ? { newProfileName: profileName } : { reconnect })
        if (get().connecting !== connecting) {
          if (start.status === 'pending' && !get().connecting) getApi().zernio.cancelConnect().catch(() => {})
          return
        }
        if (start.createdProfile) {
          const createdProfile = start.createdProfile
          set((state) => ({ profiles: [...state.profiles.filter((p) => p.id !== createdProfile.id), createdProfile] }))
        }
        if ((start.status !== 'failed' || start.createdProfile) && start.profileId && start.profileId !== get().profileId) {
          saveProfile(start.profileId)
          set({ profileId: start.profileId })
        }
        if (start.status === 'pending') {
          set({ connecting: { ...connecting, profileId: start.profileId } })
        } else if (start.status === 'connected') {
          set({ connecting: null, notice: { tone: 'success', text: `${name} is already connected${start.username ? ` as @${start.username}` : ''}.` } })
          accountRevision += 1
          refreshAfterChange()
        } else {
          set({ connecting: null, notice: noticeFor(start.error) })
        }
      } catch (err) {
        if (get().connecting === connecting) {
          set({ connecting: null, notice: { tone: 'danger', text: errorMessage(err, `Could not start connecting ${name}.`) } })
        }
      }
    },

    cancelConnect: () => {
      if (!get().connecting) return
      set({ connecting: null })
      getApi().zernio.cancelConnect().catch(() => {})
      void get().load()
    },

    disconnect: async (accountId) => {
      if (get().disconnecting) return
      const account = get().accounts.find((a) => a.id === accountId)
      if (!account) return
      const startedIn = generation
      set({ disconnecting: accountId, notice: null })
      try {
        await getApi().zernio.disconnect(accountId)
        if (startedIn !== generation) return
        accountRevision += 1
        set((state) => ({ accounts: state.accounts.filter((a) => a.id !== accountId) }))
        set({ notice: { tone: 'success', text: `${platformName(account.platform)} disconnected.` } })
        refreshAfterChange()
      } catch (err) {
        if (startedIn === generation) set({ notice: { tone: 'danger', text: errorMessage(err, 'Could not disconnect the account.') } })
      } finally {
        if (startedIn === generation) set({ disconnecting: null })
      }
    },

    dismissNotice: () => set({ notice: null })
  }
})

export async function ensureAccountsLoaded(maxAgeMs = 60_000): Promise<void> {
  const store = useAccountsStore.getState()
  await store.hydrate()
  const { syncedAt, lastAttemptAt, loading } = useAccountsStore.getState()
  if (!loading && Date.now() - Math.max(syncedAt, lastAttemptAt) > maxAgeMs) await useAccountsStore.getState().load()
}

export function selectPostableAccounts(state: Pick<AccountsState, 'accounts' | 'profileId'>, profileId = state.profileId): ZernioAccount[] {
  return state.accounts.filter((account) => account.profileId === profileId && isPostableAccount(account))
}

export function usePostableAccounts(): ZernioAccount[] {
  return useAccountsStore(useShallow((state) => selectPostableAccounts(state)))
}
