#!/usr/bin/env bash
#
# Build and optionally publish the Chromium extension through Chrome Web Store
# API v2. Building is the safe default. Store upload + review submission require
# --publish and an interactive confirmation (or the deliberate --yes flag).
#
# Spec: docs/workflow/browser-extension-release.md
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXTENSION_ROOT="$REPO_ROOT/apps/browser-extension"
MANIFEST="$EXTENSION_ROOT/static/manifest.json"
DIST="$EXTENSION_ROOT/dist"
BUILD_STAMP_SOURCE="$REPO_ROOT/packages/shared/src/browser-extension-build.ts"
DEFAULT_EXTENSION_ID="nnmbbacnkekaoccmkmlfaghjaamgdpjn"
EXTENSION_ID="${CHROME_WEB_STORE_EXTENSION_ID:-$DEFAULT_EXTENSION_ID}"
OAUTH_SCOPE="https://www.googleapis.com/auth/chromewebstore"

PUBLISH=0
AUTO_PUBLISH=0
YES=0
OFFLINE=0
ALLOW_DIRTY=0
OUTPUT=""

usage() {
  cat <<'EOF'
usage: scripts/publish-browser-extension.sh [options]

Build, test, Store-version-check, and package the Chromium extension. This is
artifact-only unless --publish is present.

Options:
  --publish        upload the ZIP and submit it for Chrome Web Store review
  --auto-publish   publish automatically after approval (requires --publish)
  --yes            skip the exact interactive release confirmation
  --offline        skip the public Store-version check (cannot publish)
  --allow-dirty    allow a dirty extension tree for a local artifact (cannot publish)
  --output <path>  write the ZIP at this path
  -h, --help       show this help

Publishing requires CHROME_WEB_STORE_PUBLISHER_ID and one of:
  CHROME_WEB_STORE_ACCESS_TOKEN
  CHROME_WEB_STORE_SERVICE_ACCOUNT (uses gcloud impersonation)
  CHROME_WEB_STORE_CLIENT_ID + CHROME_WEB_STORE_CLIENT_SECRET +
    CHROME_WEB_STORE_REFRESH_TOKEN
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --publish) PUBLISH=1; shift ;;
    --auto-publish) AUTO_PUBLISH=1; shift ;;
    --yes) YES=1; shift ;;
    --offline) OFFLINE=1; shift ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    --output)
      [[ $# -ge 2 ]] || { echo "error: --output needs a path" >&2; exit 1; }
      OUTPUT="$2"
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown argument '$1' (try --help)" >&2; exit 1 ;;
  esac
done

if [[ "$AUTO_PUBLISH" == "1" && "$PUBLISH" != "1" ]]; then
  echo "error: --auto-publish requires --publish" >&2
  exit 1
fi
if [[ "$PUBLISH" == "1" && "$OFFLINE" == "1" ]]; then
  echo "error: --offline cannot be combined with --publish" >&2
  exit 1
fi
if [[ "$PUBLISH" == "1" && "$ALLOW_DIRTY" == "1" ]]; then
  echo "error: a Store release cannot use --allow-dirty" >&2
  exit 1
fi
if [[ ! "$EXTENSION_ID" =~ ^[a-p]{32}$ ]]; then
  echo "error: invalid Chrome extension id '$EXTENSION_ID'" >&2
  exit 1
fi

for command_name in git node pnpm zip unzip; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "error: '$command_name' is required" >&2
    exit 1
  }
done
if [[ "$OFFLINE" != "1" || "$PUBLISH" == "1" ]]; then
  command -v curl >/dev/null 2>&1 || {
    echo "error: 'curl' is required for the Chrome Web Store check" >&2
    exit 1
  }
fi
if ! command -v shasum >/dev/null 2>&1 && ! command -v sha256sum >/dev/null 2>&1; then
  echo "error: 'shasum' or 'sha256sum' is required" >&2
  exit 1
fi

TRACKED_RELEASE_PATHS=(
  scripts/publish-browser-extension.sh
  apps/browser-extension
  packages/shared/src/browser-extension-build.ts
)
DIRTY="$(git -C "$REPO_ROOT" status --porcelain --untracked-files=all -- "${TRACKED_RELEASE_PATHS[@]}")"
if [[ -n "$DIRTY" && "$ALLOW_DIRTY" != "1" ]]; then
  echo "error: browser-extension release inputs are dirty:" >&2
  printf '%s\n' "$DIRTY" >&2
  echo "       commit them first, or use --allow-dirty for a local artifact only" >&2
  exit 1
fi
if [[ -n "$DIRTY" ]]; then
  echo "warn: preparing an artifact from dirty release inputs (--allow-dirty)" >&2
fi

VERSION="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).version" "$MANIFEST")"
validate_chrome_version() {
  node -e '
    const value = process.argv[1]
    const parts = value.split(".")
    const valid = parts.length >= 1 && parts.length <= 4 && parts.every((part) =>
      /^(0|[1-9][0-9]*)$/.test(part) && Number(part) <= 65535
    ) && parts.some((part) => Number(part) !== 0)
    process.exit(valid ? 0 : 1)
  ' "$1"
}
version_is_greater() {
  node -e '
    const parse = (value) => value.split(".").map(Number).concat([0, 0, 0, 0]).slice(0, 4)
    const left = parse(process.argv[1])
    const right = parse(process.argv[2])
    const result = left.findIndex((part, index) => part !== right[index])
    process.exit(result >= 0 && left[result] > right[result] ? 0 : 1)
  ' "$1" "$2"
}
if ! validate_chrome_version "$VERSION"; then
  echo "error: manifest version '$VERSION' is not a valid Chrome version (1-4 integers, each 0-65535)" >&2
  exit 1
