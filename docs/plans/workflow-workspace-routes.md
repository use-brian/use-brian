# Workspace-scoped workflow editing

Authenticated clients restricted to one workspace need the normal workflow
inspection and context-editing commands within that workspace's URL scope.
GET and PATCH `/api/workspaces/:workspaceId/workflows/:id` and POST
`/api/workspaces/:workspaceId/workflows/:id/schedule-review` use the existing
workflow handlers. The original routes remain available.

The workflow must belong to the URL workspace. A mismatch returns the same 404
as a missing or inaccessible workflow, before trigger-job inspection, authority
capture, schedule preparation or mutation. Existing RLS, readiness, authority,
schedule-review, connector and audit behavior remains mandatory. The aliases
add no authoring or read privileges and do not rewrite historical run context.
