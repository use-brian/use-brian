/**
 * Scope types threaded through the ordered boot register modules.
 *
 * Each `<Step>Scope` is what that register step receives: the root inputs plus
 * every earlier step's returned bindings and the bindings the composition root
 * declares between steps. Type-only; see packages/api/src/boot.ts.
 */
import type { BootOpenApiOptions, OpenApiEnv, OpenApiPorts } from '../boot.js'
import type { BootLate } from './late.js'
import type { registerOverlaySeams } from './overlay-seams.register.js'
import type { registerHttp } from './http.register.js'
import type { registerRuntime } from './runtime.register.js'
import type { registerStores } from './stores.register.js'
import type { registerProviders } from './providers.register.js'
import type { registerConnectors } from './connectors.register.js'
import type { registerAuth } from './auth.register.js'
import type { registerWorkspace } from './workspace.register.js'
import type { registerTools } from './tools.register.js'
import type { registerOfficeTools } from './office-tools.register.js'
import type { registerCapture } from './capture.register.js'
import type { registerAssistants } from './assistants.register.js'
import type { registerWorkflow } from './workflow.register.js'
import type { registerPrimitives } from './primitives.register.js'
import type { registerFiles } from './files.register.js'
import type { registerComputerUse } from './computer-use.register.js'
import type { registerChatRoutes } from './chat-routes.register.js'
import type { registerIntegrationRoutes } from './integration-routes.register.js'
import type { registerSessionRoutes } from './session-routes.register.js'
import type { registerWorkspaceRoutes } from './workspace-routes.register.js'
import type { registerOfficeRoutes } from './office-routes.register.js'
import type { registerWorkflowEvents } from './workflow-events.register.js'
import type { registerWorkers } from './workers.register.js'
import type { registerLearningWorkers } from './learning-workers.register.js'
import type { registerMemoryWorkers } from './memory-workers.register.js'
import type { registerRecordingWorkers } from './recording-workers.register.js'
import type { registerSyncWorkers } from './sync-workers.register.js'
import type { registerBootContext } from './boot-context.register.js'
import type { registerLifecycle } from './lifecycle.register.js'

type Out<F extends (scope: never) => unknown> = Awaited<ReturnType<F>>

/** The composition root's own inputs: options, env, ports and the late-binding table. */
export interface RootScope {
  opts: BootOpenApiOptions
  env: OpenApiEnv
  ports: OpenApiPorts
  late: BootLate
}

export type OverlaySeamsScope = RootScope
export type HttpScope = OverlaySeamsScope & Out<typeof registerOverlaySeams> & { runWorkers: boolean }
export type RuntimeScope = HttpScope & Out<typeof registerHttp>
export type StoresScope = RuntimeScope & Out<typeof registerRuntime>
export type ProvidersScope = StoresScope & Out<typeof registerStores>
export type ConnectorsScope = ProvidersScope & Out<typeof registerProviders>
export type AuthScope = ConnectorsScope & Out<typeof registerConnectors>
export type WorkspaceScope = AuthScope & Out<typeof registerAuth>
export type ToolsScope = WorkspaceScope & Out<typeof registerWorkspace>
export type OfficeToolsScope = ToolsScope & Out<typeof registerTools>
export type CaptureScope = OfficeToolsScope & Out<typeof registerOfficeTools>
export type AssistantsScope = CaptureScope & Out<typeof registerCapture>
export type WorkflowScope = AssistantsScope & Out<typeof registerAssistants>
export type PrimitivesScope = WorkflowScope & Out<typeof registerWorkflow>
export type FilesScope = PrimitivesScope & Out<typeof registerPrimitives>
export type ComputerUseScope = FilesScope & Out<typeof registerFiles>
export type ChatRoutesScope = ComputerUseScope & Out<typeof registerComputerUse>
export type IntegrationRoutesScope = ChatRoutesScope & Out<typeof registerChatRoutes>
export type SessionRoutesScope = IntegrationRoutesScope & Out<typeof registerIntegrationRoutes>
export type WorkspaceRoutesScope = SessionRoutesScope & Out<typeof registerSessionRoutes>
export type PublicRoutesScope = WorkspaceRoutesScope & Out<typeof registerWorkspaceRoutes>
export type ApiRoutesScope = PublicRoutesScope
export type OfficeRoutesScope = ApiRoutesScope
export type BrainRoutesScope = OfficeRoutesScope & Out<typeof registerOfficeRoutes>
export type WorkflowEventsScope = BrainRoutesScope
export type WorkersScope = WorkflowEventsScope & Out<typeof registerWorkflowEvents>
export type LearningWorkersScope = WorkersScope & Out<typeof registerWorkers>
export type MemoryWorkersScope = LearningWorkersScope & Out<typeof registerLearningWorkers>
export type RecordingWorkersScope = MemoryWorkersScope & Out<typeof registerMemoryWorkers>
export type SyncWorkersScope = RecordingWorkersScope & Out<typeof registerRecordingWorkers>
export type BootContextScope = SyncWorkersScope & Out<typeof registerSyncWorkers>
export type ChannelsScope = BootContextScope & Out<typeof registerBootContext>
export type LifecycleScope = ChannelsScope
