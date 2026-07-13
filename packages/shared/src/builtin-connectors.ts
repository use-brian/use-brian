/**
 * Built-in (official) connector metadata — single source of truth for the
 * web UI's connector tool display AND for the L1/L2 policy toggles.
 *
 * ⚠️ Drift hazard: every tool wired in `packages/api/src/mcp/inject.ts` must
 * also appear in `OFFICIAL_CONNECTOR_TOOLS` below, or users cannot see or
 * govern it (the model will still call it — silent-invisible tool). This has
 * bitten us repeatedly (googleDocsCreate, googleSheetsBatchUpdate,
 * googleSlidesCreatePresentation). Treat this file as co-load-bearing with
 * `inject.ts` — edit both in the same PR.
 *
 * Full checklist for adding a built-in tool:
 *   docs/architecture/integrations/mcp.md → "Adding a new built-in connector tool"
 *
 * For adding a whole new connector, also touch:
 *   1. `connector-registry.ts` — OFFICIAL_CONNECTORS (display metadata)
 *   2. this file — OFFICIAL_CONNECTOR_TOOLS + (if OAuth) OFFICIAL_OAUTH_SCOPES
 *   3. `packages/shared/src/tool-display-names.ts` — friendly names
 *   4. `packages/api/src/mcp/inject.ts` — runtime wiring (tool factories),
 *      INCLUDING the multi-account extras (a credentialed connector is
 *      "Add another"-able by default — consume its extras like the
 *      github/google injectors do, or mark the registry entry `single_instance`)
 *   5. `apps/app-web/src/components/connectors/connector-icon.tsx` — icon
 */

export type BuiltinToolClassification = 'read' | 'write' | 'destructive'
export type BuiltinToolDefaultPolicy = 'allow' | 'ask'

/**
 * Discriminators for a connector's encrypted credentials blob (also the
 * `connector_instance.credentials_type` column value).
 *
 * The first four are custom-MCP outbound auth schemes: `oauth` is the legacy
 * client_id/client_secret pair (no runtime header is derived from it — the
 * OAuth client flow is a separate surface); `bearer` sends
 * `Authorization: Bearer <token>`; `custom_header` sends one named header.
 *
 * `gcs` is a first-party storage credential — a customer service-account key
 * for bring-your-own GCS storage. It is NOT an MCP outbound scheme (it never
 * appears in the custom-connector auth dropdown, which lists an explicit
 * subset) and derives no outbound header. See
 * docs/architecture/integrations/mcp.md → "Custom connector auth" and
 * docs/plans/byo-google-storage.md.
 */
export const CONNECTOR_AUTH_TYPES = ['none', 'oauth', 'bearer', 'custom_header', 'gcs'] as const
export type ConnectorAuthType = (typeof CONNECTOR_AUTH_TYPES)[number]

export type BuiltinConnectorTool = {
  name: string
  description: string
  classification: BuiltinToolClassification
  defaultPolicy: BuiltinToolDefaultPolicy
}

/**
 * Full list of tools each built-in connector exposes, in display order.
 * Must match what `injectMcpTools()` actually injects at runtime —
 * drift here was the cause of the "No tools found" bug for gdrive.
 */
