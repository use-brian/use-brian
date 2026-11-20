# Organization cutover schema additions

The preceding schema is defined by the immutable migrations in
`packages/api/migrations/`. The organization cutover specification is
`docs/plans/complete-organization-cutover.md`.

| Migration | Schema behavior |
| --- | --- |
| `8171_department_mode_admission.sql` | Adds `classic_mode_admission_required(uuid)` and routes the superseded creation/session/setup admission selectors through it. V2 department enforcement remains active independently of setup completion; the flag-off model retains its existing admission protocol. No department RLS, source/parent check, immutable snapshot or configured-connector receipt is disabled. |
| `8172_organization_cutover.sql` | Adds dispatch lease identity/expiry fields to scheduled jobs, owner/session-bound organization cutover reviews, a policy completion receipt FK and a deferred atomic-apply check. Extends the existing schedule immutability guard only for a live reviewed conversion from NULL authoring snapshot to the exact unchanged workflow authority. All non-binding job fields and current saved actor/assistant must match; no dispatcher claim is minted. |

| `8173_department_office_publication.sql` | Extends immutable Office snapshot publication to session-bound v2 generation jobs. Retains the live job, parent ACL, file envelope, content hash and storage path checks. |

## Migration owner validation

Migration replay checks preserve the schema contract at each tested boundary.
Skill receipt revisions keep RLS enabled throughout. Historical boundaries before
`82200_skill_scope_owner_access.sql` require FORCE RLS; current schemas retain the
owner access deliberately restored by that migration and require NO FORCE RLS.
Application roles remain ordinary non-owner roles, with no superuser or BYPASSRLS
privileges. The owner-access regression executes the actual repair and verifies
that application reads still filter rows and direct receipt writes remain denied.
Trigger restoration and migration replay/idempotency checks stay required.

## Memory lineage upgrade

The published `8268_native_memory_query_write_lineage.sql` remains available
byte-for-byte in `packages/api/scripts/conversation-store/historical/`. An
installation that previously ran it keeps its original ledger row and timestamp.
Fresh installations record the composed `8326_native_memory_query_write_contract.sql`
when it runs. The archived file never stands in for the new migration.

On the upstream upgrade path, the reviewed 8272 execution adapter authenticates
the installed 8268 Memory routines, their comparator owners and the registry
before reconciling them inside 8272's transaction. The unchanged publication
installer then authenticates its canonical predecessor. 8326 installs the current
Memory writer and both frozen-query comparators. It preserves the staged-source
checks and requires an empty, owner-only intent table outside an active write.
The native runner commits each of these migrations with its own ledger row.

The managed launcher holds its exclusive native lease through migration,
installation authentication and application-role activation. For manual
PostgreSQL upgrades, stop application processes that use the database before
running the owner migration, then restart them after the migration succeeds.
The earlier frozen-reader semantics can reject a write using its own newly
derived output until 8326 is installed.
