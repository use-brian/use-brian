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

## Reporting security issues

See [`SECURITY.md`](./SECURITY.md): please do **not** file security reports as
public issues.
