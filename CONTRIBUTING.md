# Contributing to Use Brian

Thanks for your interest in contributing. A few things to know up front.

## License and the CLA

Use Brian is licensed under **AGPLv3** (see [`LICENSE`](./LICENSE)). To keep the
project sustainable we also offer a **commercial license** for organizations
that cannot accept AGPL's network-copyleft. That dual-license is only possible
if every contribution is covered by a **Contributor License Agreement (CLA)**.

- On your first pull request, the **CLA Assistant** bot will ask you to sign the
  [CLA](./CLA.md) by commenting on the PR. It is a one-time, broad **license
  grant** (not a copyright assignment): you keep ownership of your work.
- PRs cannot be merged until the CLA check is green.

If you contribute on behalf of an employer, make sure you have the authority to
agree to the CLA on their behalf.

## How we work (governance baseline)

- **PRs only, maintainer merge.** No one outside the maintainer team has commit
  access. All changes land through reviewed pull requests against `main`.
- **`main` is protected.** Required review + green CI; no force-push.
- **2FA is required** for the org. **Release tags are signed.**
- Be kind. Assume good faith. Keep discussion technical.

These are deliberately strict (the "xz" lesson): trust is earned over time, and
commit rights are not the price of a good patch.

## Long-term maintenance goals

- **Deliver the same features with less code to maintain.** Prefer one
  implementation of a shared rule and remove superseded paths and duplicate
  tests when their replacements cover the same behavior. Compare handwritten
  implementation and test lines over time. Track generated output separately.
- **Use session performance as the primary measure of product performance.**
  Measure how long a user waits to open or resume a session, see the first
  reply text after sending, and have the complete reply saved and available
  on reopen. Include established sessions with history and report failures
  alongside median and p95 timings.
- **Shorten the time from starting a fix to verifying it in a release.**
  Align local implementation checks, builds, CI and release on the same source,
  dependency versions and migration behavior. Release the build that passed
  verification. Track elapsed time across the whole change, including queues,
  retries and migration repairs, to identify where iteration slows down.

## Making a change

1. Open an issue first for anything non-trivial so we can align on approach.
2. Keep PRs focused. One logical change per PR.
3. This is a **doc-driven** codebase. When you change behavior, update the
   relevant spec in the same PR.
4. Run the test + smoke checks before pushing:
   ```bash
   pnpm test
   pnpm smoke
   ```
5. Use [Conventional Commits](https://www.conventionalcommits.org/) for commit
   messages.
6. Never put real-world data in tests, fixtures, or examples: no real names,
   email addresses, customer domains, phone numbers, or production IDs. Use
   fictional values instead (reserved `.example` domains, `555` phone numbers,
   invented names). Tests mock their boundaries, so fictional data behaves
   identically, and this is a public repo: a real value publishes someone's
   identity.

### Fast feedback while editing

From the project root, run `pnpm check:fast --check home-dock-contract` or
`pnpm check:fast --check teamspaces-contract` to exercise the browser SDK
against the corresponding HTTP route. To select checks for an edit, run
`pnpm check:fast --changed-file <path>`. Repeat `--changed-file` for each edited
file. CI runs every check before the build with `pnpm check:fast --all`.

Start Codex or Claude Code in this checkout with Node on your PATH. Trust the
workspace when prompted. In Codex, review and trust the hook in `/hooks`.
Claude Code lists the active project hook in `/hooks`. Codex patches and
Claude Edit or Write operations on registered files run the check automatically.
A failure gives the agent the test diagnostic and rerun command.

### SQL migration size

New files in `packages/api/migrations/` have a **64 KiB (65,536-byte)** limit.
Put the SQL that changes the database in the migration. When a verifier already
exists, reference a versioned copy instead of pasting its full text into each
successor. The size check recognizes historical oversized files by their exact
path and content.

The project editor hooks reject oversized file additions before a Codex patch
or Claude Write runs. They also check files after edits and shell commands.
Run `pnpm check:migration-size` to check the working tree, including generated
SQL. The build and CI run the same check. To enable the staged-file check on a
fresh clone, run `git config --local core.hooksPath .githooks` if you use Git's
default hooks. If you already use custom hooks, have your pre-commit hook run
`node scripts/hooks/check-migration-size.mjs --staged` and propagate its exit
status.

## Reporting security issues

See [`SECURITY.md`](./SECURITY.md): please do **not** file security reports as
public issues.
