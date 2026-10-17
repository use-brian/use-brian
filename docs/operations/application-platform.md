# Application platform implementation evidence

The shared application platform is under implementation. App-data credentials,
non-member releases, delegated source trust and protected retention are unavailable
until the required authority and every-consumer runtime acceptance barrier passes.
Existing chat/Brain/Home credentials retain their current contract.

The canonical engineering contract lives in the platform repository at
`docs/architecture/features/application-platform.md`; the locked execution Goal is
`docs/plans/shared-application-platform-implementation.md`.

P0 acceptance blueprints are in
`packages/api/src/application-platform/__tests__/fixtures/{acceptance,subjects}.json`.
They contain only synthetic identities and required case descriptions, not passing
results. A01-A22 need real non-bypass PostgreSQL/RLS, authenticated HTTP, source
ACL/revocation, migration and browser evidence; pending/skipped evidence cannot
qualify a capability. The disposable fixture must validate its ownership marker
before connecting. No provider credentials or paid model runs are needed.

Full pre-change logs remain in `output/application-platform/baseline-20261018/`.
Publication, production migrations, deployment activation, actual identity/source
mapping, historical qualification and provider acceptance are operator work.

## P1 foundations

Strict wire/value/module contracts live in shared/core application-platform source.
The API dispatcher composes typed module commands, current-member RLS, canonical
writes, immutable content-free receipts, audit and committed events. Retries bind
actor/assistant, input and idempotency key, and reauthorize current result sources.
An uncertain COMMIT returns `outcome_uncertain`, without automatic effect replay.

Migration 8002 adds generic validation, normalized opt-in uniqueness, monotonic
revisions, saved schema reviews and current-member operation floors. It preserves
canonical record IDs and legacy numeric shapes. Generic filters use cell values;
sort-aware cursors bind schema/query identity. Native CRM/task adapters call the
existing writers and source reader on a non-owner transaction.

The reserved migration range is 8000-8009, corrected from 3947-3954 because the
runner orders filenames lexically. Applied migrations are unchanged. No general
app-data auth, delegated source trust, public discovery or protected retention is
activated by these foundations. P2-P6 and the complete consumer ledger remain owed.

## P3 actor protocol checkpoint

The Node-only `@use-brian/brian-app/connector` export verifies exact request-bound
Ed25519 identity with pinned keys, bounded replay and a canonical source permission
callback. Migration 8005 stores independently generated encrypted deployment keys;
the public well-known JWKS exposes only public material. Rotation/revoke and actual
MCP byte signing are exercised on the guarded local fixture. The complete application
fixture now has 74 passing cases and no skipped feature cases; the SDK has 52 cases
and focused signer/header/MCP regressions have 135. These overlapping local checks
do not certify the source ACL or all-consumer acceptance matrix.

Protected discovery/runtime Department admission, source evidence/retention, complete
consumer revalidation, management and reference journeys remain pending. No startup
key generation, trust setup route or activation bypass is introduced by this checkpoint.
Both offline frozen lockfile-only installs pass without lockfile changes. Existing
identity opt-ins now include the stable executing-assistant header; untrusted static,
custom-auth and dynamic header layers cannot replace reserved identity assertions.
