# Workspace module contract

Workspace modules let a deployment add an optional product surface without tying its lifecycle to Home navigation, assistant grants, or a particular tenant. The default registry is empty after Association retirement. Deployments can supply their own explicit module registry.

## Extension seam

A module integrates through four pieces:

1. Register a stable key and default lifecycle state with `defineWorkspaceModuleRegistry`.
2. Pass that registry to `createWorkspaceModulesStore` and `workspaceModuleRoutes`.
3. Optionally provide a lifecycle adapter whose `readBlockingWork` reports nonnegative named counts that must reach zero before a drain can finish.
4. Lock the module first in any domain transaction that creates new work, then call `requireWorkspaceModuleAdmission`. Reads and recovery of existing records remain available while the module is draining or disabled.

The shared store owns authorization, optimistic versions, state transitions, audit records, lazy provisioning, and transaction locking. The shared route owns registry discovery and lifecycle actions at `/api/workspaces/:workspaceId/modules/:moduleKey/actions`. Adding a registered module does not require editing another module's storage, services, or route paths.

The database accepts stable module keys matching `^[a-z][a-z0-9_-]{0,62}$`. Application registries remain the admission boundary, so an arbitrary database key does not become a callable module. Migration `551_workspace_module_registry.sql` widens only the storage constraint and remains append-only.

## Association retirement

Association is no longer registered or exposed by the app/API. Migration 8270
removes its lifecycle rows and disables future provisioning. Its key cannot be
re-enabled through the generic lifecycle API. Historical compatibility helpers
remain only where shared CRM storage and migration tests still depend on them.

## Portability proof

The shared contract test creates an independent registry. The API route test sends a lifecycle action to a test-only second module and verifies its compatibility projection. The PostgreSQL integration test registers that module, observes a version-zero missing state, enables it, drains it against a custom blocker, and finishes disablement after the blocker clears. Those tests import no Association service code for the second module.

Deployment-specific manifests, source mappings, provider credentials, tenant prices, policy, and migration orchestration belong in the consuming deployment repository. Brian accepts parameterized manifests and provider-neutral lineage; it does not own the consumer's source-system extraction or cutover decisions.
