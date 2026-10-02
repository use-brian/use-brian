#!/bin/bash
# Local compile/refusal only. Never launches the fixture or requests permissions.
set -euo pipefail
umask 077
[[ $# == 0 ]] || { echo 'Usage: bash mac-preflight.sh (no arguments)' >&2; exit 64; }
[[ "$(uname -s)" == Darwin ]] || { echo 'macOS 14+ required; no native checks ran.' >&2; exit 1; }
cd "$(dirname "$0")"
SOURCE="$(pwd -P)"
# Do not inherit Node preload hooks or an explicit signing identity.
unset CODESIGN_IDENTITY NODE_OPTIONS NODE_PATH
OS_VERSION="$(/usr/bin/sw_vers -productVersion)"
[[ "${OS_VERSION%%.*}" -ge 14 ]] || { echo 'macOS 14+ required.' >&2; exit 1; }
ARCH="$(uname -m)"
[[ "$ARCH" == arm64 || "$ARCH" == x86_64 ]] || { echo "Unsupported architecture: $ARCH" >&2; exit 1; }
command -v node >/dev/null || { echo 'Install Node 20+ separately; this script installs nothing.' >&2; exit 1; }
node -e 'if (Number(process.versions.node.split(".")[0]) < 20) process.exit(1)' || { echo 'Node 20+ required.' >&2; exit 1; }
# Refuse missing tools rather than letting xcrun offer an installation dialog.
/usr/bin/xcode-select -p >/dev/null 2>&1 || { echo 'Select installed Xcode/Command Line Tools separately; no checks ran.' >&2; exit 1; }
SDK="$(/usr/bin/xcrun --sdk macosx --show-sdk-path)"
SDK_VERSION="$(/usr/bin/xcrun --sdk macosx --show-sdk-version)"
[[ "${SDK_VERSION%%.*}" -ge 14 ]] || { echo 'macOS SDK 14+ required (Xcode/CLT 15+).' >&2; exit 1; }
export SDKROOT="$SDK"
WORK="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/brian-mac-preflight.XXXXXX")"
chmod 700 "$WORK"
mkdir "$WORK/logs" "$WORK/module-cache"
export CLANG_MODULE_CACHE_PATH="$WORK/module-cache"
printf 'Private local results: %s\nCompiler logs may contain your local paths. Inspect before sharing.\n' "$WORK"
trap 'status=$?; if [[ $status != 0 ]]; then printf "FAIL (status %s). Inspect local logs: %s/logs\n" "$status" "$WORK" >&2; fi' EXIT
{
  printf 'Source: %s\nArchitecture: %s\nmacOS: %s\nSDK: %s (%s)\n' "$SOURCE" "$ARCH" "$OS_VERSION" "$SDK" "$SDK_VERSION"
  node --version
  /usr/bin/xcrun --sdk macosx swiftc --version
  /usr/bin/xcrun --sdk macosx clang --version
} > "$WORK/logs/toolchain.log" 2>&1
node ./smoke.mjs --portable > "$WORK/logs/portable.log" 2>&1

# Collect the independent Fixture diagnostic even if the subsequent helper build fails.
fixture_status=0
/usr/bin/xcrun --sdk macosx swiftc -swift-version 5 -sdk "$SDK" \
  -target "$ARCH-apple-macosx14.0" -typecheck Fixture.swift \
  > "$WORK/logs/fixture-typecheck.log" 2>&1 || fixture_status=$?
build_status=0
# Explicitly unset again at the build boundary: no codesign/timestamp branch.
/usr/bin/env -u CODESIGN_IDENTITY SDKROOT="$SDK" /bin/bash ./build.sh "$WORK/build" \
  > "$WORK/logs/build.log" 2>&1 || build_status=$?
if [[ "$fixture_status" != 0 || "$build_status" != 0 ]]; then
  printf 'Fixture typecheck status: %s; build status: %s\n' "$fixture_status" "$build_status" >&2
  exit 1
fi
node ./bootstrap-negative.mjs "$WORK/build/brian-native-computer-helper" \
  > "$WORK/logs/bootstrap-negative.log" 2>&1
# Self-only read-only prerequisite; this does not inspect the helper's parent,
# evaluate certificates, request TCC, sign anything or enable native authority.
/usr/bin/xcrun --sdk macosx clang -std=c11 -D_DARWIN_C_SOURCE -Wall -Wextra -Werror \
  -isysroot "$SDK" -target "$ARCH-apple-macosx14.0" \
  KernelSigningProbe.c "$WORK/build/ProcessIdentity.o" \
  -framework CoreFoundation -framework Security -o "$WORK/build/kernel-signing-probe" \
  > "$WORK/logs/kernel-signing-build.log" 2>&1
"$WORK/build/kernel-signing-probe" > "$WORK/logs/kernel-signing.json" 2> "$WORK/logs/kernel-signing-stderr.log"
printf 'PASS local compile, negative bootstrap refusal and self kernel-signing comparison only. NOT proof of parent trust or native operational acceptance.\nLogs: %s/logs\nCurrent-architecture artifacts (do not launch fixture): %s/build\n' "$WORK" "$WORK"
