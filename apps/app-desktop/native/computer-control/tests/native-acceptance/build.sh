#!/bin/bash
# Compile only. NEVER launches the app, posts input, requests TCC or signs it.
set -euo pipefail
[[ $# == 0 ]] || { echo 'Usage: bash build.sh (no arguments)' >&2; exit 64; }
[[ "$(uname -s)" == Darwin ]] || { echo 'Mac SDK required; nothing built or executed.' >&2; exit 69; }
cd "$(dirname "$0")"
root="$(cd ../.. && pwd)"
out="$PWD/.build"
mkdir -p "$out/NativeMechanismExperiment.app/Contents/MacOS"
chmod 700 "$out"
# Mark previous identity stale before attempting another compile.
rm -f "$out/identity.json"
target="$(uname -m)-apple-macosx14.0"
xcrun clang -O2 -std=c11 -Wall -Wextra -Werror -target "$target" -c Experiment.c -o "$out/Experiment.o"
xcrun clang -O2 -std=c11 -Wall -Wextra -Werror -target "$target" -c Bootstrap.c -o "$out/Bootstrap.o"
xcrun clang -O2 -std=c11 -Wall -Wextra -Werror -target "$target" -c "$root/ProcessEpochFence.c" -o "$out/ProcessEpochFence.o"
xcrun swiftc -O -swift-version 5 -target "$target" -import-objc-header "$PWD/Experiment.h" \
  -framework AppKit -framework CoreGraphics -framework ApplicationServices -lproc \
  main.swift Model.swift Adapter.swift "$root/ClickGuardianNative.swift" "$root/ProcessEpochFence.swift" \
  "$out/Experiment.o" "$out/Bootstrap.o" "$out/ProcessEpochFence.o" \
  -o "$out/NativeMechanismExperiment.app/Contents/MacOS/NativeMechanismExperiment"
chmod 700 "$out/NativeMechanismExperiment.app/Contents/MacOS/NativeMechanismExperiment"
cat > "$out/NativeMechanismExperiment.app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.usebrian.tests.NativeMechanismExperiment</string>
<key>CFBundleExecutable</key><string>NativeMechanismExperiment</string>
<key>CFBundleName</key><string>Isolated Native Mechanism Experiment</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
node run.mjs --record-build
printf '%s\n' 'Built test-only app. NOT launched or explicitly signed; NO acceptance. Read README before running.'
