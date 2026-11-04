# Action-start permission snapshots

## Implementation status

Native web chat now uses one `RequestPermissionContext` for action permission
selection and response delivery admission. Its public methods are `beforeAction`,
`authorizeDelivery` and `dispose`. The delivery path uses this owner, including
cleanup of its single invalidation subscription.

The action executor does not yet invoke `beforeAction` to switch executions.
Existing authority leases, database authorization, source admission and publication
checks remain in force. This change does not yet enable relaxed action-start
permission semantics in production.

The next action-runtime change must pass a selected snapshot to every permission
projection used by an action. Replacing only flat tool fields is not sufficient:
execution objects are frozen, nested access wrappers intersect their grants,
and application transactions have their own execution bindings.

## Agreed behavior

An invalidation event marks a request's snapshot dirty. It does not fetch
permissions, cancel an action or inspect completed work.

Immediately before the next action, refresh once if dirty. Otherwise reuse the
snapshot. Keep the selected value for that action. Changes received after
selection apply to a later action.

```text
A -> permission decrease -> refresh -> B -> C
A -> B starts -> permission decrease -> B finishes -> refresh -> C
A -> four permission decreases -> one refresh -> B -> C
```

Completed actions remain completed. Their captured results remain available for
calculation. A new data read must use the next action's selected permissions.
If that read is no longer allowed, replan that action without repeating completed
side effects. Delivery authorization stays separate.

## Components

- `packages/api/src/context-scope/request-permission-context.ts` is the public
  request owner. It reuses the action provider's exact selected snapshot and
  derives delivery admission from it. A new selection clears old delivery
  receipts, while retaining registered executions for admitted in-flight work.
- `packages/api/src/context-scope/action-permission-snapshots.ts` is an internal
  cache for the dirty flag, shared refresh promise and deadline. It has no
  delivery state.
- `packages/api/src/context-scope/execution-permission-snapshots.ts` is the
  internal provider that reuses `resolveExecutionContextSystem`. It returns a
  new execution and a detached, frozen turn scope on refresh. It retains trusted
  identity and binding facts; it does not accept a model-supplied permission result.
- `packages/api/src/context-scope/response-delivery-admission.ts` stores internal
  delivery receipts for the selected execution, destination and evidence. It
  owns no permission loader, invalidation subscription or refresh lifecycle.
  `response-permission-snapshot.ts` provides compatibility aliases only.
- `packages/api/src/context-scope/permission-events.ts` routes workspace and
  global invalidations through the existing shared PostgreSQL listener.
- Migration `8208_permission_snapshot_events.sql` emits a dedicated notification
  when existing workspace or contract policy epoch rows change. It uses those
  tables as change-notification seams; the cache does not compare revisions.

The native chat host creates one request context with the initial trusted
execution and an internal action provider. The request owns disposal on every
exit, including normal completion; abort also disposes it.

At future action-runtime integration, call `beforeAction()` at actual admission,
after any queue or confirmation wait. Hold its returned value for the entire
action. The provider subscribes before its first lazy refresh, so events cannot
be lost between refresh and subscription.

The cache accepts existing immutable snapshot values. It does not construct or
mutate grants. Only the internal execution adapter calls the trusted resolver.
`authorizeDelivery()` never refreshes permissions: it consumes an execution
already selected by this request. A foreign execution or copied request object
cannot use its cached delivery admission. A delivery failure stays invalid even
after action permissions refresh.

## Refresh rules

- Multiple events set one dirty flag. They do not schedule background work.
- Parallel action admissions share one pending refresh.
- Clear the consumed dirty flag before starting the load, not after it finishes.
  An event received during that load remains pending for the following action.
  Do not retry the current load just because another event arrived.
- A failed refresh cannot fall back to the old grant. Leave the cache dirty.
- Do not use a fixed refresh interval. The execution adapter reads the earliest
  future grant start or expiry before resolving the scope. At that deadline,
  the next action refreshes even if no row was changed and no event was emitted.
- If a deadline passes during loading, refuse that admission. A later action
  can load current permissions; there is no automatic refresh loop.

## Transport failure

PostgreSQL notifications are commit-coupled but are not a durable event log.
A disconnected listener cannot replay notifications it missed.

The listener reports channel readiness only after `LISTEN` succeeds. Connection
loss makes all subscribed snapshots dirty and unavailable for new actions.
Reconnection marks them dirty again. The next action must load permissions;
a ready connection alone never proves a snapshot is current. Malformed event
payloads conservatively invalidate all snapshots.

This design accepts notification delay. It does not guarantee a maximum stale
access window while the connection appears healthy.

The local single-process PGLite transport does not provide the same notification
coverage. It is explicitly ineligible for this cache. Keep the existing live
checks there until a reliable local invalidation source is implemented.

## Remaining runtime integration

Do not turn off existing live checks merely because the cache is present.
Complete and test these changes before enabling action-start semantics:

1. Select an execution snapshot after tool queue/confirmation waits, including
   permission-sensitive pre-execution gates.
2. Propagate the selected access, mutation grants, write defaults and source
   bindings through canonical and legacy tool contexts without retaining a
   stale outer intersection.
3. Separate action-start permission selection from credential/session integrity,
   source retention, database admission and destination authorization.
4. Return a recoverable denial for a newly forbidden action. Continue planning
   without replaying completed work or treating uncertain effects as incomplete.
5. Support captured-result reuse at later model calls without treating it as
   permission to fetch another source or publish to a different audience.
6. Reconcile the selected action lifetime with live SQL policies and application
   transaction bindings. The current database rules can still refuse an
   in-flight action after permission removal.

## Coverage

Unit tests cover lazy loading, burst coalescing, unchanged-snapshot reuse,
parallel starts, changes during loading, held snapshot stability, failure
recovery, deadlines, disposal, abort and disconnect/reconnect handling. Adapter
tests verify reuse of the existing execution resolver and detached scope facts.
The SQL harness verifies the notification triggers and transaction rollback.
Mocked listener tests verify shared-connection readiness and reconnection.
Request-owner tests cover shared snapshot reuse, cleared delivery receipts,
in-flight delivery races, exact ownership, private/shared audiences, live
connector fallback, sticky refusal and disposal. Kernel tests verify that the
sink uses the exact request-owned delivery method, not a copied callback.

Live PostgreSQL notification delivery and end-to-end chat replanning are not
covered by this implementation stage.
