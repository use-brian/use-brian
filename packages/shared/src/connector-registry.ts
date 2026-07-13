import { z } from 'zod'

// ── Registry entry schema ─────────────────────────────────────
// Describes a connector available in the browse directory.
// Used by both the API (to serve the directory) and the web UI (types).

export const ConnectorEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.enum(['official', 'community']),
  icon_url: z.string().optional(),
  mcp_url: z.string().optional(),
  auth_type: z.enum(['none', 'oauth', 'api_key']).default('none'),
  oauth_required: z.boolean().default(false),
  author: z.string().optional(),
  author_url: z.string().optional(),
  tags: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
  /**
   * One instance per user, ever — suppresses the "Add another" affordance and
   * excludes the connector from the multi-account runtime
   * (`MULTI_INSTANCE_RUNTIME_PROVIDERS` in `packages/api/src/mcp/inject.ts`).
   * Set on connectors that bind a resource rather than an account (gcs — a
   * per-workspace storage binding). Credentialed connectors WITHOUT this flag
   * must consume their multi-account extras in their injector.
   */
  single_instance: z.boolean().optional(),
})

export type ConnectorEntry = z.infer<typeof ConnectorEntrySchema>

// Schema for the community registry.json file
export const CommunityRegistrySchema = z.object({
  connectors: z.array(
    ConnectorEntrySchema.omit({ category: true, oauth_required: true, enabled: true }),
  ),
})

// ── Official connectors ───────────────────────────────────────
//
// ⚠️ When you add an entry here, ALSO sweep for hardcoded "all built-ins"
//    lists across the codebase. They have silently shadowed the registry
//    multiple times (see the Fathom rollout).
//
//    Fix any list that means "every official built-in" to derive from
//    OFFICIAL_CONNECTORS at runtime — never hardcode. Provider-family
//    lists (GOOGLE_CONNECTORS, PAT_CONNECTORS, CONFIGURABLE_CONNECTORS)
//    are intentionally narrow and stay hardcoded.
//
//    Full checklist + audit grep:
//      docs/architecture/integrations/mcp.md → "Drift sweep"

export const OFFICIAL_CONNECTORS: ConnectorEntry[] = [
  {
    id: 'gcal',
    name: 'Google Calendar',
    description: 'Manage events, schedule meetings, and check your agenda.',
    category: 'official',
    auth_type: 'oauth',
    oauth_required: true,
    enabled: true,
    tags: ['productivity', 'google'],
  },
  {
    id: 'gmail',
    name: 'Gmail',
    description: 'Compose and send emails on your behalf.',
    category: 'official',
    auth_type: 'oauth',
    oauth_required: true,
    enabled: true,
    tags: ['productivity', 'google'],
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Search pages and databases. Create and update content in your workspace.',
    category: 'official',
    auth_type: 'oauth',
    oauth_required: true,
    enabled: true,
    tags: ['productivity', 'workspace'],
  },
  {
    id: 'gdrive',
    name: 'Google Docs, Sheets & Slides',
    description: 'Pick specific documents, spreadsheets, or presentations to let the assistant read and edit them.',
    category: 'official',
    auth_type: 'oauth',
    oauth_required: true,
    enabled: true,
    tags: ['productivity', 'google'],
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Search repos, browse issues and PRs, create issues and comments.',
    category: 'official',
    auth_type: 'api_key',
    oauth_required: false,
    enabled: true,
    tags: ['developer', 'github'],
  },
  {
    id: 'fathom',
    name: 'Fathom',
    description: 'Pull meeting transcripts, summaries, and action items from your Fathom recordings.',
    category: 'official',
    auth_type: 'oauth',
    oauth_required: true,
    enabled: true,
    tags: ['productivity', 'meetings'],
  },
  {
    id: 'files',
    name: 'Workspace Files',
    description: 'Read, write, and search files stored in your workspace. First-party storage; no external account required.',
    category: 'official',
    auth_type: 'none',
    oauth_required: false,
    enabled: true,
    tags: ['workspace', 'productivity'],
  },
  {
    id: 'computer',
    name: 'Computer Use',
    description: 'Let the assistant browse and act in a controlled browser: your own Chrome via the sidanclaw extension for account-sensitive sites, or a cloud browser for public ones. Sends require your approval.',
    category: 'official',
    auth_type: 'none',
    oauth_required: false,
    enabled: true,
    tags: ['automation', 'browser', 'workspace'],
  },
  {
    id: 'gcs',
    name: 'Google Cloud Storage',
    description: 'Store your workspace file bytes in your own Google Cloud Storage bucket, under your own key. Your files, your bucket, revocable by you.',
    category: 'official',
    // SA-key paste/upload — closest fit in the directory auth enum is api_key
    // (a pasted secret credential, like the GitHub PAT). The connect UI is a
    // dedicated form, not the generic PAT input. See docs/plans/byo-google-storage.md.
    auth_type: 'api_key',
    oauth_required: false,
    enabled: true,
    tags: ['storage', 'google', 'workspace'],
    // A workspace binds ONE storage bucket; "Add another" is meaningless (and
    // the generic directory-add path would mint a junk user-scoped row).
    single_instance: true,
  },
]

// ── Built-in workspace primitives ─────────────────────────────
//
// Official connectors with `auth_type: 'none'` are first-party workspace
// primitives (e.g. Workspace Files): there is no external account, no OAuth,
// and no meaningful connected/disconnected state — their tools are gated by
// `assistant_capabilities` grants at runtime, not by a connector instance
// (see docs/architecture/features/files.md → "Connector-style governance,
// primitive-style runtime"). The Studio Connectors surface renders them in a
// dedicated always-on "Built-in" group with no connect/disconnect affordance,
// and the browse directory excludes them. Derived from the registry — never
// hardcode a slug list for this (the "all built-ins" drift anti-pattern).

export const BUILTIN_PRIMITIVE_CONNECTOR_IDS: ReadonlySet<string> = new Set(
  OFFICIAL_CONNECTORS.filter((c) => c.auth_type === 'none').map((c) => c.id),
)

// ── Single-instance connectors ────────────────────────────────
//
// Officials marked `single_instance` bind a resource, not an account (gcs —
// one storage bucket per workspace), so the connector surfaces suppress
// "Add another" for them and the multi-account runtime skips them. Derived
// from the registry — never hardcode a slug list for this (the "all
// built-ins" drift anti-pattern).

export const SINGLE_INSTANCE_CONNECTOR_IDS: ReadonlySet<string> = new Set(
  OFFICIAL_CONNECTORS.filter((c) => c.single_instance).map((c) => c.id),
)
