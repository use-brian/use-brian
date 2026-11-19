export { classifyTool, defaultPolicy } from '@use-brian/agent-runtime/mcp/classifier.js'
export type { ToolClassification } from '@use-brian/agent-runtime/mcp/classifier.js'
export type { McpToolSetting, McpSettingsStore, McpServerConfig, McpToolInfo, ConfirmationDecision, ConfirmationOutcome, ToolConfirmationRequest, AwaitingApprovalEvent, ConfirmationResolver } from '@use-brian/agent-runtime/mcp/types.js'
export { AUTO_PROMOTE_THRESHOLD, createConfirmationResolver } from '@use-brian/agent-runtime/mcp/types.js'
export { ChannelConfirmations } from './channel-confirmations.js'
export type { ChannelInteractionScope } from './channel-confirmations.js'
export { wrapMcpTools } from './connector.js'
export { createMcpGateway } from './gateway.js'
export { buildToolIndex, createMcpSearchTools, legacyMcpToolName } from './tool-search.js'
export type { McpToolIndex, ToolSource, RemoteSource, LocalSource, LocalToolDescriptor, LocalToolResolution } from './tool-search.js'
export {
  CONFIRMATION_DECISIONS,
  buildConfirmationActions,
  confirmationDecisionLabel,
  encodeConfirmationAction,
  interpretConfirmationEvent,
  isConfirmationDecision,
} from './confirmation-events.js'
export type {
  ConfirmationAction,
  ConfirmationEventResult,
  NormalizedConfirmationEvent,
} from './confirmation-events.js'
