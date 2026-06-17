export type {
  ChannelType,
  CallerIdentity,
  Part,
  A2AMessage,
  Artifact,
  TaskState,
  TaskStatus,
  Task,
  AssistantMode,
  Capability,
  SpecialistCard,
  ConsultChain,
  ConsultRequest,
  ConsultResponse,
  ConsultError,
  ConsultTransport,
} from './types.js'

export {
  channelTypeSchema,
  callerIdentitySchema,
  partSchema,
  a2aMessageSchema,
  artifactSchema,
  taskStateSchema,
  taskStatusSchema,
  taskSchema,
  capabilityIdSchema,
  capabilitySchema,
  specialistCardSchema,
  consultChainSchema,
  consultRequestSchema,
  consultResponseSchema,
  consultErrorSchema,
} from './schemas.js'

export { CONSULT_LIMITS, INITIAL_BUDGET, ERROR_CODES } from './limits.js'
export type { ErrorCode, EntryPoint } from './limits.js'

export { createInProcessTransport } from './transport-in-process.js'
export type {
  InProcessTransportDeps,
  RunConsultParams,
  RunConsultResult,
} from './transport-in-process.js'
