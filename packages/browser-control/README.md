# @use-brian/browser-control

Shared browser executor and relay client, with no Chrome/Electron type dependencies.
Build with `pnpm --filter @use-brian/browser-control build`; consumers import compiled
subpaths such as `@use-brian/browser-control/executor.js` and
`@use-brian/browser-control/relay-client.js` (including their exported types).

Desktop injects `ExecutorPlatform` into `TabExecutor`; the existing lazy Chrome
platform fallback remains available to the extension. `RelayClientDeps.clientKind`
may be `electron` to skip extension-only build-staleness reporting. This is not an
authorization signal: authentication is unchanged and Electron never receives
protected-fill capability, even when requested in hello.

Extension source files remain compatibility re-exports. Extension assembly replaces
the emitted shims with this package's compiled modules so the unpacked browser
build contains only relative imports, not Node-style bare package specifiers.
The extension source fingerprint includes this package's source.
