/**
 * Build edition: the open single-player core vs the hosted multi-tenant
 * product.
 *
 * app-web is one codebase served by both editions (the local OSS launcher and
 * the hosted platform both run this same app), so hosted-only surfaces -
 * billing, teammates, paid mini-apps - are gated on this flag at runtime rather
 * than forked into a second copy.
 *
 * The flag DEFAULTS to the full hosted edition when unset, so a hosted deploy
 * never has to opt in and existing hosted users are unaffected. Only the local
 * OSS launcher (`scripts/launch.mjs`) sets `NEXT_PUBLIC_SIDANCLAW_EDITION=oss`
 * to switch app-web into single-player mode.
 */
type SidanclawEdition = "oss" | "hosted";

function sidanclawEdition(): SidanclawEdition {
  return process.env.NEXT_PUBLIC_SIDANCLAW_EDITION === "oss" ? "oss" : "hosted";
}

/** True in the open single-player edition (no billing, no teammates). */
export function isOssEdition(): boolean {
  return sidanclawEdition() === "oss";
}

/** True in the hosted multi-tenant edition (the default). */
export function isHostedEdition(): boolean {
  return !isOssEdition();
}

/**
 * Where the open edition sends a user who wants teammates or other cloud
 * features. A canonical absolute URL (not `webAppUrl()`, which resolves to a
 * local dev origin in the OSS launcher) so the upgrade link always points at
 * the real hosted product.
 */
export const HOSTED_UPGRADE_URL = "https://sidan.ai/plans";
