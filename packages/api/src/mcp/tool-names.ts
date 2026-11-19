/**
 * Connector tool-name conventions shared by the catalog, activation, the
 * composition and outside importers (`brain-mcp/store-tools.ts`,
 * `routes/apps-shopify.ts`).
 *
 * See docs/architecture/integrations/mcp.md → "Provider activation" and
 * "Multiple instances".
 */
// ── Multi-instance tool variants ──────────────────────────────
//
// A user can connect more than one account for a single-secret built-in
// provider (GitHub / Notion / Fathom). The OLDEST instance keeps the
// canonical tool names + credentials (so a single-account user is byte-for-byte
// unchanged); each ADDITIONAL instance is injected as a parallel set of tools
// whose names carry a per-instance suffix and whose descriptions are tagged
// with the account's label, bound to that instance's own credentials.
//
// The suffix uses `__` which never appears in a canonical built-in tool name,
// so `baseToolName()` can recover the canonical name for policy resolution and
// the tool-search local-source pluck.

const INSTANCE_TOOL_SEP = '__'

export function instanceToolSuffix(instanceId: string, label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 16) || 'acct'
  const id8 = instanceId.replace(/-/g, '').slice(0, 8)
  return `${INSTANCE_TOOL_SEP}${slug}_${id8}`
}

/** Recover the canonical tool name from a (possibly) instance-suffixed name.
 *
 *  Exported because the Home-app store gate resolves classification by
 *  canonical name too, and a second copy of the `__` convention there would
 *  silently drop every multi-instance tool (fail-closed, but wrong). */
export function baseToolName(name: string): string {
  const i = name.indexOf(INSTANCE_TOOL_SEP)
  return i === -1 ? name : name.slice(0, i)
}

export type ConnectorInstanceRef = {
  id: string
  label: string
  connectedEmail?: string | null
  driveAccessMode?: 'picked_files' | 'full_drive_readonly'
}

/**
 * The exact `displayName` each built-in provider passes to its
 * not-connected notice, keyed by provider. The catalog renders the notice
 * once per turn from this name and `NOT_CONNECTED_CAPABILITIES`
 * (`providers/notices.ts`); `stale-not-connected.test.ts` keeps the tables in
 * lockstep with the described families.
 */
export const NOT_CONNECTED_DISPLAY_NAME: Record<string, string> = {
  gcal: 'Google Calendar',
  gmail: 'Gmail',
  gdrive: 'Google Drive, Docs, Sheets and Slides',
  github: 'GitHub',
  notion: 'Notion',
  fathom: 'Fathom',
  shopify: 'Shopify',
  wordpress: 'WordPress',
  gsc: 'Google Search Console',
  msgraph: 'Microsoft Teams',
  imap: 'Company email (IMAP)',
}
