#!/usr/bin/env bash
#
# Publish the Windows desktop installer (apps/app-desktop) to the public releases
# repo so the marketing "Download for Windows" CTA resolves.
#
# Unlike the macOS path, Windows signing is NOT done here — sign the exe first
# (Phase 5: Azure Trusted Signing / SSL.com eSigner), then run this to upload.
# Runs anywhere with `gh` + the exe: on the Mac (no Windows machine) via --from-ci,
# which downloads the installer the `desktop-windows-beta.yml` workflow built on a
# windows-latest runner; or in a Windows build VM after a local `package:win`.
#
#   scripts/publish-windows.sh --from-ci --allow-unsigned  # grab the latest CI build + publish a beta
#   scripts/publish-windows.sh --allow-unsigned            # publish a locally-built UNSIGNED beta
#   scripts/publish-windows.sh                             # upload a SIGNED exe to the v<version> release
#   scripts/publish-windows.sh --exe path/to/usebrian.exe
#
# The exe joins the SAME `v<version>` release as the macOS dmg/zip, so one "latest"
# release carries every platform. Build the Windows app at the SAME version as the
# current macOS "latest" — otherwise they land on separate releases and only the
# newest is "latest" (then the older platform's asset 404s under latest/download).
# Needs gh authenticated (or GH_TOKEN) with contents:write on the repo. Keep
# RELEASES_REPO in sync with electron-builder.yml's `publish` block + package-desktop.sh.
#
# Spec: docs/architecture/features/app-desktop.md -> "Build, sign, ship (Windows)".
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASES_REPO="use-brian/use-brian"
PKG_JSON="$REPO_ROOT/apps/app-desktop/package.json"
EXE="$REPO_ROOT/apps/app-desktop/release/usebrian.exe"
ALLOW_UNSIGNED=0
FROM_CI=0
EXE_EXPLICIT=0
CI_WORKFLOW="desktop-windows-beta.yml"
CI_ARTIFACT="usebrian-windows-unsigned"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --allow-unsigned) ALLOW_UNSIGNED=1; shift ;;
    --from-ci) FROM_CI=1; shift ;;
    --exe) EXE="$2"; EXE_EXPLICIT=1; shift 2 ;;
    -h|--help)
      echo "usage: $0 [--from-ci] [--allow-unsigned] [--exe <path>]"
      echo "  --from-ci          download usebrian.exe from the latest successful '$CI_WORKFLOW' run, then publish"
      echo "  --allow-unsigned   publish even if the exe's signature can't be verified (a deliberate beta)"
      echo "  --exe <path>       the built installer (default: apps/app-desktop/release/usebrian.exe)"
      exit 0 ;;
    *) echo "error: unknown argument '$1' (try --help)" >&2; exit 1 ;;
  esac
done

command -v gh >/dev/null 2>&1 || {
  echo "error: 'gh' (GitHub CLI) is required. Install https://cli.github.com (or 'winget install GitHub.cli')." >&2
  exit 1
}
gh auth status >/dev/null 2>&1 || [[ -n "${GH_TOKEN:-}" ]] || {
  echo "error: gh is not authenticated. Run 'gh auth login' or set GH_TOKEN (needs contents:write on $RELEASES_REPO)." >&2
  exit 1
}

# --from-ci: pull the installer the windows-latest workflow built (no Windows
# machine needed). `gh run` reads THIS repo's Actions from the cwd git context (the
# monorepo); the release upload below still targets RELEASES_REPO.
if [[ "$FROM_CI" == "1" ]]; then
  [[ "$EXE_EXPLICIT" == "0" ]] || {
    echo "error: --from-ci and --exe are mutually exclusive." >&2
    exit 1
  }
  echo "==> Finding the latest successful '$CI_WORKFLOW' run..."
  RUN_ID="$(gh run list --workflow "$CI_WORKFLOW" --status success --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null || true)"
  [[ -n "$RUN_ID" ]] || {
    echo "error: no successful '$CI_WORKFLOW' run found. Trigger it and wait for it to finish:" >&2
    echo "       gh workflow run $CI_WORKFLOW" >&2
    exit 1
  }
  CI_DIR="$(mktemp -d)"
  trap 'rm -rf "$CI_DIR"' EXIT
  echo "==> Downloading '$CI_ARTIFACT' from run $RUN_ID..."
  gh run download "$RUN_ID" -n "$CI_ARTIFACT" -D "$CI_DIR"
  EXE="$(find "$CI_DIR" -name 'usebrian.exe' -type f | head -n1)"
  [[ -n "$EXE" ]] || {
    echo "error: '$CI_ARTIFACT' did not contain usebrian.exe." >&2
    exit 1
  }
  echo "==> Using CI build: $EXE"
