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