export const OFFICIAL_CONNECTOR_TOOLS: Record<string, BuiltinConnectorTool[]> = {
  gcal: [
    { name: 'googleCalendarListEvents', description: 'List upcoming calendar events', classification: 'read', defaultPolicy: 'allow' },
    { name: 'googleCalendarGetEvent', description: 'Get a specific calendar event', classification: 'read', defaultPolicy: 'allow' },
    { name: 'googleCalendarCreateEvent', description: 'Create a new calendar event', classification: 'write', defaultPolicy: 'ask' },
    { name: 'googleCalendarUpdateEvent', description: 'Update an existing calendar event or RSVP', classification: 'write', defaultPolicy: 'ask' },
    { name: 'googleCalendarDeleteEvent', description: 'Delete a calendar event', classification: 'write', defaultPolicy: 'ask' },
    { name: 'googleTasksListTaskLists', description: 'List all task lists', classification: 'read', defaultPolicy: 'allow' },
    { name: 'googleTasksListTasks', description: 'List tasks in a task list', classification: 'read', defaultPolicy: 'allow' },
    { name: 'googleTasksGetTask', description: 'Get a specific task', classification: 'read', defaultPolicy: 'allow' },
    { name: 'googleTasksCreateTask', description: 'Create a new task', classification: 'write', defaultPolicy: 'ask' },
    { name: 'googleTasksUpdateTask', description: 'Update or complete a task', classification: 'write', defaultPolicy: 'ask' },
    { name: 'googleTasksDeleteTask', description: 'Delete a task', classification: 'write', defaultPolicy: 'ask' },
  ],
  gmail: [
    { name: 'gmailListMessages', description: 'Search Gmail messages', classification: 'read', defaultPolicy: 'allow' },
    { name: 'gmailGetMessage', description: 'Read a specific email', classification: 'read', defaultPolicy: 'allow' },
    { name: 'gmailSendMessage', description: 'Send an email (can attach workspace files)', classification: 'write', defaultPolicy: 'ask' },
  ],
  notion: [
    { name: 'notionSearch', description: 'Search pages and databases in Notion', classification: 'read', defaultPolicy: 'allow' },
    { name: 'notionGetPage', description: 'Get a Notion page with its content', classification: 'read', defaultPolicy: 'allow' },
    { name: 'notionGetDatabase', description: 'Get a Notion database schema', classification: 'read', defaultPolicy: 'allow' },
    { name: 'notionQueryDatabase', description: 'Query a Notion database with filters', classification: 'read', defaultPolicy: 'allow' },
    { name: 'notionCreatePage', description: 'Create a new page in Notion', classification: 'write', defaultPolicy: 'ask' },
    { name: 'notionUpdatePage', description: 'Update a Notion page', classification: 'write', defaultPolicy: 'ask' },
    { name: 'notionAppendBlocks', description: 'Append content to a Notion page', classification: 'write', defaultPolicy: 'ask' },
  ],
  gdrive: [
    // Drive tools are phase-gated (require drive.readonly / drive.file scopes
    // beyond the current Picker-only grant). Uncomment here + in inject.ts
    // when enabling. Keep list ordering stable across services.
    // { name: 'googleDriveListFiles', description: 'Search files in Google Drive', classification: 'read', defaultPolicy: 'allow' },
    // { name: 'googleDriveGetFile', description: 'Get file metadata', classification: 'read', defaultPolicy: 'allow' },
    // { name: 'googleDriveGetFileContent', description: 'Read file content', classification: 'read', defaultPolicy: 'allow' },
    // { name: 'googleDriveCreateFile', description: 'Create a file in Google Drive', classification: 'write', defaultPolicy: 'ask' },
    // { name: 'googleDriveUpdateFile', description: 'Update a file in Google Drive', classification: 'write', defaultPolicy: 'ask' },
    { name: 'googleDocsGetContent', description: 'Read a Google Doc', classification: 'read', defaultPolicy: 'allow' },
    { name: 'googleDocsAppendText', description: 'Append text to a Google Doc', classification: 'write', defaultPolicy: 'ask' },
    { name: 'googleDocsReplaceText', description: 'Find and replace text in a Google Doc', classification: 'write', defaultPolicy: 'ask' },
    { name: 'googleDocsCreate', description: 'Create a new Google Doc', classification: 'write', defaultPolicy: 'ask' },
    { name: 'googleSheetsGetInfo', description: 'Get spreadsheet metadata', classification: 'read', defaultPolicy: 'allow' },
    { name: 'googleSheetsReadRange', description: 'Read a range of cells', classification: 'read', defaultPolicy: 'allow' },
    { name: 'googleSheetsWriteRange', description: 'Write to a cell range', classification: 'write', defaultPolicy: 'ask' },
    { name: 'googleSheetsAppendRows', description: 'Append rows to a spreadsheet', classification: 'write', defaultPolicy: 'ask' },
    { name: 'googleSheetsCreate', description: 'Create a new Google Sheet', classification: 'write', defaultPolicy: 'ask' },
    { name: 'googleSheetsFormat', description: 'Apply formatting to cells in a spreadsheet', classification: 'write', defaultPolicy: 'ask' },
    { name: 'googleSheetsBatchUpdate', description: 'Submit raw Sheets API batchUpdate requests (escape hatch)', classification: 'write', defaultPolicy: 'ask' },
    { name: 'googleSlidesGetPresentation', description: 'Get presentation metadata and slide list', classification: 'read', defaultPolicy: 'allow' },
    { name: 'googleSlidesGetSlideContent', description: 'Read a slide as structured shapes, text, and layout', classification: 'read', defaultPolicy: 'allow' },
    { name: 'googleSlidesGetThumbnail', description: 'Render a slide to a PNG thumbnail', classification: 'read', defaultPolicy: 'allow' },
    { name: 'googleSlidesCreateSlide', description: 'Create a slide with a layout and fill placeholders atomically', classification: 'write', defaultPolicy: 'ask' },
    { name: 'googleSlidesUpdateSlideContent', description: 'Replace text in a slide placeholder or shape', classification: 'write', defaultPolicy: 'ask' },
    { name: 'googleSlidesInsertImage', description: 'Insert an image on a slide from Drive or a URL', classification: 'write', defaultPolicy: 'ask' },
    { name: 'googleSlidesDeleteSlide', description: 'Delete a slide from a presentation', classification: 'write', defaultPolicy: 'ask' },
    { name: 'googleSlidesReorderSlides', description: 'Move slides to a new position', classification: 'write', defaultPolicy: 'ask' },
    { name: 'googleSlidesDuplicateSlide', description: 'Duplicate a slide with its content', classification: 'write', defaultPolicy: 'ask' },
    { name: 'googleSlidesBatchUpdate', description: 'Submit raw Slides API batchUpdate requests (escape hatch)', classification: 'write', defaultPolicy: 'ask' },
    { name: 'googleSlidesCreatePresentation', description: 'Create a new Google Slides presentation', classification: 'write', defaultPolicy: 'ask' },
  ],
  github: [
    { name: 'githubSearchRepositories', description: 'Search GitHub repositories', classification: 'read', defaultPolicy: 'allow' },
    { name: 'githubGetRepository', description: 'Get repository details', classification: 'read', defaultPolicy: 'allow' },
    { name: 'githubListIssues', description: 'List issues for a repository', classification: 'read', defaultPolicy: 'allow' },
    { name: 'githubGetIssue', description: 'Get issue details and comments', classification: 'read', defaultPolicy: 'allow' },
    { name: 'githubListPullRequests', description: 'List pull requests for a repository', classification: 'read', defaultPolicy: 'allow' },
    { name: 'githubGetPullRequest', description: 'Get pull request details', classification: 'read', defaultPolicy: 'allow' },
    { name: 'githubCreateIssue', description: 'Create a new issue', classification: 'write', defaultPolicy: 'ask' },
    { name: 'githubCreateIssueComment', description: 'Comment on an issue or PR', classification: 'write', defaultPolicy: 'ask' },
    { name: 'githubGetFileContents', description: 'Read file or directory contents from a repository', classification: 'read', defaultPolicy: 'allow' },
    { name: 'githubWriteFile', description: 'Create or update a file in a repository', classification: 'write', defaultPolicy: 'ask' },
  ],
  fathom: [
    { name: 'fathomListMeetings', description: 'List recent Fathom meetings', classification: 'read', defaultPolicy: 'allow' },
    { name: 'fathomGetMeeting', description: 'Get a specific Fathom meeting with metadata', classification: 'read', defaultPolicy: 'allow' },
    { name: 'fathomGetTranscript', description: 'Read the transcript of a Fathom meeting', classification: 'read', defaultPolicy: 'allow' },
    { name: 'fathomGetSummary', description: 'Read the AI summary and action items for a Fathom meeting', classification: 'read', defaultPolicy: 'allow' },
  ],
  // Workspace Files — Q3 / company-brain §10. Note: this row is for
  // governance display (Settings ▸ Connectors, Assistant ▸ Tools) only.
  // Runtime injection happens at boot in packages/api/src/boot.ts using the
  // Tasks/CRM pattern (`requiresCapability: 'files'` + `filterToolsByCapabilities`),
  // NOT through `mcp/inject.ts createFilesTools`. Drift hazard: keep tool
  // names here in sync with the tool factories in
  // packages/core/src/workspace-files/tools.ts.
  files: [
    { name: 'fileWrite',   description: 'Create or overwrite a file in the workspace',                  classification: 'write',       defaultPolicy: 'ask' },
    { name: 'fileAppend',  description: 'Append content to an existing workspace file',                  classification: 'write',       defaultPolicy: 'ask' },
    { name: 'fileRead',    description: 'Read a workspace file',                                         classification: 'read',        defaultPolicy: 'allow' },
    { name: 'fileSearch',  description: 'Search workspace files by title, summary, tag, or filename',    classification: 'read',        defaultPolicy: 'allow' },
    { name: 'fileSetMeta', description: 'Update title, summary, tags, or sensitivity on a file',         classification: 'write',       defaultPolicy: 'ask' },
    // saveFileToBrain defaults to allow (not ask): the user explicitly asked
    // to save the attachment, and comment-thread chats surface no
    // confirmation card — an ask default would silently stall those saves.
    // Mirrors requiresConfirmation:false in core/src/workspace-files/tools.ts.
    { name: 'saveFileToBrain', description: 'Save an uploaded attachment to the workspace as a file, preserving the original', classification: 'write', defaultPolicy: 'allow' },
    { name: 'saveFileBytes', description: 'Save a file from raw bytes (base64) to the workspace, preserving the original', classification: 'write', defaultPolicy: 'ask' },
    { name: 'sendFile',    description: 'Attach a workspace file to the reply as a downloadable document', classification: 'read',       defaultPolicy: 'allow' },
    { name: 'fileDelete',  description: 'Permanently delete a workspace file',                           classification: 'destructive', defaultPolicy: 'ask' },
  ],
  // Google Cloud Storage (bring-your-own storage) — a credentialed connector
  // with NO assistant tools. It only rebinds where the Workspace Files bytes
  // layer writes (see docs/plans/byo-google-storage.md). Present here so it
  // counts as an official (non-custom-MCP) connector via OFFICIAL_CONNECTOR_IDS;
  // the empty tool list means it surfaces no governable tools of its own.
  gcs: [],
  // Computer use — governance display for the browser/sandbox tool surface
  // (docs/architecture/engine/computer-use.md §3). Boot-injected like `files`
  // (see BOOT_INJECTED_BUILTIN_TOOLS below), NOT through mcp/inject.ts.
  // browserClick is 'allow' by default because the dynamic send gate inside
  // the tool (resolveConfirmation) asks on send-like clicks — a static 'ask'
  // would gate every composing click too.
  computer: [
    { name: 'browserNavigate', description: 'Open a URL in the controlled browser (as a browser profile)', classification: 'write', defaultPolicy: 'allow' },
    { name: 'browserSnapshot', description: 'List the interactive elements of the current page as refs', classification: 'read', defaultPolicy: 'allow' },
    { name: 'browserClick', description: 'Click an element by ref (send-like clicks require approval)', classification: 'write', defaultPolicy: 'allow' },
    { name: 'browserType', description: 'Type text into an element by ref', classification: 'write', defaultPolicy: 'allow' },
    { name: 'browserCurrentUrl', description: 'Get the current URL and title of the controlled tab', classification: 'read', defaultPolicy: 'allow' },
    // runBrowserSkill is 'allow' by default for the same reason browserClick
    // is: the governed runner gates every terminal send in-flight
    // (grant / async approval / verb ceiling) — a static 'ask' would gate
    // read-only skills too.
    { name: 'runBrowserSkill', description: 'Run a saved browser skill against a browser profile (terminal sends gate via grants/approvals)', classification: 'write', defaultPolicy: 'allow' },
    { name: 'listBrowserSkills', description: 'List the saved browser skills in this workspace', classification: 'read', defaultPolicy: 'allow' },
    { name: 'listBrowserProfiles', description: 'List the workspace browser profiles and which are usable', classification: 'read', defaultPolicy: 'allow' },
    { name: 'browserExplore', description: 'Explore a novel browsing flow with the watched agentic fallback (cloud only; distills into a skill)', classification: 'write', defaultPolicy: 'allow' },
    { name: 'runPython', description: 'Run isolated Python in the task sandbox (no network, paid plans)', classification: 'write', defaultPolicy: 'allow' },
    { name: 'loadFromWorkspace', description: 'Copy a workspace file into the sandbox scratch', classification: 'read', defaultPolicy: 'allow' },
    { name: 'saveToWorkspace', description: 'Save a sandbox scratch file into workspace files', classification: 'write', defaultPolicy: 'ask' },
  ],
}

