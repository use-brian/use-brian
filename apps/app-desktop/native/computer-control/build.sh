#!/bin/bash
set -euo pipefail
[[ "$(uname -s)" == Darwin ]] || { echo 'macOS SDK required for the Swift helper; use the separate Windows/Linux builders on those platforms.' >&2; exit 1; }
cd "$(dirname "$0")"
out="${1:-build}"
mkdir -p "$out/NativeComputerFixture.app/Contents/MacOS"
# Swift requires the top-level dispatcher to be named main.swift in a multi-file
# executable. Use a private temporary copy, never rename/change the source file.
work="$(mktemp -d "${TMPDIR:-/tmp}/brian-native-build.XXXXXXXX")"
chmod 700 "$work"
trap 'rm -rf "$work"' EXIT
cp Helper.swift "$work/main.swift"
# Private build-only bridge: preserve the pre-existing bootstrap identity header.
printf '#include "%s/ProcessIdentity.h"\n#include <stdint.h>\nvoid *brian_epoch_fence_create(int32_t pid);\nint32_t brian_epoch_fence_poll(void *fence);\nvoid brian_epoch_fence_destroy(void *fence);\n' "$PWD" > "$work/NativeBridge.h"
xcrun clang -O2 -Wall -Wextra -Werror -target "$(uname -m)-apple-macosx14.0" -c ProcessIdentity.c -o "$out/ProcessIdentity.o"
xcrun clang -O2 -Wall -Wextra -Werror -target "$(uname -m)-apple-macosx14.0" -c BootstrapApprovalAnchor.c -o "$out/BootstrapApprovalAnchor.o"
xcrun clang -O2 -std=c11 -Wall -Wextra -Werror -target "$(uname -m)-apple-macosx14.0" -c ProcessEpochFence.c -o "$out/ProcessEpochFence.o"
# The compiled anchor is EMPTY and refuses use. Linking these bounded parsers
# neither stamps an approval nor enables the probe-only operational dispatcher.
xcrun swiftc -O -swift-version 5 -import-objc-header "$work/NativeBridge.h" -target "$(uname -m)-apple-macosx14.0" -framework AppKit -framework ApplicationServices -framework CryptoKit -framework ScreenCaptureKit -framework Security "$work/main.swift" ClickIntent.swift ClickGuardianNative.swift ClickGuardianHost.swift ProcessEpochFence.swift LibraryConstraintPolicy.swift MachOLibraryConstraint.swift BootstrapApproval.swift BootstrapApprovalReader.swift ElectronFrameworkBinding.swift BootstrapProcessBinding.swift "$out/ProcessIdentity.o" "$out/ProcessEpochFence.o" "$out/BootstrapApprovalAnchor.o" -o "$out/brian-native-computer-helper"
xcrun swiftc -O -swift-version 5 -target "$(uname -m)-apple-macosx14.0" -framework AppKit Fixture.swift -o "$out/NativeComputerFixture.app/Contents/MacOS/NativeComputerFixture"
cat > "$out/NativeComputerFixture.app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.usebrian.NativeComputerFixture</string>
<key>CFBundleName</key><string>Native Computer Fixture</string>
<key>CFBundleExecutable</key><string>NativeComputerFixture</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
</dict></plist>
PLIST
# Standalone builds never gain authority: a signed packaged desktop parent is required.
if [[ -n "${CODESIGN_IDENTITY:-}" ]]; then
  codesign --force --options runtime --timestamp --sign "$CODESIGN_IDENTITY" "$out/brian-native-computer-helper"
  codesign --force --options runtime --timestamp --sign "$CODESIGN_IDENTITY" "$out/NativeComputerFixture.app"
else
  echo 'UNSIGNED development artifacts. Do not advertise production/TCC readiness.' >&2
fi
