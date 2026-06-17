/**
 * Version-skew gate (Phase 4, docs/plans/canvas-desktop-bundled-offline.md →
 * risk #3 "Version skew").
 *
 * A bundled client loads its UI from disk and can lag the API — a failure mode
 * the thin remote shell never had (it always fetched the latest UI). This is the
 * pure decision: given the running client version and the API's
 * minimum-supported client version, decide whether to force an update.
 *
 * **Fail-open by design.** A missing / unparseable minimum (a bad or old API
 * response) must never lock a user out of their own app — the gate blocks
 * *only* when both versions parse and the client is strictly below the minimum.
 *
 * Pure: the API fetch of the minimum and the "please update" dialog live in
 * `main.ts`. [COMP:app-desktop/version-gate]
 */

export type VersionGateDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: "below-minimum";
      clientVersion: string;
      minVersion: string;
    };

/**
 * Parse a dotted version (`1.2.3`, `v1.2`, `1.2.3-beta.1`) to `[major, minor,
 * patch]`. Tolerates a leading `v`, fewer than three parts (missing → 0), and a
 * pre-release/build suffix (ignored). Returns `null` when the leading numeric
 * core can't be read at all.
 */
export function parseVersion(v: string): [number, number, number] | null {
  if (typeof v !== "string") return null;
  const core = v.trim().replace(/^v/i, "").split(/[-+]/, 1)[0];
  if (!/^\d+(\.\d+)*$/.test(core)) return null;
  const parts = core.split(".").map((n) => Number.parseInt(n, 10));
  if (parts.length === 0 || parts.some((n) => Number.isNaN(n))) return null;
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/**
 * Compare two versions. Returns `-1` (a < b), `0` (equal), `1` (a > b), or
 * `null` when either side is unparseable.
 */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Decide whether the running client may proceed. Blocks only when both versions
 * parse and `clientVersion` is strictly below `minVersion`; everything else
 * (no minimum advertised, unparseable either side) fails open to `allowed`.
 */
export function evaluateVersionGate(
  clientVersion: string,
  minVersion: string | null | undefined,
): VersionGateDecision {
  if (!minVersion) return { allowed: true };
  const cmp = compareVersions(clientVersion, minVersion);
  if (cmp === null) return { allowed: true }; // fail open on unparseable input
  if (cmp < 0) {
    return { allowed: false, reason: "below-minimum", clientVersion, minVersion };
  }
  return { allowed: true };
}