/**
 * OAuth scopes requested when a user connects a built-in connector.
 * Shared between the backend (mints the authorize URL in `POST /connectors/:id/connect`)
 * and the frontend (falls back to building the URL client-side when the API
 * is unavailable). Backend always prepends `userinfo.email` for identity.
 */
export const OFFICIAL_OAUTH_SCOPES: Record<string, string[]> = {
  gcal: [
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/tasks',
  ],
  gmail: [
    'https://www.googleapis.com/auth/gmail.send',
  ],
  gdrive: [
    // Non-sensitive per-file scope used together with the Google Picker.
    // The app can only touch files the user explicitly picked (or files
    // the app created). No CASA audit required.
    'https://www.googleapis.com/auth/drive.file',
  ],
  fathom: [
    // Single coarse scope today. Fathom may add granular scopes later;
    // when they do, update this list and bump scopeVersion (see the
    // gdrive precedent) so existing users see a "reconnect" banner.
    'public_api',
  ],
}

/**
 * Built-in connector tools that are NOT injected through
 * `packages/api/src/mcp/inject.ts`. Instead they are wired at boot in
 * `packages/api/src/boot.ts` (`bootOpenApi`) using the Tasks/CRM capability-gated pattern
 * (`requiresCapability: 'files'` + `filterToolsByCapabilities`).
 *
 * The Drift Sweep admin surface
 * (`packages/api/src/mcp/drift.ts`) treats this as a legitimate
 * injection source so these tools don't appear as orphans against
 * `OFFICIAL_CONNECTOR_TOOLS`.
 *
 * Source of truth for the actual tool factories:
 *   `packages/core/src/workspace-files/tools.ts`
 *
 * See migration 119 (`workspace_files`).
 */