fi

[[ -f "$EXE" ]] || {
  echo "error: $EXE not found. Build it first on Windows: pnpm --filter @use-brian/app-desktop package:win" >&2
  exit 1
}

# The Windows electron-updater feed lives NEXT TO the exe (electron-builder
# emits latest.yml + the blockmap alongside it; the CI artifact carries all
# three). Without latest.yml the release still downloads fine from the CTA,
# but existing installs cannot SEE it - warn rather than refuse so an older
# feed-less CI artifact can still ship a deliberate beta.
EXE_DIR="$(cd "$(dirname "$EXE")" && pwd)"
WIN_YML="$EXE_DIR/latest.yml"
EXE_BLOCKMAP="$EXE_DIR/usebrian.exe.blockmap"

# Best-effort signature check (portable). Authenticode can't be verified on every
# host, so detect where we can and otherwise require an explicit opt-in — never
# silently push an unsigned exe to the public download CTA.
SIGNED="unknown"
if command -v osslsigncode >/dev/null 2>&1; then
  if osslsigncode verify "$EXE" 2>/dev/null | grep -qi "signature verification: ok"; then
    SIGNED="yes"
  else
    SIGNED="no"
  fi
elif command -v powershell.exe >/dev/null 2>&1; then
  status="$(powershell.exe -NoProfile -Command "(Get-AuthenticodeSignature '$EXE').Status" 2>/dev/null | tr -d '\r' || true)"
  [[ "$status" == "Valid" ]] && SIGNED="yes" || SIGNED="no"
fi

if [[ "$SIGNED" != "yes" && "$ALLOW_UNSIGNED" != "1" ]]; then
  echo "error: the installer is not a verified signed build (detection: $SIGNED)." >&2
  echo "       Windows SmartScreen will warn users on a public download. Sign it first" >&2
  echo "       (Phase 5: Azure Trusted Signing / SSL.com eSigner), or pass --allow-unsigned" >&2
  echo "       to publish a deliberate beta." >&2
  exit 1
fi
if [[ "$SIGNED" == "yes" ]]; then
  echo "==> Installer signature: verified"
else
  echo "==> Publishing UNSIGNED installer (--allow-unsigned) — SmartScreen will warn users"
fi

ASSETS=("$EXE")
if [[ -f "$WIN_YML" ]]; then
  ASSETS+=("$WIN_YML")
  if [[ -f "$EXE_BLOCKMAP" ]]; then
    ASSETS+=("$EXE_BLOCKMAP")
  fi
else
  echo "warn: latest.yml not found next to the exe - publishing WITHOUT the Windows" >&2
  echo "      auto-update feed (existing installs won't see this release)." >&2
fi

VERSION="$(node -p "require('$PKG_JSON').version")"
TAG="v$VERSION"
echo "==> Publishing $EXE to $RELEASES_REPO@$TAG (joining the macOS release; marking latest)"
if gh release view "$TAG" --repo "$RELEASES_REPO" >/dev/null 2>&1; then
  gh release upload "$TAG" "${ASSETS[@]}" --repo "$RELEASES_REPO" --clobber
  gh release edit "$TAG" --repo "$RELEASES_REPO" --draft=false --prerelease=false --latest
else
  gh release create "$TAG" "${ASSETS[@]}" --repo "$RELEASES_REPO" \
    --title "$TAG" --notes "Use Brian desktop $TAG (Windows)" --latest
fi
echo "==> Done. The 'Download for Windows' CTA resolves once propagated:"
echo "    https://github.com/$RELEASES_REPO/releases/latest/download/usebrian.exe"
