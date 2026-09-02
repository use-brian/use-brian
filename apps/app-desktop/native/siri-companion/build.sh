#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: the Siri companion can only be built on macOS" >&2
  exit 1
fi

xcodebuild \
  -project "$ROOT/BrianSiri.xcodeproj" \
  -target BrianSiri \
  -configuration Release \
  CONFIGURATION_BUILD_DIR="$ROOT/build/Release" \
  CODE_SIGNING_ALLOWED=NO \
  build
