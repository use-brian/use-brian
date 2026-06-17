export {
  FILE_SENSITIVITIES,
  workspaceFileStatus,
  type FileSensitivity,
  type WorkspaceFileMetadata,
  type WorkspaceFile,
  type WorkspaceFileIndexRow,
  type WorkspaceFileCreateInput,
  type WorkspaceFileMetaPatch,
  type WorkspaceFileSupersedePatch,
  type WorkspaceFileRowStatus,
  type WorkspaceFilesStore,
} from './types.js'

export type {
  FilesContext,
  FilesError,
  FilesQuotaError,
  FilesNotFoundError,
  FilesConflictError,
  FilesResult,
  FilesWriteParams,
  FilesWriteBytesParams,
  FilesReadResult,
  FilesReadBytesResult,
  FilesSearchParams,
  FilesApi,
} from './api.js'

export {
  createFileTools,
  type FileToolEvent,
  type FileToolEventContext,
  type FileToolOptions,
} from './tools.js'

export { createSendFileTool } from './send-file.js'

export {
  AttachmentCollector,
  MAX_ATTACHMENTS_PER_TURN,
  MAX_EXTERNAL_DOCUMENT_BYTES,
  type OutboundAttachment,
} from './attachments.js'

export { buildWorkspaceFilesContext } from './context-builder.js'
