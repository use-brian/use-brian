# Desktop packaging

## Build, sign, ship (macOS)

`scripts/package-desktop.sh` owns the local release build, renderer/native/Siri compilation, Developer ID signing, verification and optional publication. Each build reserves a fresh `release/runs/mac-*` output directory, leaving old artifacts untouched. The output allocator must work through macOS temporary-directory symlinks as well as canonical paths; an empty output is never a successful reservation. Failure never labels a previous ZIP as this run's result.

Default packaging signs, notarizes the app and DMG, staples and runs Gatekeeper assessment. It requires `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`. `--publish` additionally authorizes publication; ordinary packaging never publishes.

`--local-test` is an explicit Developer ID signing-only build for testing on the build Mac. It requires only `CSC_LINK` and `CSC_KEY_PASSWORD`, uses the same signer, hardened runtime, helper/fixture entitlement profiles, bootstrap sealing and after-sign verification, and forces code signing. Its per-run builder configuration explicitly disables notarization even if Apple credentials are present. It signs/verifies the DMG but never runs notarytool, stapler or a Gatekeeper distribution assessment. The result is labeled local test, not notarized and not a distribution/acceptance result. It refuses `--publish` and `--no-build` before credential validation, keychain changes, version mutation or compilation. Default release behavior is unchanged. Signing may contact Apple's timestamp service; this does not submit the app for notarization.

```sh
bash scripts/package-desktop.sh --arm64 --local-test
```

Local test packages may only be used after the run prints Done. Launch their application bundle through Launch Services with the explicit updater-disable and inspector flags in [the Mac handoff](../../native-computer-mac-handoff.md). Never disable Gatekeeper or reset TCC as part of this workflow. Notarized release testing remains a separate acceptance gate.

## Release keychain

The existing `scripts/desktop-keychain.sh` imports the configured Developer ID certificate into a temporary keychain, uses a separate random keychain password and the installed builder's public Apple certificate chain, and exports the exact signing identity/keychain selected there. Cleanup restores the prior search list and deletes only that temporary keychain/directory. Signing-only testing uses the same lifecycle. Secrets are sourced without tracing and are never printed. No ad hoc identity substitutes for a configured Developer ID.
