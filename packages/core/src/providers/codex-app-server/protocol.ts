import { z } from 'zod'

/**
 * Minimal reviewed fixture from:
 *   codex app-server generate-json-schema --experimental
 *   @openai/codex 0.146.0-alpha.10.1
 *
 * Keep this deliberately smaller than the generated bundle. Add method schemas
 * only when Brian starts consuming that method.
 */
export const PINNED_CODEX_VERSION = '0.146.0-alpha.10.1'

const RpcIdSchema = z.union([z.string(), z.number().finite()])

const RpcErrorSchema = z
  .object({
    code: z.number().int(),
    message: z.string(),
    data: z.unknown().optional(),
  })
  .passthrough()

function excludesKeys(...keys: string[]): (value: Record<string, unknown>) => boolean {
  return (value) => keys.every((key) => !Object.prototype.hasOwnProperty.call(value, key))
}

const RpcResultResponseSchema = z
  .object({
    id: RpcIdSchema,
    result: z.unknown(),
  })
  .passthrough()
  .refine((value) => Object.prototype.hasOwnProperty.call(value, 'result'), {
    message: 'RPC result response must contain result',
  })
  .refine(excludesKeys('method', 'error'), {
    message: 'RPC result response cannot contain method or error',
  })

const RpcErrorResponseSchema = z
  .object({
    id: RpcIdSchema,
    error: RpcErrorSchema,
  })
  .passthrough()
  .refine(excludesKeys('method', 'result'), {
    message: 'RPC error response cannot contain method or result',
  })

const RpcServerRequestSchema = z
  .object({
    id: RpcIdSchema,
    method: z.string().min(1).max(256),
    params: z.unknown().optional(),
  })
  .passthrough()
  .refine(excludesKeys('result', 'error'), {
    message: 'RPC server request cannot contain result or error',
  })

const RpcNotificationSchema = z
  .object({
    method: z.string().min(1).max(256),
    params: z.unknown().optional(),
  })
  .passthrough()
  .refine(excludesKeys('id', 'result', 'error'), {
    message: 'RPC notification cannot contain id, result, or error',
  })

export const InboundRpcMessageSchema = z.union([
  RpcResultResponseSchema,
  RpcErrorResponseSchema,
  RpcServerRequestSchema,
  RpcNotificationSchema,
])

export type RpcId = z.infer<typeof RpcIdSchema>
export type RpcErrorPayload = {
  code: number
  message: string
  data?: unknown
}
export type InboundRpcMessage =
  | { id: RpcId; result: unknown }
  | { id: RpcId; error: RpcErrorPayload }
  | { id: RpcId; method: string; params?: unknown }
  | { method: string; params?: unknown }