fi

if [[ -z "$OUTPUT" ]]; then
  OUTPUT="$EXTENSION_ROOT/release/use-brian-browser-extension-$VERSION.zip"
fi
ARTIFACT="$(node -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' "$OUTPUT")"
if [[ "$ARTIFACT" != *.zip ]]; then
  echo "error: --output must name a .zip file" >&2
  exit 1
fi

if [[ "$OFFLINE" != "1" ]]; then
  echo "==> Checking Chrome Web Store version for $EXTENSION_ID..."
  UPDATE_URL="https://clients2.google.com/service/update2/crx?response=updatecheck&acceptformat=crx2,crx3&prodversion=130.0.0.0&x=id%3D${EXTENSION_ID}%26uc"
  if ! UPDATE_XML="$(curl --fail --silent --show-error --location "$UPDATE_URL")"; then
    echo "error: could not read the public Chrome Web Store version; retry or use --offline for an artifact only" >&2
    exit 1
  fi
  if ! STORE_VERSION="$(printf '%s' "$UPDATE_XML" | node -e '
    let input = ""
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (chunk) => { input += chunk })
    process.stdin.on("end", () => {
      const match = input.match(/\bversion="([^"]+)"/)
      if (!match) process.exit(1)
      process.stdout.write(match[1])
    })
  ')"; then
    echo "error: the public update endpoint did not return a published version for $EXTENSION_ID" >&2
    exit 1
  fi
  if ! version_is_greater "$VERSION" "$STORE_VERSION"; then
    echo "error: manifest version $VERSION must be greater than published Store version $STORE_VERSION" >&2
    exit 1
  fi
  echo "==> Version preflight: Store $STORE_VERSION -> package $VERSION"
else
  echo "warn: skipping the public Store-version check (--offline)" >&2
fi

SOURCE_BUILD="$(node "$EXTENSION_ROOT/scripts/build-hash.mjs")"
EXPECTED_BUILD="$(node -e '
  const source = require("node:fs").readFileSync(process.argv[1], "utf8")
  const match = source.match(/CURRENT_EXTENSION_BUILD\s*=\s*\x27([a-f0-9]{12})\x27/)
  if (!match) process.exit(1)
  process.stdout.write(match[1])
' "$BUILD_STAMP_SOURCE")"
if [[ "$SOURCE_BUILD" != "$EXPECTED_BUILD" ]]; then
  echo "error: CURRENT_EXTENSION_BUILD is stale" >&2
  echo "       source hash: $SOURCE_BUILD" >&2
  echo "       update $BUILD_STAMP_SOURCE before releasing" >&2
  exit 1
fi

echo "==> Running browser-extension tests..."
pnpm --dir "$REPO_ROOT" --filter @use-brian/browser-extension test
echo "==> Typechecking browser extension..."
pnpm --dir "$REPO_ROOT" --filter @use-brian/browser-extension typecheck

SOURCE_DATE_EPOCH="$(git -C "$REPO_ROOT" show -s --format=%ct HEAD)"
echo "==> Building browser extension $VERSION ($SOURCE_BUILD)..."
SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" pnpm --dir "$REPO_ROOT" --filter @use-brian/browser-extension build

BUILT_VERSION="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).version" "$DIST/manifest.json")"
BUILT_BUILD="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).build" "$DIST/build-info.json")"
if [[ "$BUILT_VERSION" != "$VERSION" || "$BUILT_BUILD" != "$SOURCE_BUILD" ]]; then
  echo "error: built extension does not match its source (version $BUILT_VERSION, build $BUILT_BUILD)" >&2
  exit 1
