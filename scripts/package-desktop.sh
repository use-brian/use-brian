#!/usr/bin/env bash
#
# Build + sign + notarize the macOS desktop app (apps/app-desktop).
#
# Loads signing/notarization secrets from a gitignored `.env.desktop` at the repo
# root (copy `.env.desktop.example` to start), so you never paste them into your
# shell history. Must run on macOS with Xcode command-line tools installed.
#
#   ./scripts/package-desktop.sh                      # local signed + notarized .dmg/.zip
#   ./scripts/package-desktop.sh --publish            # the above, then publish a GitHub Release
#   ./scripts/package-desktop.sh --bump patch --publish   # bump 0.0.1 -> 0.0.2, build, publish
#   ./scripts/package-desktop.sh --version 1.0.0 --publish # set an exact version, build, publish
#   ./scripts/package-desktop.sh --no-build --publish # skip the build; (re)sign+notarize+upload existing release/ artifacts
#
# --bump/--version rewrite apps/app-desktop/package.json before the build but do
# NOT commit it — the run prints the git command to commit the bump.
#
# Spec: docs/architecture/features/app-desktop.md -> "Build, sign, ship (macOS)".
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env.desktop"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: signing + notarization only run on macOS (uname is $(uname -s))." >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: $ENV_FILE not found." >&2
  echo "       cp .env.desktop.example .env.desktop  and fill in the 5 values." >&2
  exit 1
fi

# Export every var defined in the env file without echoing the values.
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

PUBLISH=0
SKIP_BUILD=0
BUMP=""
SET_VERSION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --publish) PUBLISH=1 ;;
    --no-build|--skip-build) SKIP_BUILD=1 ;;
    --bump)
      BUMP="${2:-}"; shift
      [[ -z "$BUMP" ]] && { echo "error: --bump needs a level (patch|minor|major)" >&2; exit 1; } ;;
    --bump=*) BUMP="${1#--bump=}" ;;
    --version)
      SET_VERSION="${2:-}"; shift
      [[ -z "$SET_VERSION" ]] && { echo "error: --version needs a value (X.Y.Z)" >&2; exit 1; } ;;
    --version=*) SET_VERSION="${1#--version=}" ;;
    -h|--help)
      cat <<'USAGE'
usage: package-desktop.sh [--bump patch|minor|major | --version X.Y.Z] [--publish] [--no-build]
  --bump LEVEL     increment apps/app-desktop/package.json (patch|minor|major) before building
  --version X.Y.Z  set apps/app-desktop/package.json to an exact version before building
  --publish        (re)sign+notarize, then upload the dmg+zip+update feed to GitHub Releases
  --no-build       skip tsc + electron-builder; reuse existing release/ artifacts
The version change is written to package.json but NOT committed; the run prints
the git command to commit it. --bump/--version cannot combine with --no-build.
USAGE
      exit 0 ;;
    *) echo "error: unknown argument '$1' (try --help)" >&2; exit 1 ;;
  esac
  shift
done

# --bump and --version are mutually exclusive — one increments, the other sets.
if [[ -n "$BUMP" && -n "$SET_VERSION" ]]; then
  echo "error: pass either --bump or --version, not both." >&2
  exit 1
fi
# A version change only takes effect through a rebuild: the version is baked into
# the packaged app (app.getVersion()) AND drives the release tag, so bumping
# without rebuilding would tag v<new> around a binary that still reports <old>.
if [[ ( -n "$BUMP" || -n "$SET_VERSION" ) && "$SKIP_BUILD" == "1" ]]; then
  echo "error: --bump/--version require a build — drop --no-build (existing artifacts carry the old version)." >&2
  exit 1
fi
if [[ -n "$BUMP" && "$BUMP" != "patch" && "$BUMP" != "minor" && "$BUMP" != "major" ]]; then
  echo "error: --bump must be patch, minor, or major (got '$BUMP')." >&2
  exit 1
