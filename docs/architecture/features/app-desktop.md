# Desktop packaging

## Native computer consent delivery

The profile and chat consent contract is specified in [native computer use](../../native-computer-use.md). Main owns polling, fresh target selection, grant approval and pairing. A stale selected target requires a new explicit window selection. If a healthy, ready helper returns no windows, main offers one locally initiated Refresh windows while retaining the pending request. Cancel disconnects; Stop and scope changes abort the prompt. Refresh performs one fresh discovery, checks account/workspace again, and requires explicit selection followed by separate grant approval. It never substitutes the cached window, retries an unavailable helper, or repeats discovery automatically. If the fresh scan is still empty, normal failure cleanup applies. A request failure before or after grant approval disconnects and presents a fixed local explanation after confirmed cleanup and fresh account/workspace checks. Stop, account/workspace changes and explicit denial suppress that notification. Stage diagnostics contain only fixed stage names, backend error codes and booleans. Neither a queued request nor a diagnostics event grants access.

After explicit approval, Mac helper Start has a separate setup deadline: at most 60 seconds, capped by the remaining approved grant lifetime. Startup repeatedly revalidates the sealed signed parent, target lifetime, window scope and foreground restoration. These checks are retained without caching or weakening admission. Explicit helper timeout overrides remain effective within grant expiry. Discovery/first metadata retain their 15-second deadline, subsequent metadata retains four seconds; the supported command transport policy below retains native deadlines, physical takeover and immediate Stop. An expired or timed-out Start kills the helper and is never retried automatically.

Supported Mac command RPCs (observe, capture, semantic actions and visual invoke, including their approval phases) use at most 30 seconds of transport time, clipped to the existing command deadline, retained grant expiry and any shorter explicit helper timeout. The transport does not extend native deadlines, observation freshness, local approval or authority. Ordinary metadata retains four seconds; retired raw input RPCs and non-Mac requests keep their existing default. Stop remains immediate, and uncertainty never permits replay.

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
