#!/usr/bin/env bash
# Sourced by package-desktop.sh. Keep certificate and keychain passwords separate.
# Spec: docs/architecture/features/app-desktop.md -> "Release keychain".
set +x

DESKTOP_SIGNING_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

DESKTOP_SIGNING_DIR=""
DESKTOP_SIGNING_KEYCHAIN=""
DESKTOP_SIGNING_RESTORE_SEARCH_LIST=0
DESKTOP_SIGNING_SEARCH_LIST_ARGS=(list-keychains -d user -s)

desktop_keychain_cleanup() {
  if [[ "$DESKTOP_SIGNING_RESTORE_SEARCH_LIST" == "1" ]]; then
    desktop_keychain_security "${DESKTOP_SIGNING_SEARCH_LIST_ARGS[@]}" || true
  fi
  if [[ -n "$DESKTOP_SIGNING_KEYCHAIN" ]]; then
    security delete-keychain "$DESKTOP_SIGNING_KEYCHAIN" >/dev/null 2>&1 || true
  fi
  if [[ -n "$DESKTOP_SIGNING_DIR" ]]; then
    rm -rf "$DESKTOP_SIGNING_DIR"
  fi
  DESKTOP_SIGNING_KEYCHAIN=""
  DESKTOP_SIGNING_DIR=""
  DESKTOP_SIGNING_RESTORE_SEARCH_LIST=0
  DESKTOP_SIGNING_SEARCH_LIST_ARGS=(list-keychains -d user -s)
}

# security errors can contain command arguments. Never echo their secret values.
desktop_keychain_security() {
  if ! security "$@" >/dev/null 2>&1; then
    echo "error: desktop signing keychain step failed: $1" >&2
    return 1
  fi
}

desktop_keychain_prepare() {
  DESKTOP_SIGNING_DIR="$(mktemp -d "${TMPDIR:-/tmp}/usebrian-signing.XXXXXX")" || return 1
  DESKTOP_SIGNING_KEYCHAIN="$DESKTOP_SIGNING_DIR/signing.keychain-db"
  local public_chain="$DESKTOP_SIGNING_DIR/root_certs.keychain"
  local certificate="$DESKTOP_SIGNING_DIR/certificate.p12"
  local keychain_password identities keychains keychain
  keychain_password="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')" || return 1

  # Reuse the installed builder's public Apple chain. CSC_KEYCHAIN bypasses
  # electron-builder's createKeychain path, which normally installs this chain.
  if ! node --input-type=module - "$DESKTOP_SIGNING_SCRIPT_DIR/../apps/app-desktop/package.json" "$public_chain" <<'NODE'
import { chmodSync, copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
try {
  const builder = createRequire(process.argv[2]).resolve('electron-builder/package.json');
  const library = createRequire(builder).resolve('app-builder-lib/package.json');
  copyFileSync(join(dirname(library), 'certs/root_certs.keychain'), process.argv[3]);
  chmodSync(process.argv[3], 0o600);
} catch {
  console.error('error: could not copy installed electron-builder public Apple chain (app-builder-lib/certs/root_certs.keychain).');
  process.exitCode = 1;
}
NODE
  then
    return 1
  fi

  # Node reads the secret from the environment, never from command arguments.
  if ! node --input-type=module - "$certificate" <<'NODE'
import { copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
try {
  const link = process.env.CSC_LINK?.trim() ?? '';
  const path = link.startsWith('file:') ? fileURLToPath(link)
    : link.startsWith('~/') ? `${homedir()}/${link.slice(2)}` : link;
  if (existsSync(path)) {
    copyFileSync(path, process.argv[2]);
  } else {
    const base64 = link.replace(/\s/g, '');
    if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new Error();
    writeFileSync(process.argv[2], Buffer.from(base64, 'base64'), { mode: 0o600 });
  }
} catch {
  console.error('error: CSC_LINK must be a readable certificate path or base64 certificate.');
  process.exitCode = 1;
}
NODE
  then
    return 1
  fi
  chmod 600 "$certificate" || return 1
  # codesign also needs the private key's keychain in the user search list.
  # Capture before create-keychain, which can itself change that list on macOS.
  if ! keychains="$(security list-keychains -d user 2>/dev/null)"; then
    echo "error: could not read the signing keychain search list." >&2
    return 1
  fi
  while IFS= read -r keychain; do
    [[ -z "$keychain" ]] && continue
    if [[ "$keychain" =~ ^[[:space:]]*\"(.*)\"[[:space:]]*$ ]]; then
      DESKTOP_SIGNING_SEARCH_LIST_ARGS+=("${BASH_REMATCH[1]}")
    else
      echo "error: could not parse the signing keychain search list." >&2
      return 1
    fi
  done <<< "$keychains"
  DESKTOP_SIGNING_RESTORE_SEARCH_LIST=1
  desktop_keychain_security create-keychain -p "$keychain_password" "$DESKTOP_SIGNING_KEYCHAIN" || return 1
  desktop_keychain_security unlock-keychain -p "$keychain_password" "$DESKTOP_SIGNING_KEYCHAIN" || return 1
  desktop_keychain_security set-keychain-settings -lut 21600 "$DESKTOP_SIGNING_KEYCHAIN" || return 1
  desktop_keychain_security import "$certificate" -k "$DESKTOP_SIGNING_KEYCHAIN" \
    -T /usr/bin/codesign -T /usr/bin/productbuild -P "$CSC_KEY_PASSWORD" || return 1
  desktop_keychain_security set-key-partition-list -S apple-tool:,apple: -s \
    -k "$keychain_password" "$DESKTOP_SIGNING_KEYCHAIN" || return 1
  desktop_keychain_security "${DESKTOP_SIGNING_SEARCH_LIST_ARGS[@]}" "$DESKTOP_SIGNING_KEYCHAIN" "$public_chain" || return 1
  identities="$(security find-identity -v -p codesigning "$DESKTOP_SIGNING_KEYCHAIN" 2>/dev/null)" || return 1
  CSC_NAME="$(printf '%s\n' "$identities" | awk '/Developer ID Application/ {print $2; exit}')"
  if [[ -z "$CSC_NAME" ]]; then
    echo "error: no valid Developer ID Application identity in the release keychain (check the certificate and Apple intermediate)." >&2
    return 1
  fi
  export CSC_KEYCHAIN="$DESKTOP_SIGNING_KEYCHAIN" CSC_NAME
  # With CSC_LINK set, electron-builder ignores CSC_KEYCHAIN and imports again.
  unset CSC_LINK CSC_KEY_PASSWORD
  rm -f "$certificate"
}
