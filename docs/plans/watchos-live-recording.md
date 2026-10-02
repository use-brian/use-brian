# Watch recording: repository split

The phone and watch clients live in **[use-brian/brian-mobile](https://github.com/use-brian/brian-mobile)**, not in an `apps/app-mobile` subtree of this repository.

- Mobile worktree: `/workspace/brian-mobile-watchos`, branch `feat/watchos-live-recording`, based on `brian-mobile/main`.
- API/web-auth worktree: `/workspace/use-brian-watchos-api`, branch `feat/watchos-recording-api`, based on `use-brian/develop`.
- Full implementation/acceptance plan: [brian-mobile/docs/watchos-live-recording.md](https://github.com/use-brian/brian-mobile/blob/feat/watchos-live-recording/docs/watchos-live-recording.md).
- Mobile verification and migration history: [brian-mobile/MIGRATION.md](https://github.com/use-brian/brian-mobile/blob/feat/watchos-live-recording/MIGRATION.md).

## This repository owns

- Mobile browser authorization confirmation and client/redirect-bound PKCE redemption: [mobile-auth-contract.md](mobile-auth-contract.md).
- Scoped device grants, owner recovery relay, durable audio receipt, full-file fallback, canonical recording intake/processing and retention: [WATCH_RECORDING_API.md](../../packages/api/WATCH_RECORDING_API.md).
- Migrations `650_watch_recording.sql` and `651_mobile_auth.sql`; opt-in deployment configuration in `.env.example`.

No Flutter, Android, iOS, watchOS source or mobile CI is included in this API branch. The earlier unpublished combined branch remains as a local backup (`backup/watchos-monorepo-before-split`) and is not the PR source.

## Verification

Before the split: full API/web typechecks, 102 API tests (including real PostgreSQL concurrency and ffmpeg), 19 browser-auth tests, six real PostgreSQL mobile-auth tests and two full-schema canonical-intake/processing tests passed. The split cherry-picks those exact server changes without modifications; migrated-tree checks are rerun before delivery. Physical Apple hardware, Apple SDK and target-deployment provider/gateway acceptance remain external gates, not proven by these server tests.