export const BOOT_INJECTED_BUILTIN_TOOLS: Record<string, readonly string[]> = {
  files: [
    'fileWrite',
    'fileAppend',
    'fileRead',
    'fileSearch',
    'fileSetMeta',
    'saveFileToBrain',
    'sendFile',
    'fileDelete',
  ],
  // Computer use (docs/architecture/engine/computer-use.md): wired at boot
  // from packages/core/src/sandbox/tools.ts, always present (a missing
  // extension/sandbox backend returns a clear tool error, never a hang).
  computer: [
    'browserNavigate',
    'browserSnapshot',
    'browserClick',
    'browserType',
    'browserCurrentUrl',
    'runBrowserSkill',
    'listBrowserSkills',
    'listBrowserProfiles',
    'browserExplore',
    'runPython',
    'loadFromWorkspace',
    'saveToWorkspace',
  ],
}

/**
 * Connector IDs that are built-in (vs. custom remote MCP servers).
 * Derived from OFFICIAL_CONNECTOR_TOOLS so the two can't drift.
 */
export const OFFICIAL_CONNECTOR_IDS = new Set(Object.keys(OFFICIAL_CONNECTOR_TOOLS))

export function isOfficialConnector(connectorId: string): boolean {
  return OFFICIAL_CONNECTOR_IDS.has(connectorId)
}