fi

STAGING_DIR="$(mktemp -d "${TMPDIR:-/tmp}/use-brian-browser-extension.XXXXXX")"
cleanup() {
  rm -rf "$STAGING_DIR"
}
trap cleanup EXIT
cp -R "$DIST/." "$STAGING_DIR/"

# Normalize timestamps before `zip -X`: build-info uses the same commit epoch,
# so a clean checkout at one commit produces the same package bytes repeatedly.
node -e '
  const { readdirSync, statSync, utimesSync } = require("node:fs")
  const { join } = require("node:path")
  const root = process.argv[1]
  const timestamp = new Date(Number(process.argv[2]) * 1000)
  const visit = (path) => {
    for (const name of readdirSync(path)) {
      const child = join(path, name)
      if (statSync(child).isDirectory()) visit(child)
      utimesSync(child, timestamp, timestamp)
    }
  }
  visit(root)
' "$STAGING_DIR" "$SOURCE_DATE_EPOCH"

mkdir -p "$(dirname "$ARTIFACT")"
rm -f "$ARTIFACT"
(
  cd "$STAGING_DIR"
  LC_ALL=C find . -type f -print | LC_ALL=C sort | TZ=UTC zip -X -q "$ARTIFACT" -@
)

ARCHIVE_VERSION="$(unzip -p "$ARTIFACT" manifest.json | node -e '
  let input = ""
  process.stdin.on("data", (chunk) => { input += chunk })
  process.stdin.on("end", () => process.stdout.write(JSON.parse(input).version))
')"
if [[ "$ARCHIVE_VERSION" != "$VERSION" ]]; then
  echo "error: archive manifest version $ARCHIVE_VERSION does not match source version $VERSION" >&2
  exit 1
fi
if unzip -Z1 "$ARTIFACT" | grep -q '^dist/'; then
  echo "error: archive contains a dist/ wrapper; manifest.json must be at the ZIP root" >&2
  exit 1
fi
if command -v shasum >/dev/null 2>&1; then
  ARTIFACT_SHA="$(shasum -a 256 "$ARTIFACT" | awk '{print $1}')"
else
  ARTIFACT_SHA="$(sha256sum "$ARTIFACT" | awk '{print $1}')"
fi
echo "==> Artifact: $ARTIFACT"
echo "==> SHA256:   $ARTIFACT_SHA"

if [[ "$PUBLISH" != "1" ]]; then
  echo "==> Prepared only. Re-run with --publish to upload and submit this version for review."
  exit 0
fi

PUBLISHER_ID="${CHROME_WEB_STORE_PUBLISHER_ID:-}"
if [[ -z "$PUBLISHER_ID" || ! "$PUBLISHER_ID" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "error: set CHROME_WEB_STORE_PUBLISHER_ID to the Publisher > Settings value" >&2
  exit 1
fi

json_value() {
  node -e '
    let input = ""
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (chunk) => { input += chunk })
    process.stdin.on("end", () => {
      const value = process.argv[1].split(".").reduce((current, key) => current?.[key], JSON.parse(input))
      if (value !== undefined && value !== null) process.stdout.write(String(value))
    })
  ' "$1"
}
revision_version() {
  node -e '
    let input = ""
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (chunk) => { input += chunk })
    process.stdin.on("end", () => {
      const revision = JSON.parse(input)[process.argv[1]]
      const version = revision?.distributionChannels?.find((channel) => channel?.crxVersion)?.crxVersion
      if (version) process.stdout.write(version)
    })
  ' "$1"
}

if [[ -n "${CHROME_WEB_STORE_ACCESS_TOKEN:-}" ]]; then
  ACCESS_TOKEN="$CHROME_WEB_STORE_ACCESS_TOKEN"
  AUTH_SOURCE="provided access token"
elif [[ -n "${CHROME_WEB_STORE_SERVICE_ACCOUNT:-}" ]]; then
  command -v gcloud >/dev/null 2>&1 || {
    echo "error: gcloud is required with CHROME_WEB_STORE_SERVICE_ACCOUNT" >&2
    exit 1
  }
  ACCESS_TOKEN="$(gcloud auth print-access-token \
    --impersonate-service-account="$CHROME_WEB_STORE_SERVICE_ACCOUNT" \
    --scopes="$OAUTH_SCOPE")"
  AUTH_SOURCE="service-account impersonation"
