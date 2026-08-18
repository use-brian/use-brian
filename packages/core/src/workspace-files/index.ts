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
export { createRenderPdfTool, normalizePdfPath, MAX_RENDER_PDF_MARKDOWN_CHARS, type RenderPdfDocPageReader, type RenderPdfToolOptions } from './render-pdf.js'

export type { FileToolPolicy, ResolveFileToolPolicy } from './tool-helpers.js'

// Exported so a non-files tool that reads a workspace file (shopifyAddProductImage)
// reports failures in exactly the words the file tools use, rather than
// inventing a second vocabulary for "not found" and "no workspace".
export {
  ctxFor as workspaceFilesCtxFor,
  errorMessage as workspaceFilesErrorMessage,
  workspaceGate as workspaceFilesGate,
} from './tool-helpers.js'

export {
  AttachmentCollector,
  MAX_ATTACHMENTS_PER_TURN,
  MAX_EXTERNAL_DOCUMENT_BYTES,
  type OutboundAttachment,
} from './attachments.js'

export { buildWorkspaceFilesContext } from './context-builder.js'
export { promoteCachedFile, cachedFileBytes } from './promote.js'

export { buildUploadPolicyBlock } from './upload-policy-block.js'
