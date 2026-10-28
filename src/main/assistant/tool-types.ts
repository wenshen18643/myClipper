
import type { AssistantProviderId } from '../../shared/assistant'

export interface AssistantToolContext {
  conversationId: string
  signal: AbortSignal
}

export interface AssistantToolSpec {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  readOnly?: boolean
  destructive?: boolean
  providers?: readonly AssistantProviderId[]
  confirm?: (input: Record<string, unknown>) => Promise<string[] | null> | string[] | null
  describe?: (input: Record<string, unknown>) => string
  run: (input: Record<string, unknown>, context: AssistantToolContext) => Promise<unknown>
}

export class AssistantToolError extends Error {}