elif [[ -n "${CHROME_WEB_STORE_CLIENT_ID:-}" && -n "${CHROME_WEB_STORE_CLIENT_SECRET:-}" && -n "${CHROME_WEB_STORE_REFRESH_TOKEN:-}" ]]; then
  if ! TOKEN_RESPONSE="$(node -e '
    const body = new URLSearchParams({
      client_id: process.env.CHROME_WEB_STORE_CLIENT_ID,
      client_secret: process.env.CHROME_WEB_STORE_CLIENT_SECRET,
      refresh_token: process.env.CHROME_WEB_STORE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    })
    process.stdout.write(body.toString())
  ' | curl --fail --silent --show-error \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    --data-binary @- https://oauth2.googleapis.com/token)"; then
    echo "error: OAuth refresh failed" >&2
    exit 1
  fi
  ACCESS_TOKEN="$(printf '%s' "$TOKEN_RESPONSE" | json_value access_token)"
  AUTH_SOURCE="OAuth refresh token"
else
  echo "error: configure a Chrome Web Store access token, service account, or OAuth refresh-token trio" >&2
  exit 1
fi
if [[ -z "$ACCESS_TOKEN" ]]; then
  echo "error: Chrome Web Store authentication returned no access token" >&2
  exit 1
fi
echo "==> Authenticated through $AUTH_SOURCE"

API_RESPONSE_FILE="$STAGING_DIR/api-response.json"
api_call() {
  local method="$1"
  local url="$2"
  local mode="${3:-none}"
  local payload="${4:-}"
  local -a args=(
    --silent --show-error
    --output "$API_RESPONSE_FILE"
    --write-out '%{http_code}'
    --request "$method"
    --header "Authorization: Bearer $ACCESS_TOKEN"
  )
  if [[ "$mode" == "upload" ]]; then
    args+=(--header 'Content-Type: application/zip' --upload-file "$payload")
  elif [[ "$mode" == "json" ]]; then
    args+=(--header 'Content-Type: application/json' --data-binary "$payload")
  fi

  local http_code
  if ! http_code="$(curl "${args[@]}" "$url")"; then
    echo "error: Chrome Web Store API request failed: $method $url" >&2
    return 1
  fi
  if [[ ! "$http_code" =~ ^2[0-9][0-9]$ ]]; then
    echo "error: Chrome Web Store API returned HTTP $http_code for $method $url" >&2
    sed -n '1,120p' "$API_RESPONSE_FILE" >&2
    return 1
  fi
  cat "$API_RESPONSE_FILE"
}

ITEM_URL="https://chromewebstore.googleapis.com/v2/publishers/$PUBLISHER_ID/items/$EXTENSION_ID"
UPLOAD_URL="https://chromewebstore.googleapis.com/upload/v2/publishers/$PUBLISHER_ID/items/$EXTENSION_ID:upload"
STATUS_RESPONSE="$(api_call GET "$ITEM_URL:fetchStatus")"
if [[ "$(printf '%s' "$STATUS_RESPONSE" | json_value takenDown)" == "true" ]]; then
  echo "error: the Store item is taken down; resolve it in the Developer Dashboard" >&2
  exit 1
fi
if [[ "$(printf '%s' "$STATUS_RESPONSE" | json_value warned)" == "true" ]]; then
  echo "error: the Store item has an active policy warning; resolve it before releasing" >&2
  exit 1
fi
SUBMISSION_STATE="$(printf '%s' "$STATUS_RESPONSE" | json_value submittedItemRevisionStatus.state)"
if [[ "$SUBMISSION_STATE" == "PENDING_REVIEW" || "$SUBMISSION_STATE" == "STAGED" ]]; then
  echo "error: Store item already has an active $SUBMISSION_STATE revision; do not overwrite it" >&2
  exit 1
fi
PUBLISHED_VERSION="$(printf '%s' "$STATUS_RESPONSE" | revision_version publishedItemRevisionStatus)"
if [[ -n "$PUBLISHED_VERSION" ]] && ! version_is_greater "$VERSION" "$PUBLISHED_VERSION"; then
  echo "error: package version $VERSION must be greater than authenticated Store version $PUBLISHED_VERSION" >&2
  exit 1
fi

PUBLISH_TYPE="STAGED_PUBLISH"
PUBLISH_OUTCOME="remain staged after approval"
if [[ "$AUTO_PUBLISH" == "1" ]]; then
  PUBLISH_TYPE="DEFAULT_PUBLISH"
  PUBLISH_OUTCOME="publish automatically after approval"
fi

