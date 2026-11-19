/** [COMP:platform/managed-postgres] Managed local PostgreSQL runtime. */
export { resolveManagedPostgresArtifact, verifyManagedPostgresArtifact, managedPostgresBinaries, type ManagedPostgresArtifact, type ManagedPostgresBinaries } from './artifact.js'
export { managedNativeChildEnvironment, managedClientConfig, isLibpqEnvironmentKey, withoutAmbientDatabaseEnvironment, type ManagedClientConfig } from './environment.js'
export { acquireManagedFence, type ManagedFence, type ManagedNativeAction } from './fence.js'
export { authenticateManagedInstance, readManagedPostmaster, readControlSystemIdentifier, type ManagedInstance, type ManagedPostmaster } from './instance.js'
export { authenticateNativeControl, prepareNativeControl, readNativeDisposition, requestNativeStop } from './control.js'
export {
  LIFECYCLE_FENCE_SOURCE_SHA256, MANAGED_POSTGRES_PGVECTOR_VERSION, MANAGED_POSTGRES_POSTGRESQL_VERSION,
  MANAGED_POSTGRES_PROFILE, MANAGED_POSTGRES_SOURCES, managedPostgresRelease, type ManagedPostgresRelease,
} from './release.js'
export { canonicalProfile, startManagedPostgres, type ManagedAdmissionUrls, type ManagedPostgres, type ManagedPostgresOptions, type ManagedTransferAttempt } from './runtime.js'
export {
  MANAGED_TRANSFER_PHASES, discardManagedTransferWork, finalizeManagedTransfer, legacyBrainPresent, managedTransferEnabled, managedTransferPaths, prepareManagedTransfer, readTransferJournal,
  readTransferKey, transferRefusal, treeDigest, type ManagedTransferExport, type ManagedTransferJournal, type ManagedTransferPhase, type ManagedTransferPlan,
} from './transfer.js'
export type { ManagedClient, ManagedClientConstructor, ManagedQueryable } from './types.js'
