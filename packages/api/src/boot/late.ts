/**
 * Late-binding table of the boot composition.
 *
 * A few bindings cross register steps against their construction order, as
 * they did inside the former single boot function: a closure built early reads
 * a value a later step creates (forward), or a later step assigns a binding an
 * earlier step declared (until). Those bindings live here instead of in the
 * step scope; every other binding travels through the scope types
 * (boot/scope.ts). One object per bootOpenApi call; never module state.
 */
import type { createOfficeVersionRuntime } from '../office/version-runtime.js'
import type { LLMProvider } from '@use-brian/agent-runtime/providers/types.js'
import type { MediaBackend } from '@use-brian/core/media/backend.js'
import type { SessionContextAuthority } from '@use-brian/core/memory/session-state-types.js'
import type { TaskRecord, TaskAssignmentProvenance } from '@use-brian/core/tasks/types.js'
import type { createEngineeringArchivePublisher } from '../engineering-history/publisher.js'
import type { createEngineeringHistoryService } from '../engineering-history/service.js'
import type { createTemplateImportRecovery } from '../office/template-import-recovery.js'
import type { MutableProviderAvailability } from '@use-brian/shared/model-registry'
import type { FilesClientResolver, createFilesApi } from '../files/files-api.js'
import type { ChunkedFileUploadService } from '../files/chunked-upload.js'
import type { ValidatedDefinitionEditor } from '../routes/workflows.js'
import type { createPdfSessionService } from '../office/pdf-session-service.js'
import type { createStructuredDocumentRuntime } from '../structured-documents/runtime.js'
import type { createDbChannelIntegrationStore } from '../db/channel-integrations.js'

export interface BootLate {
  /** published by registerProviders; read late by registerRuntime .. registerStores. */
  configuredProviders: MutableProviderAvailability
  /** published by registerProviders; read late by registerRuntime .. registerStores. */
  provider: LLMProvider
  /** declared by registerRuntime; final after registerProviders. */
  providerMediaBackend: MediaBackend | undefined
  /** published by registerConnectors; read late by registerStores .. registerProviders. */
  integrationStore: ReturnType<typeof createDbChannelIntegrationStore> | null
  /** declared by registerStores; final after registerPrimitives. */
  judgeTaskForGoal: ((task: TaskRecord, userId: string, authority?: SessionContextAuthority) => void) | null
  /** declared by registerStores; final after registerPrimitives. */
  enterOrTriageTask: ((task: TaskRecord, userId: string, assignment?: TaskAssignmentProvenance) => void) | null
  /** declared by registerStores; final after registerConnectors. */
  syncNativeSlashCommands: ((userId: string, workspaceId: string) => Promise<void>) | undefined
  /** declared by registerCapture; final after registerFiles. */
  filesResolver: FilesClientResolver | null
  /** declared by registerOfficeTools; final after registerOfficeRoutes. */
  wakeOfficeGeneration: ((userId: string) => void) | null
  /** published by registerOfficeRoutes; read late by registerOfficeTools .. registerApiRoutes. */
  officeVersionRuntime: ReturnType<typeof createOfficeVersionRuntime> | null
  /** published by registerOfficeRoutes; read late by registerOfficeTools .. registerApiRoutes. */
  officeReleaseDeps: import('../routes/office-releases.js').OfficeReleaseRouteDeps | null
  /** published by registerOfficeRoutes; read late by registerOfficeTools .. registerApiRoutes. */
  retryOfficeTemplateImport: ReturnType<typeof createTemplateImportRecovery>
  /** declared by registerOfficeTools; final after registerOfficeRoutes. */
  pdfSessionToolRuntime: ReturnType<typeof createPdfSessionService> | null
  /** declared by registerCapture; final after registerFiles. */
  engineeringArchive: ReturnType<typeof createEngineeringArchivePublisher> | null
  /** declared by registerCapture; final after registerFiles. */
  filesApi: ReturnType<typeof createFilesApi> | null
  /** declared by registerCapture; final after registerFiles. */
  chunkedFileUploads: ChunkedFileUploadService | null
  /** declared by registerCapture; final after registerFiles. */
  engineeringHistory: ReturnType<typeof createEngineeringHistoryService> | null
  /** declared by registerOfficeTools; final after registerFiles. */
  structuredDocumentRuntime: ReturnType<typeof createStructuredDocumentRuntime> | null
  /** declared by registerWorkspaceRoutes; final after registerApiRoutes. */
  applyWorkflowDefinitionEdit: ValidatedDefinitionEditor | undefined
  /** declared by registerWorkspace; final after registerSyncWorkers. */
  syncWorkerRef: { tick(): Promise<void> } | null
}