if [[ "$YES" != "1" ]]; then
  if [[ ! -t 0 ]]; then
    echo "error: publishing needs an interactive confirmation; use --yes only in a deliberate release runner" >&2
    exit 1
  fi
  echo "About to upload $ARTIFACT_SHA and submit extension $EXTENSION_ID version $VERSION."
  echo "Approved revision will $PUBLISH_OUTCOME."
  read -r -p "Type 'publish $VERSION $PUBLISH_TYPE' to continue: " CONFIRMATION
  if [[ "$CONFIRMATION" != "publish $VERSION $PUBLISH_TYPE" ]]; then
    echo "error: confirmation did not match; nothing was uploaded" >&2
    exit 1
  fi
fi

echo "==> Uploading extension $VERSION..."
UPLOAD_RESPONSE="$(api_call POST "$UPLOAD_URL" upload "$ARTIFACT")"
UPLOAD_STATE="$(printf '%s' "$UPLOAD_RESPONSE" | json_value uploadState)"
UPLOADED_VERSION="$(printf '%s' "$UPLOAD_RESPONSE" | json_value crxVersion)"
if [[ "$UPLOAD_STATE" == "IN_PROGRESS" ]]; then
  echo "==> Upload validation is asynchronous; polling status..."
  for _attempt in {1..15}; do
    sleep 2
    STATUS_RESPONSE="$(api_call GET "$ITEM_URL:fetchStatus")"
    UPLOAD_STATE="$(printf '%s' "$STATUS_RESPONSE" | json_value lastAsyncUploadState)"
    [[ "$UPLOAD_STATE" == "IN_PROGRESS" ]] || break
  done
fi
if [[ "$UPLOAD_STATE" != "SUCCEEDED" ]]; then
  echo "error: extension upload did not succeed (state: ${UPLOAD_STATE:-missing})" >&2
  exit 1
fi
if [[ -n "$UPLOADED_VERSION" && "$UPLOADED_VERSION" != "$VERSION" ]]; then
  echo "error: Store accepted version $UPLOADED_VERSION, expected $VERSION; refusing to submit" >&2
  exit 1
fi

PUBLISH_BODY="{\"publishType\":\"$PUBLISH_TYPE\",\"skipReview\":false,\"blockOnWarnings\":true}"
echo "==> Submitting extension $VERSION for review ($PUBLISH_TYPE)..."
PUBLISH_RESPONSE="$(api_call POST "$ITEM_URL:publish" json "$PUBLISH_BODY")"
PUBLISH_STATE="$(printf '%s' "$PUBLISH_RESPONSE" | json_value state)"
case "$PUBLISH_STATE" in
  PENDING_REVIEW|STAGED|PUBLISHED|PUBLISHED_TO_TESTERS) ;;
  *)
    echo "error: Store returned unexpected publish state '${PUBLISH_STATE:-missing}'" >&2
    exit 1
    ;;
esac

VERIFIED_STATE=""
VERIFIED_VERSION=""
VERIFIED_REVISION="submitted"
for _attempt in {1..5}; do
  STATUS_RESPONSE="$(api_call GET "$ITEM_URL:fetchStatus")"
  VERIFIED_STATE="$(printf '%s' "$STATUS_RESPONSE" | json_value submittedItemRevisionStatus.state)"
  VERIFIED_VERSION="$(printf '%s' "$STATUS_RESPONSE" | revision_version submittedItemRevisionStatus)"
  VERIFIED_REVISION="submitted"
  if [[ "$VERIFIED_VERSION" != "$VERSION" ]]; then
    PUBLISHED_AFTER_SUBMIT="$(printf '%s' "$STATUS_RESPONSE" | revision_version publishedItemRevisionStatus)"
    if [[ "$PUBLISHED_AFTER_SUBMIT" == "$VERSION" ]]; then
      VERIFIED_STATE="$(printf '%s' "$STATUS_RESPONSE" | json_value publishedItemRevisionStatus.state)"
      VERIFIED_VERSION="$PUBLISHED_AFTER_SUBMIT"
      VERIFIED_REVISION="published"
    fi
  fi
  if [[ "$VERIFIED_VERSION" == "$VERSION" ]]; then
    break
  fi
  sleep 2
done
if [[ "$VERIFIED_VERSION" != "$VERSION" ]]; then
  echo "error: submission was accepted as $PUBLISH_STATE, but fetchStatus did not confirm version $VERSION" >&2
  echo "       inspect the Developer Dashboard before retrying; a review may now be active" >&2
  exit 1
fi

echo "==> Chrome Web Store $VERIFIED_REVISION revision verified: version $VERIFIED_VERSION ($VERIFIED_STATE)"
echo "==> Listing: https://chromewebstore.google.com/detail/use-brian-browser-agent/$EXTENSION_ID"
echo "==> Dashboard: https://chrome.google.com/webstore/devconsole"
