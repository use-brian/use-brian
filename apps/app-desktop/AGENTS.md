# Desktop application

The desktop app is the primary offline client. Offline and unstable-network use
is a product requirement for design, implementation and review.

In the platform authoring checkout, read
`docs/product-roadmap/offline-and-unstable-network.md`,
`docs/architecture/features/app-desktop.md` and
`docs/architecture/features/account-entry.md` before changing this package.
The renderer is shared with `apps/app-web`; read its package manual when
changing shared UI. This summary also applies in a standalone OSS checkout.

- After prior verified admission, packaged startup and installed navigation
  must work from local assets without a successful network request.
- Transport failures, timeouts, rate limits, server errors and unfinished token
  refresh cannot eject an admitted workspace, clear credentials, open OAuth or
  force account selection. Confirmed authority rejection still applies.
- Preserve durable documents, drafts and recording capture through offline
  use, sleep and restart. New persistent operations need a scoped local save
  and recovery design. Keep failures with the affected operation.
- Restore safe synchronization automatically with bounded retries, identity
  isolation, conflict preservation and reconciliation of uncertain outcomes.
  Never replay an uncertain external effect or send an unsent draft silently.
- Verify applicable network-loss, timeout/503, flapping, account-switch and
  reconnect cases. Packaged cold-start, sleep/wake and restart persistence
  require actual native evidence; unit tests alone do not certify them.
- The OSS `offline-continuity` CI lane is mandatory. Missing offline coverage
  is unfinished product work, not an exception to the requirement.

Keep this file and `CLAUDE.md` identical. Tests use existing `[COMP:...]` tags
registered in the platform's `docs/workflow/component-map.md`.
