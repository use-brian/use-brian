# Disposable database fixtures

`local-fixture.mjs` creates a fresh loopback PostgreSQL 18 cluster with an
ordinary owner and the non-owner `app_user`, applies the shipped migrations and
disposes the cluster afterwards. It never uses an ambient or personal database.
See `docs/workflow/testing.md` in the platform repository.

Genuine upgrade drivers seed a historical shape at an explicit `beforeApplyFile`
boundary, finish the chain through the maintained runner, then run one suite:

- `channel-recording-upgrade.mjs --pg-bin <pg18-bin>`: pre-8135 channel recordings for
  `channel-recording-privacy.integration.test.ts`.
- `private-history-upgrade.mjs --pg-bin <pg18-bin>`: pre-8203 private legacy history.
- `native-publication-upgrade.mjs --pg-bin <pg18-bin> [--compact|--graph]`: the
  authenticated native publication upgrade profiles.
