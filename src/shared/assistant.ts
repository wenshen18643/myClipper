
import { isModelId } from './openrouter-models'

export const ASSISTANT_CLI_PROVIDERS = ['claude', 'codex'] as const
export type AssistantCliProviderId = (typeof ASSISTANT_CLI_PROVIDERS)[number]
export const ASSISTANT_PROVIDERS = [...ASSISTANT_CLI_PROVIDERS, 'openrouter'] as const
export type AssistantProviderId = (typeof ASSISTANT_PROVIDERS)[number]

export function isAssistantProvider(value: unknown): value is AssistantProviderId {
  return typeof value === 'string' && (ASSISTANT_PROVIDERS as readonly string[]).includes(value)
}

export function isAssistantCliProvider(value: unknown): value is AssistantCliProviderId {
  return typeof value === 'string' && (ASSISTANT_CLI_PROVIDERS as readonly string[]).includes(value)
}

export interface AssistantProviderInfo {
  id: AssistantProviderId
  name: string
  brand: string
  subscription: string
  installCommand: string | null
  signInCommand: string | null
  docsUrl: string
}

export const ASSISTANT_PROVIDER_INFO: Record<AssistantProviderId, AssistantProviderInfo> = {
  claude: {
    id: 'claude',
    name: 'Claude Code',
    brand: 'Claude',
    subscription: 'Claude Pro or Max',
    installCommand: 'curl -fsSL https://claude.ai/install.sh | bash',
    signInCommand: 'claude',
    docsUrl: 'https://docs.claude.com/en/docs/claude-code/setup'
  },
  codex: {
    id: 'codex',
    name: 'Codex',
    brand: 'OpenAI',
    subscription: 'ChatGPT Plus, Pro or Business',
    installCommand: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
    signInCommand: 'codex login',
    docsUrl: 'https://developers.openai.com/codex/cli'
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    brand: 'OpenRouter',
    subscription: 'OpenRouter API key',
    installCommand: null,
    signInCommand: null,
    docsUrl: 'https://openrouter.ai/models'
  }
}

export type AssistantConnectionState = 'not-installed' | 'signed-out' | 'connected' | 'unknown'

export interface AssistantProviderStatus {
  id: AssistantProviderId
  state: AssistantConnectionState
  version: string | null
  account: string | null
  plan: string | null
  detail: string | null
  checkedAt: string
}

export interface AssistantModelOption {
  id: string
  label: string
}

export const ASSISTANT_MODELS: Record<AssistantProviderId, readonly AssistantModelOption[]> = {
  claude: [
    { id: '', label: 'Default' },
    { id: 'sonnet', label: 'Sonnet' },
    { id: 'opus', label: 'Opus' },
    { id: 'fable', label: 'Fable' },
    { id: 'haiku', label: 'Haiku' }
  ],
  codex: [
    { id: '', label: 'Default' },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
    { id: 'gpt-6-sol', label: 'GPT-6 Sol' },
    { id: 'gpt-6-astra', label: 'GPT-6 Astra' },
    { id: 'gpt-6-luna', label: 'GPT-6 Luna' }
  ],
  openrouter: []
}

export const OPENROUTER_ASSISTANT_SUGGESTIONS = ['anthropic/claude-opus-5.5', 'openai/gpt-6-sol', 'google/gemini-3.8-flash'] as const

export function isAssistantModel(provider: AssistantProviderId, value: unknown): value is string {
  if (provider === 'openrouter') return value === '' || isModelId(value)
  return typeof value === 'string' && ASSISTANT_MODELS[provider].some((model) => model.id === value)
}

export function assistantModelLabel(provider: AssistantProviderId, model: string, catalogName?: string | null): string | null {
  if (!model) return null
  if (provider === 'openrouter') return catalogName || model
  return ASSISTANT_MODELS[provider].find((option) => option.id === model)?.label ?? null
}

export function assistantModelName(provider: AssistantProviderId, model: string, catalogName?: string | null): string {
  const brand = ASSISTANT_PROVIDER_INFO[provider].brand
  const label = assistantModelLabel(provider, model, catalogName)
  if (!label) return brand
  return provider === 'claude' ? `${brand} ${label}` : label
}

export interface AssistantPreferences {
  provider: AssistantProviderId | null
  models: Record<AssistantProviderId, string>
}

export const DEFAULT_ASSISTANT_PREFERENCES: AssistantPreferences = {
  provider: null,
  models: { claude: '', codex: '', openrouter: '' }
}

export type AssistantToolStatus = 'running' | 'awaiting-approval' | 'done' | 'error' | 'denied'

export interface AssistantToolCall {
  id: string
  name: string
  title: string
  input: unknown
  status: AssistantToolStatus
  summary: string | null
}

export interface AssistantMessagePart {
  kind: 'text' | 'tool'
  text?: string
  tool?: AssistantToolCall
}

export interface AssistantMessage {
  id: string
  role: 'user' | 'assistant'
  createdAt: string
  parts: AssistantMessagePart[]
  error?: string | null
  provider?: AssistantProviderId
  model?: string
}

export interface AssistantConversation {
  id: string
  title: string
  provider: AssistantProviderId
  model: string
  resumeId: string | null
  createdAt: string
  updatedAt: string
  messages: AssistantMessage[]
}

export interface AssistantConversationSummary {
  id: string
  title: string
  provider: AssistantProviderId
  updatedAt: string
}

export interface AssistantApprovalRequest {
  id: string
  conversationId: string
  toolCallId: string
  tool: string
  title: string
  details: string[]
}

export type AssistantEvent =
  | { type: 'turn-start'; conversationId: string; messageId: string }
  | { type: 'text-delta'; conversationId: string; messageId: string; text: string }
  | { type: 'tool'; conversationId: string; messageId: string; tool: AssistantToolCall }
  | { type: 'approval'; conversationId: string; request: AssistantApprovalRequest }
  | { type: 'approval-resolved'; conversationId: string; requestId: string }
  | { type: 'turn-end'; conversationId: string; messageId: string; error: string | null }
  | { type: 'conversation'; conversation: AssistantConversationSummary }

export const ASSISTANT_PROMPT_MAX_CHARS = 20000

export interface AssistantSignInState {
  provider: AssistantCliProviderId
  status: 'idle' | 'waiting' | 'succeeded' | 'failed'
  url: string | null
  acceptsCode: boolean
  message: string | null
}

export type AssistantNavigationPage = 'clip' | 'library' | 'jobs' | 'accounts' | 'posts' | 'automations' | 'settings'
export type AppDataScope = 'library' | 'automations' | 'posts' | 'settings' | 'accounts'
