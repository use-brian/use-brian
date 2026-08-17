export type { Tool, ToolContext, ToolResult, ToolResultMeta } from './types.js'
export { buildTool } from './types.js'
export { filterToolsByCapabilities, isAutonomousToolContext, INTERACTIVE_CHANNEL_TYPES } from './capability-gate.js'
export { createBaseTools, createEngineBaseTools, urlReaderTool, webSearchTool, askQuestionTool, createTaskTool, updateTaskTool, getTimeTool, _getSessionTasksSize } from './base/index.js'
export {
  createGoogleMapsTools,
  extractGoogleMapsSources,
  classifyGoogleMapsError,
  GOOGLE_MAPS_GROUNDING_MCP_URL,
  GOOGLE_MAPS_GROUNDING_COST_USD,
  GOOGLE_MAPS_TOOL_NAMES,
} from './base/google-maps.js'
export type {
  GoogleMapsGroundingApi,
  GoogleMapsProviderToolName,
  GoogleMapsSource,
  GoogleMapsToolName,
  GoogleMapsErrorCode,
} from './base/google-maps.js'
export {
  describeToolFailure,
  isTransientToolError,
  notFoundFailure,
  notFoundMessage,
  toolFailure,
} from './tool-failure.js'
export type { NotFoundContext, ToolFailureContext } from './tool-failure.js'
export {
  MAILBOX_DISABLED_MARKERS,
  MAILBOX_UNREACHABLE_CODES,
  classifyMailboxAuthFailure,
  classifyMailboxFailure,
  describeMailboxError,
  isMailboxAuthError,
  mailboxErrorCode,
  mailboxErrorText,
  mailboxFailure,
} from './base/_mailbox-error.js'
export type { MailboxFailureContext, MailboxFailureKind } from './base/_mailbox-error.js'
export {
  CONNECTOR_ERROR_MESSAGE_CAP,
  ConnectorApiError,
  capConnectorMessage,
  coerceConnectorError,
  connectorError,
  describeConnectorError,
  isConnectorApiError,
} from './base/_connector-result.js'
export type { ConnectorApiErrorInit, ConnectorErrorContext, ConnectorFailureKind } from './base/_connector-result.js'
export {
  GoogleApiError,
  GOOGLE_ERROR_MESSAGE_CAP,
  describeGoogleError,
  googleFailure,
  isGoogleApiError,
  parseGoogleErrorBody,
} from './base/_google-error.js'
export type { GoogleApiProduct, GoogleApiErrorInit, GoogleFailureContext } from './base/_google-error.js'
export { createGoogleCalendarTools } from './base/google-calendar.js'
export type {
  GoogleCalendarApi,
  CalendarRecurrenceScope,
  CalendarAvailability,
  CalendarVisibility,
  CalendarConference,
  CalendarAttendeeInput,
  CalendarAttachmentInput,
  CalendarEventLabel,
  CalendarEventPaletteColor,
  CalendarEventColorOptions,
  CalendarRemindersInput,
  CalendarGuestPermissionsInput,
  CalendarFocusTimeProperties,
  CalendarOutOfOfficeProperties,
  CalendarWorkingLocationProperties,
  CalendarEventCreateInput,
  CalendarEventUpdateInput,
} from './base/google-calendar.js'
export { createGmailTools, MAX_EMAIL_ATTACHMENTS, MAX_EMAIL_ATTACHMENT_TOTAL_BYTES } from './base/google-gmail.js'
export type { GmailApi, GmailOutgoingAttachment } from './base/google-gmail.js'
export { createGoogleTasksTools } from './base/google-tasks.js'
export type { GoogleTasksApi } from './base/google-tasks.js'
export { createGoogleDriveTools } from './base/google-drive.js'
export type { GoogleDriveApi, AuthorizedFile } from './base/google-drive.js'
export { createGoogleDocsTools } from './base/google-docs.js'
export type { GoogleDocsApi } from './base/google-docs.js'
export { createGoogleSheetsTools } from './base/google-sheets.js'
export type { GoogleSheetsApi } from './base/google-sheets.js'
export { createGoogleSlidesTools } from './base/google-slides.js'
export type { GoogleSlidesApi } from './base/google-slides.js'
export { createGDriveFilesTools, GDRIVE_FILE_KINDS } from './base/gdrive-files.js'
export type { GDriveFile, GDriveFileKind, GDriveFilesStore } from './base/gdrive-files.js'
export { createGitHubTools } from './base/github.js'
export type { GitHubApi } from './base/github.js'
export { createNotionTools } from './base/notion.js'
export type { NotionApi } from './base/notion.js'
export { createMsGraphTools } from './base/msgraph.js'
export type { MsGraphApi } from './base/msgraph.js'
export { createFathomTools } from './base/fathom.js'
export type { FathomApi } from './base/fathom.js'
export { createShopifyTools } from './base/shopify.js'
export type { ShopifyApi } from './base/shopify.js'
export { createWordPressTools, WORDPRESS_IMAGE_MIME_TYPES, WORDPRESS_MAX_IMAGE_BYTES } from './base/wordpress.js'
export type { WordPressApi, WordPressFileBytesReader } from './base/wordpress.js'
export {
  createSearchConsoleTools,
  SEARCH_CONSOLE_DIMENSIONS,
  SEARCH_CONSOLE_FILTER_OPERATORS,
  SEARCH_CONSOLE_SEARCH_TYPES,
  SEARCH_CONSOLE_TOOL_NAMES,
} from './base/gsc.js'
export type { SearchConsoleToolsApi, SearchConsoleQueryBody } from './base/gsc.js'
export { createAgentmailTools } from './base/agentmail.js'
export type { AgentmailToolApi, AgentmailInboxRef, AgentmailThreadSummary } from './base/agentmail.js'
export {
  createMailboxTools,
  singleMailboxRouter,
  stitchMailboxThreads,
  MAILBOX_DEFAULT_WINDOW_DAYS,
  MAILBOX_DEFAULT_LIMIT,
  MAILBOX_MAX_LIMIT,
  MAILBOX_ATTACHMENT_MAX_BYTES,
  MAX_MAILBOX_OUTGOING_ATTACHMENTS,
  MAX_MAILBOX_OUTGOING_ATTACHMENT_TOTAL_BYTES,
} from './base/mailbox.js'
export type { MailboxApi, MailboxAccountRouter, MailboxAccountRef, MailboxSearchParams, MailboxSearchHit, MailboxMessage, MailboxThread, MailboxAttachment, MailboxAttachmentBytes, MailboxOutgoingAttachment, MailboxAttachmentDeps, CreateMailboxToolsOptions } from './base/mailbox.js'
export { createKnowledgeTools } from './base/knowledge.js'
export { createInterAssistantTools } from './base/ask-assistant.js'
export type { InterAssistantDeps } from './base/ask-assistant.js'
export { createReportBugTool } from './base/report-bug.js'
export type { BugReportStore } from './base/report-bug.js'
export { createConfirmRecordingProcessingTool } from './base/confirm-recording-processing.js'
export type { ConfirmRecordingProcessingDeps } from './base/confirm-recording-processing.js'
export { createIngestStoredFileTool } from './base/ingest-stored-file.js'
export type { IngestStoredFileDeps } from './base/ingest-stored-file.js'
export { createReprocessRecordingTool } from './base/reprocess-recording.js'
export type { ReprocessRecordingDeps } from './base/reprocess-recording.js'
export {
  createPresentDocumentTool,
  MAX_PRESENTED_DOCUMENT_CHARS,
  parsePresentedDocumentInput,
  presentedDocumentInputSchema,
} from './base/present-document.js'
export type { PresentedDocumentInput } from './base/present-document.js'
export {
  createWorkspaceChatHandoffTool,
  WORKSPACE_CHAT_HANDOFF_MAX_CHARS,
  workspaceChatHandoffInputSchema,
} from './base/workspace-chat-handoff.js'
export type {
  WorkspaceChatHandoffInput,
  WorkspaceChatHandoffPort,
} from './base/workspace-chat-handoff.js'