fi
if [[ -n "$SET_VERSION" && ! "$SET_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "error: --version must be X.Y.Z (got '$SET_VERSION')." >&2
  exit 1
fi

# Validate the required secrets are present (names only, never values).
required=(CSC_LINK CSC_KEY_PASSWORD APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID)
if [[ "$PUBLISH" == "1" ]]; then
  required+=(GH_TOKEN)
  command -v gh >/dev/null 2>&1 || {
    echo "error: 'gh' (GitHub CLI) is required for --publish. Install: brew install gh" >&2
    exit 1
  }
fi
missing=()
for var in "${required[@]}"; do
  [[ -z "${!var:-}" ]] && missing+=("$var")
done
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "error: missing values in .env.desktop: ${missing[*]}" >&2
  exit 1
fi

DMG="$REPO_ROOT/apps/app-desktop/release/usebrian.dmg"
ZIP="$REPO_ROOT/apps/app-desktop/release/usebrian.zip"
# The electron-updater feed: existing installs resolve the latest release, read
# latest-mac.yml, and download the zip (the blockmap enables differential
# downloads). electron-builder emits both alongside the artifacts because
# electron-builder.yml carries a `publish:` block.
FEED_YML="$REPO_ROOT/apps/app-desktop/release/latest-mac.yml"
ZIP_BLOCKMAP="$REPO_ROOT/apps/app-desktop/release/usebrian.zip.blockmap"
PKG_JSON="$REPO_ROOT/apps/app-desktop/package.json"

# Apply the version change BEFORE the build so the new version is baked into the
# packaged app and picked up by the tag computation in the publish step (which
# re-reads package.json). Rewrites the file only; committing is left to the user.
NEW_VERSION=""
if [[ -n "$BUMP" || -n "$SET_VERSION" ]]; then
  OLD_VERSION="$(node -p "require('$PKG_JSON').version")"
  NEW_VERSION="$(BUMP="$BUMP" SET_VERSION="$SET_VERSION" node -e '
    const fs = require("fs");
    const path = process.argv[1];
    const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
    let v = pkg.version;
    if (process.env.SET_VERSION) {
      v = process.env.SET_VERSION;
    } else {
      const [maj, min, pat] = v.split(".").map(Number);
      if (process.env.BUMP === "major") v = `${maj + 1}.0.0`;
      else if (process.env.BUMP === "minor") v = `${maj}.${min + 1}.0`;
      else v = `${maj}.${min}.${pat + 1}`;
    }
    pkg.version = v;
    fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
    console.log(v);
  ' "$PKG_JSON")"
  echo "==> Version $OLD_VERSION -> $NEW_VERSION (apps/app-desktop/package.json)"
fi

if [[ "$SKIP_BUILD" == "1" ]]; then
  echo "==> Skipping build (--no-build); reusing existing artifacts in release/"
  [[ -f "$DMG" ]] || {
    echo "error: $DMG not found — run once without --no-build to produce it." >&2
    exit 1
  }
else
  echo "==> Building app-desktop (tsc + asset copy)"
  pnpm --filter @use-brian/app-desktop run build
  echo "==> Packaging + signing + notarizing the app (Apple notary, a few min)"
  pnpm --filter @use-brian/app-desktop exec electron-builder --mac
fi

# electron-builder signs + notarizes + staples the .app (it submits the .zip),
# but leaves the .dmg WRAPPER unsigned + un-notarized. For Gatekeeper to accept a
# *downloaded* dmg on open, the dmg must itself be Developer-ID-signed AND
# notarized + stapled — a staple alone assesses as "no usable signature". So do
# the full sign -> notarize -> staple here. Idempotent: skip only if the dmg is
# already both signed AND stapled.
if codesign -dv "$DMG" >/dev/null 2>&1 && xcrun stapler validate "$DMG" >/dev/null 2>&1; then
  echo "==> dmg already signed + notarized + stapled"
else
  SIGN_ID="$(security find-identity -v -p codesigning | awk '/Developer ID Application/ {print $2; exit}')"
  if [[ -z "$SIGN_ID" ]]; then
    echo "error: no 'Developer ID Application' identity in keychain to sign the dmg." >&2
    exit 1
  fi
  echo "==> Signing the dmg (first run may prompt for keychain access — click 'Always Allow')"
  codesign --force --timestamp --sign "$SIGN_ID" "$DMG"
  echo "==> Notarizing the dmg (Apple notary, ~2-5 min)"
  xcrun notarytool submit "$DMG" \
    --apple-id "$APPLE_ID" \
    --password "$APPLE_APP_SPECIFIC_PASSWORD" \
    --team-id "$APPLE_TEAM_ID" \
    --wait
  echo "==> Stapling the dmg"
  xcrun stapler staple "$DMG"
fi
echo "==> Gatekeeper check (want: accepted / Notarized Developer ID):"
spctl -a -vv -t open --context context:primary-signature "$DMG" 2>&1 | head -3 || true

if [[ "$PUBLISH" == "1" ]]; then
  # Upload the NOTARIZED artifacts ourselves. We can't use electron-builder
  # --publish: it uploads during the build, before the dmg is notarized above.
  # Keep RELEASES_REPO in sync with electron-builder.yml's `publish` block.
  # The desktop source is open (apps/app-desktop in the public open-core repo),
  # so releases + the auto-update feed live on that same public repo.
  RELEASES_REPO="use-brian/use-brian"
  VERSION="$(node -p "require('$REPO_ROOT/apps/app-desktop/package.json').version")"
  TAG="v$VERSION"
  # A release without latest-mac.yml is INVISIBLE to auto-update on existing
  # installs - hard-require it. (The yml's dmg sha512 goes stale when we re-sign
  # the dmg after the build; harmless - macUpdater installs from the ZIP entry,
  # which is untouched after electron-builder hashed it.)
  [[ -f "$FEED_YML" ]] || {
    echo "error: $FEED_YML not found - rebuild without --no-build (electron-builder" >&2
    echo "       emits it via the publish config). Without it, existing installs" >&2
    echo "       cannot auto-update to this release." >&2
    exit 1
  }
  ASSETS=("$DMG" "$ZIP" "$FEED_YML")
  if [[ -f "$ZIP_BLOCKMAP" ]]; then
    ASSETS+=("$ZIP_BLOCKMAP")
  else
    echo "warn: $ZIP_BLOCKMAP not found - publishing without differential-download support."
  fi
  echo "==> Publishing $TAG to $RELEASES_REPO (uploading + marking latest)"
  if gh release view "$TAG" --repo "$RELEASES_REPO" >/dev/null 2>&1; then
    gh release upload "$TAG" "${ASSETS[@]}" --repo "$RELEASES_REPO" --clobber
    gh release edit "$TAG" --repo "$RELEASES_REPO" --draft=false --prerelease=false --latest
  else
    gh release create "$TAG" "${ASSETS[@]}" --repo "$RELEASES_REPO" \
      --title "$TAG" --notes "Use Brian desktop $TAG" --latest
  fi
  echo "==> Published: https://github.com/$RELEASES_REPO/releases/tag/$TAG"
  echo "    Download:  https://github.com/$RELEASES_REPO/releases/latest/download/usebrian.dmg"
fi

echo
echo "==> Done. Artifacts in apps/app-desktop/release/:"
ls -1 "$DMG" "$ZIP" 2>/dev/null || true

if [[ -n "$NEW_VERSION" ]]; then
  echo
  echo "==> Version bumped to $NEW_VERSION but NOT committed. Commit it:"
  echo "    git -C \"$REPO_ROOT\" add apps/app-desktop/package.json \\"
  echo "      && git -C \"$REPO_ROOT\" commit -m \"chore(app-desktop): release v$NEW_VERSION\""
fi
