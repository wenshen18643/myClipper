import { app, clipboard, ipcMain, type BrowserWindow } from 'electron'
import { join } from 'path'
import {
  ASSISTANT_PROVIDER_INFO,
  ASSISTANT_PROVIDERS,
  isAssistantCliProvider,
  isAssistantModel,
  isAssistantProvider,
  type AppDataScope,
  type AssistantEvent,
  type AssistantCliProviderId,
  type AssistantNavigationPage,
  type AssistantPreferences,
  type AssistantProviderId,
  type AssistantProviderStatus,
  type AssistantSignInState
} from '../../shared/assistant'
import { assertTrustedSender } from '../security'
import { logger } from '../logger'
import { loadSettings } from '../settings-store'
import { AssistantService } from './assistant-service'
import { createMyClipperTools } from './myclipper-tools'
import { checkProvider, openRouterStatus } from './providers'
import { OPENROUTER_CHAT_URL } from './openrouter-agent'
import { createWebTools } from './web-tools'
import { SignInManager } from './sign-in'
import { assistantSystemPrompt } from './system-prompt'

const STATUS_TTL_MS = 30 * 1000

export interface AssistantRuntime {
  shutdown: () => Promise<void>
}

export function registerAssistant(getMainWindow: () => BrowserWindow | null): AssistantRuntime {
  const send = (channel: string, payload: unknown): void => {
    const window = getMainWindow()
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(channel, payload)
  }
  const handle = (channel: string, listener: (...args: unknown[]) => unknown): void => {
    ipcMain.handle(channel, (event, ...args) => {
      assertTrustedSender(event, getMainWindow())
      return listener(...args)
    })
  }
  const provider = (value: unknown): AssistantProviderId => {
    if (!isAssistantProvider(value)) throw new Error('Choose Claude, Codex or OpenRouter.')
    return value
  }
  const cliProvider = (value: unknown): AssistantCliProviderId => {
    if (!isAssistantCliProvider(value)) throw new Error('Choose Claude or Codex.')
    return value
  }

  const openRouterUrl = app.isPackaged ? OPENROUTER_CHAT_URL : process.env.MYCLIPPER_E2E_OPENROUTER_URL || OPENROUTER_CHAT_URL
  const openRouterKey = (): string => loadSettings().openrouterApiKey
  const tools = [
    ...createMyClipperTools({
      getMainWindow,
      dataChanged: (scope: AppDataScope) => send('app:dataChanged', scope),
      navigate: (page: AssistantNavigationPage, runDir?: string) => send('app:navigate', { page, runDir: runDir ?? null })
    }),
    ...createWebTools({ apiKey: openRouterKey, url: openRouterUrl })
  ]
  const service = new AssistantService({
    root: join(app.getPath('userData'), 'assistant'),
    appVersion: app.getVersion(),
    tools: () => tools,
    systemPrompt: () => assistantSystemPrompt(),
    emit: (event: AssistantEvent) => send('assistant:event', event),
    openRouter: { apiKey: openRouterKey, url: openRouterUrl }
  })

  const statusCache = new Map<AssistantCliProviderId, { at: number; status: Promise<AssistantProviderStatus> }>()
  const status = async (id: AssistantProviderId, fresh: boolean): Promise<AssistantProviderStatus> => {
    if (id === 'openrouter') return openRouterStatus(Boolean(loadSettings().openrouterApiKey))
    const cached = statusCache.get(id)
    if (!fresh && cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.status
    const next = checkProvider(id).catch((error: unknown): AssistantProviderStatus => {
      logger.warn('assistant.status.failed', { provider: id })
      return { id, state: 'unknown', version: null, account: null, plan: null, detail: error instanceof Error ? error.message : 'Could not check this assistant.', checkedAt: new Date().toISOString() }
    })
    statusCache.set(id, { at: Date.now(), status: next })
    return next
  }
  const signIn = new SignInManager(
    (state: AssistantSignInState) => send('assistant:signIn', state),
    (id) => {
      statusCache.delete(id)
      void status(id, true).then((next) => send('assistant:status', next))
    }
  )

  handle('assistant:status', async (fresh) => Promise.all(ASSISTANT_PROVIDERS.map((id) => status(id, fresh === true))))
  handle('assistant:preferences', () => service.preferences())
  handle('assistant:savePreferences', (raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid assistant preferences')
    const input = raw as Partial<AssistantPreferences>
    const current = service.preferences()
    const next: AssistantPreferences = {
      provider: input.provider === null || input.provider === undefined ? current.provider : provider(input.provider),
      models: { ...current.models }
    }
    for (const id of ASSISTANT_PROVIDERS) {
      const model = input.models?.[id]
      if (model !== undefined) {
        if (!isAssistantModel(id, model)) throw new Error('Choose a listed model.')
        next.models[id] = model
      }
    }
    return service.savePreferences(next)
  })
  handle('assistant:conversations', () => service.listConversations())
  handle('assistant:conversation', (id) => typeof id === 'string' ? service.getConversation(id) : null)
  handle('assistant:deleteConversation', (id) => { service.deleteConversation(String(id)); return service.listConversations() })
  handle('assistant:running', () => service.runningConversationIds())
  handle('assistant:send', (raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid message')
    const input = raw as Record<string, unknown>
    if (typeof input.text !== 'string') throw new Error('Type a message first.')
    if (input.conversationId !== null && typeof input.conversationId !== 'string') throw new Error('Invalid conversation id')
    const id = provider(input.provider)
    if (!isAssistantModel(id, input.model)) throw new Error('Choose a listed model.')
    return service.sendMessage({ conversationId: input.conversationId as string | null, provider: id, model: input.model, text: input.text })
  })
  handle('assistant:stop', (id) => { if (typeof id === 'string') service.stop(id) })
  handle('assistant:approve', (requestId, allowed) => {
    if (typeof requestId !== 'string' || typeof allowed !== 'boolean') throw new Error('Invalid approval')
    service.respondToApproval(requestId, allowed)
  })
  handle('assistant:signIn:start', (id) => signIn.start(cliProvider(id)))
  handle('assistant:signIn:state', (id) => signIn.state(cliProvider(id)))
  handle('assistant:signIn:code', (id, code) => signIn.submitCode(cliProvider(id), code))
  handle('assistant:signIn:cancel', (id) => signIn.cancel(cliProvider(id)))
  handle('assistant:signIn:open', (id) => signIn.openUrl(cliProvider(id)))
  handle('assistant:copyCommand', (id, which) => {
    const info = ASSISTANT_PROVIDER_INFO[cliProvider(id)]
    const command = which === 'signIn' ? info.signInCommand : info.installCommand
    if (!command) return false
    clipboard.writeText(command)
    return true
  })

  return {
    shutdown: async () => {
      signIn.stopAll()
      await service.shutdown()
    }
  }
}
