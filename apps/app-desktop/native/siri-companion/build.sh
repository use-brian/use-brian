#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PACKAGE_JSON="$ROOT/../../package.json"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: the Siri extension can only be built on macOS" >&2
  exit 1
fi

VERSION="$(node -p "require('$PACKAGE_JSON').version")"

xcodebuild \
  -project "$ROOT/BrianSiri.xcodeproj" \
  -target BrianSiri \
  -configuration Release \
  CONFIGURATION_BUILD_DIR="$ROOT/build/Release" \
  MARKETING_VERSION="$VERSION" \
  CURRENT_PROJECT_VERSION="$VERSION" \
  CODE_SIGN_STYLE=Manual \
  CODE_SIGN_IDENTITY=- \
  CODE_SIGNING_REQUIRED=YES \
  build