export const InitializeParamsSchema = z
  .object({
    clientInfo: z
      .object({
        name: z.string().min(1),
        title: z.string().nullable().optional(),
        version: z.string().min(1),
      })
      .passthrough(),
    capabilities: z
      .object({
        experimentalApi: z.boolean().optional(),
        mcpServerOpenaiFormElicitation: z.boolean().optional(),
        optOutNotificationMethods: z.array(z.string()).nullable().optional(),
        requestAttestation: z.boolean().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough()

export const InitializeResponseSchema = z
  .object({
    codexHome: z.string().min(1),
    platformFamily: z.string().min(1),
    platformOs: z.string().min(1),
    userAgent: z.string().min(1),
  })
  .passthrough()

export type InitializeParams = z.infer<typeof InitializeParamsSchema>
export type InitializeResponse = z.infer<typeof InitializeResponseSchema>

export const CodexPlanTypeSchema = z.enum([
  'free',
  'go',
  'plus',
  'pro',
  'prolite',
  'team',
  'self_serve_business_usage_based',
  'business',
  'ent26',
  'enterprise_cbp_usage_based',
  'enterprise',
  'edu',
  'unknown',
])

const ChatGptAccountSchema = z
  .object({
    type: z.literal('chatgpt'),
    email: z.string().email().max(320).nullable(),
    planType: CodexPlanTypeSchema,
  })
  .passthrough()

const ApiKeyAccountSchema = z.object({ type: z.literal('apiKey') }).passthrough()
const AmazonBedrockAccountSchema = z
  .object({
    type: z.literal('amazonBedrock'),
    usesCodexManagedCredentials: z.boolean().optional(),
  })
  .passthrough()

export const GetAccountResponseSchema = z
  .object({
    account: z
      .union([ChatGptAccountSchema, ApiKeyAccountSchema, AmazonBedrockAccountSchema])
      .nullable()
      .optional(),
    requiresOpenaiAuth: z.boolean(),
  })
  .passthrough()

export const BrowserLoginResponseSchema = z
  .object({
    type: z.literal('chatgpt'),
    loginId: z.string().min(1).max(256),
    authUrl: z.string().min(1).max(16_384),
  })
  .passthrough()

export const DeviceCodeLoginResponseSchema = z
  .object({
    type: z.literal('chatgptDeviceCode'),
    loginId: z.string().min(1).max(256),
    verificationUrl: z.string().min(1).max(16_384),
    userCode: z.string().min(1).max(256),
  })
  .passthrough()

export const AccountLoginCompletedNotificationSchema = z
  .object({
    loginId: z.string().min(1).max(256).nullable().optional(),
    success: z.boolean(),
    error: z.string().max(4096).nullable().optional(),
  })
  .passthrough()

const ReasoningEffortOptionSchema = z
  .object({
    reasoningEffort: z.string().min(1).max(64),
    description: z.string().max(4096),
  })
  .passthrough()

const InputModalitySchema = z.enum(['text', 'image', 'audio'])

export const CodexModelSchema = z
  .object({
    id: z.string().min(1).max(256),
    model: z.string().min(1).max(256),
    displayName: z.string().min(1).max(512),
    description: z.string().max(8192),
    hidden: z.boolean(),
    isDefault: z.boolean(),
    defaultReasoningEffort: z.string().min(1).max(64),
    supportedReasoningEfforts: z.array(ReasoningEffortOptionSchema).max(32),
    inputModalities: z.array(InputModalitySchema).max(8).optional(),
  })
  .passthrough()

export const ModelListResponseSchema = z
  .object({
    data: z.array(CodexModelSchema).max(250),
    nextCursor: z.string().min(1).max(4096).nullable().optional(),
  })
  .passthrough()

export type CodexPlanType = z.infer<typeof CodexPlanTypeSchema>
export type GetAccountResponse = z.infer<typeof GetAccountResponseSchema>
export type BrowserLoginResponse = z.infer<typeof BrowserLoginResponseSchema>
export type DeviceCodeLoginResponse = z.infer<typeof DeviceCodeLoginResponseSchema>
export type AccountLoginCompletedNotification = z.infer<
  typeof AccountLoginCompletedNotificationSchema
>
export type CodexModelProtocol = z.infer<typeof CodexModelSchema>
export type ModelListResponse = z.infer<typeof ModelListResponseSchema>

const CodexTurnStatusSchema = z.enum(['completed', 'interrupted', 'failed', 'inProgress'])

export const ThreadStartResponseSchema = z
  .object({
    thread: z.object({ id: z.string().min(1).max(256) }).passthrough(),
    model: z.string().min(1).max(256),
    modelProvider: z.string().min(1).max(256),
  })
  .passthrough()

export const ThreadInjectItemsResponseSchema = z.object({}).passthrough()
export const ThreadUnsubscribeResponseSchema = z.object({}).passthrough()

export const TurnStartResponseSchema = z
  .object({
    turn: z
      .object({
        id: z.string().min(1).max(256),
        status: CodexTurnStatusSchema,
      })
      .passthrough(),
  })
  .passthrough()

const TurnScopedDeltaSchema = z
  .object({
    threadId: z.string().min(1).max(256),
    turnId: z.string().min(1).max(256),
    itemId: z.string().min(1).max(256),
    delta: z.string().max(1024 * 1024),
  })
  .passthrough()

export const AgentMessageDeltaNotificationSchema = TurnScopedDeltaSchema
export const ReasoningTextDeltaNotificationSchema = TurnScopedDeltaSchema
export const ReasoningSummaryTextDeltaNotificationSchema = TurnScopedDeltaSchema

const TokenUsageBreakdownSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    cacheWriteInputTokens: z.number().int().nonnegative().default(0),
    outputTokens: z.number().int().nonnegative(),
    reasoningOutputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
  })
  .passthrough()

export const ThreadTokenUsageUpdatedNotificationSchema = z
  .object({
    threadId: z.string().min(1).max(256),
    turnId: z.string().min(1).max(256),
    tokenUsage: z
      .object({
        last: TokenUsageBreakdownSchema,
        total: TokenUsageBreakdownSchema,
      })
      .passthrough(),
  })
  .passthrough()

export const TurnCompletedNotificationSchema = z
  .object({
    threadId: z.string().min(1).max(256),
    turn: z
      .object({
        id: z.string().min(1).max(256),
        status: CodexTurnStatusSchema,
        error: z
          .object({
            message: z.string().min(1).max(16_384),
          })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough(),
  })
  .passthrough()

export const DynamicToolCallParamsSchema = z
  .object({
    threadId: z.string().min(1).max(256),
    turnId: z.string().min(1).max(256),
    callId: z.string().min(1).max(256),
    tool: z.string().min(1).max(256),
    namespace: z.string().min(1).max(256).nullable().optional(),
    arguments: z.unknown(),
  })
  .passthrough()

const DynamicToolCallOutputContentItemSchema = z.union([
  z.object({ type: z.literal('inputText'), text: z.string().max(1024 * 1024) }).passthrough(),
  z.object({ type: z.literal('inputImage'), imageUrl: z.string().max(2 * 1024 * 1024) }).passthrough(),
  z.object({ type: z.literal('inputAudio'), audioUrl: z.string().max(2 * 1024 * 1024) }).passthrough(),
])

export const DynamicToolCallResponseSchema = z
  .object({
    success: z.boolean(),
    contentItems: z.array(DynamicToolCallOutputContentItemSchema).max(32),
  })
  .passthrough()

export type ThreadStartResponse = z.infer<typeof ThreadStartResponseSchema>
export type TurnStartResponse = z.infer<typeof TurnStartResponseSchema>
export type AgentMessageDeltaNotification = z.infer<
  typeof AgentMessageDeltaNotificationSchema
>
export type ReasoningTextDeltaNotification = z.infer<
  typeof ReasoningTextDeltaNotificationSchema
>
export type ThreadTokenUsageUpdatedNotification = z.infer<
  typeof ThreadTokenUsageUpdatedNotificationSchema
>
export type TurnCompletedNotification = z.infer<typeof TurnCompletedNotificationSchema>
export type DynamicToolCallParams = z.infer<typeof DynamicToolCallParamsSchema>
export type DynamicToolCallResponse = z.infer<typeof DynamicToolCallResponseSchema>
