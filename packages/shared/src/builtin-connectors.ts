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
 * Display grouping for a connector's tool list. Optional: connectors with a
 * handful of tools stay flat; multi-domain connectors (gdrive, shopify) tag
 * every tool so the tool UI renders one card per group instead of a wall.
 * Group ids are shared across connectors. The localized labels live in the
 * app-web dictionaries (`connectorToolList.toolGroups.<id>`, typed against
 * this union plus the UI-owned `other` fallback bucket) — adding an id here
 * fails app-web's compile until every locale carries a label for it.
 */
export type BuiltinToolGroupId =
  | 'drive'
  | 'docs'
  | 'sheets'
  | 'slides'
  | 'catalog'
  | 'inventory'
  | 'orders'
  | 'customers'
  | 'finance'
  | 'marketing'
  | 'onlineStore'
  | 'analytics'

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
 * for bring-your-own GCS storage. `s3` is its S3-compatible sibling — a
 * customer access-key/secret-key pair (plus bucket/region/endpoint) for
 * bring-your-own S3 storage (AWS S3, MinIO, Cloudflare R2, Backblaze B2, …).
 * Neither is an MCP outbound scheme (they never appear in the custom-connector
 * auth dropdown, which lists an explicit subset) and neither derives an
 * outbound header. See docs/architecture/integrations/mcp.md → "Custom
 * connector auth", docs/plans/byo-google-storage.md, and
 * docs/plans/byo-s3-storage.md.
 */
export const CONNECTOR_AUTH_TYPES = ['none', 'oauth', 'bearer', 'custom_header', 'gcs', 's3', 'imap', 'local', 'cli'] as const
export type ConnectorAuthType = (typeof CONNECTOR_AUTH_TYPES)[number]

export type BuiltinConnectorTool = {
  name: string
  description: string
  classification: BuiltinToolClassification
  defaultPolicy: BuiltinToolDefaultPolicy
  /** Display group. All-or-nothing per connector: tag every tool or none. */
  group?: BuiltinToolGroupId
}

/**
 * Full list of tools each built-in connector exposes, in display order.
 * Must match what `injectMcpTools()` actually injects at runtime —
 * drift here was the cause of the "No tools found" bug for gdrive.
 */
export const OFFICIAL_CONNECTOR_TOOLS: Record<string, BuiltinConnectorTool[]> = {
  gcal: [
    { name: 'googleCalendarListCalendars', description: 'List available calendars and access roles', classification: 'read', defaultPolicy: 'allow' },
    { name: 'googleCalendarListEvents', description: 'List upcoming calendar events', classification: 'read', defaultPolicy: 'allow' },
    { name: 'googleCalendarGetEvent', description: 'Get a specific calendar event', classification: 'read', defaultPolicy: 'allow' },
    { name: 'googleCalendarQueryFreeBusy', description: 'Find common availability across calendars or attendees', classification: 'read', defaultPolicy: 'allow' },
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
    { name: 'googleDriveListFiles', description: 'Search files in Google Drive', classification: 'read', defaultPolicy: 'allow', group: 'drive' },
    { name: 'googleDriveGetFile', description: 'Get file metadata', classification: 'read', defaultPolicy: 'allow', group: 'drive' },
    { name: 'googleDriveGetFileContent', description: 'Read file content', classification: 'read', defaultPolicy: 'allow', group: 'drive' },
    // { name: 'googleDriveCreateFile', description: 'Create a file in Google Drive', classification: 'write', defaultPolicy: 'ask', group: 'drive' },
    // { name: 'googleDriveUpdateFile', description: 'Update a file in Google Drive', classification: 'write', defaultPolicy: 'ask', group: 'drive' },
    { name: 'googleDocsGetContent', description: 'Read a Google Doc', classification: 'read', defaultPolicy: 'allow', group: 'docs' },
    { name: 'googleDocsAppendText', description: 'Append text to a Google Doc', classification: 'write', defaultPolicy: 'ask', group: 'docs' },
    { name: 'googleDocsReplaceText', description: 'Find and replace text in a Google Doc', classification: 'write', defaultPolicy: 'ask', group: 'docs' },
    { name: 'googleDocsCreate', description: 'Create a new Google Doc', classification: 'write', defaultPolicy: 'ask', group: 'docs' },
    { name: 'googleSheetsGetInfo', description: 'Get spreadsheet metadata', classification: 'read', defaultPolicy: 'allow', group: 'sheets' },
    { name: 'googleSheetsReadRange', description: 'Read a range of cells', classification: 'read', defaultPolicy: 'allow', group: 'sheets' },
    { name: 'googleSheetsWriteRange', description: 'Write to a cell range', classification: 'write', defaultPolicy: 'ask', group: 'sheets' },
    { name: 'googleSheetsAppendRows', description: 'Append rows to a spreadsheet', classification: 'write', defaultPolicy: 'ask', group: 'sheets' },
    { name: 'googleSheetsCreate', description: 'Create a new Google Sheet', classification: 'write', defaultPolicy: 'ask', group: 'sheets' },
    { name: 'googleSheetsFormat', description: 'Apply formatting to cells in a spreadsheet', classification: 'write', defaultPolicy: 'ask', group: 'sheets' },
    { name: 'googleSheetsBatchUpdate', description: 'Submit raw Sheets API batchUpdate requests (escape hatch)', classification: 'write', defaultPolicy: 'ask', group: 'sheets' },
    { name: 'googleSlidesGetPresentation', description: 'Get presentation metadata and slide list', classification: 'read', defaultPolicy: 'allow', group: 'slides' },
    { name: 'googleSlidesGetSlideContent', description: 'Read a slide as structured shapes, text, and layout', classification: 'read', defaultPolicy: 'allow', group: 'slides' },
    { name: 'googleSlidesGetThumbnail', description: 'Render a slide to a PNG thumbnail', classification: 'read', defaultPolicy: 'allow', group: 'slides' },
    { name: 'googleSlidesCreateSlide', description: 'Create a slide with a layout and fill placeholders atomically', classification: 'write', defaultPolicy: 'ask', group: 'slides' },
    { name: 'googleSlidesUpdateSlideContent', description: 'Replace text in a slide placeholder or shape', classification: 'write', defaultPolicy: 'ask', group: 'slides' },
    { name: 'googleSlidesInsertImage', description: 'Insert an image on a slide from Drive or a URL', classification: 'write', defaultPolicy: 'ask', group: 'slides' },
    { name: 'googleSlidesDeleteSlide', description: 'Delete a slide from a presentation', classification: 'write', defaultPolicy: 'ask', group: 'slides' },
    { name: 'googleSlidesReorderSlides', description: 'Move slides to a new position', classification: 'write', defaultPolicy: 'ask', group: 'slides' },
    { name: 'googleSlidesDuplicateSlide', description: 'Duplicate a slide with its content', classification: 'write', defaultPolicy: 'ask', group: 'slides' },
    { name: 'googleSlidesBatchUpdate', description: 'Submit raw Slides API batchUpdate requests (escape hatch)', classification: 'write', defaultPolicy: 'ask', group: 'slides' },
    { name: 'googleSlidesCreatePresentation', description: 'Create a new Google Slides presentation', classification: 'write', defaultPolicy: 'ask', group: 'slides' },
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
  // Shopify — v1 slice (docs/architecture/integrations/shopify.md; full catalog
  // in docs/plans/shopify-connector.md §5). Classification is load-bearing:
  // `write` rows are auto-wrapped by gateToolsOnActionGrants — a write
  // misclassified as `read` ships UNGATED. Rows are ordered in contiguous
  // `group` blocks — registry order is display order, and the tool UI renders
  // one card per group.
  shopify: [
    { name: 'shopifyGetShop', description: 'Get store name, domain, plan, currency, and timezone', classification: 'read', defaultPolicy: 'allow', group: 'catalog' },
    { name: 'shopifyListProducts', description: 'Search and list products in the store', classification: 'read', defaultPolicy: 'allow', group: 'catalog' },
    { name: 'shopifyGetProduct', description: 'Get a product with variants and inventory', classification: 'read', defaultPolicy: 'allow', group: 'catalog' },
    { name: 'shopifyListCollections', description: 'List product collections in the store', classification: 'read', defaultPolicy: 'allow', group: 'catalog' },
    { name: 'shopifyUpdateProduct', description: 'Update product title, description, tags, status, or SEO', classification: 'write', defaultPolicy: 'ask', group: 'catalog' },
    { name: 'shopifyCreateProduct', description: 'Create a new product', classification: 'write', defaultPolicy: 'ask', group: 'catalog' },
    { name: 'shopifyAddProductImage', description: 'Upload a workspace file to a product as a product image', classification: 'write', defaultPolicy: 'ask', group: 'catalog' },
    { name: 'shopifySetProductPrice', description: 'Set a product variant price, compare-at price, and SKU', classification: 'write', defaultPolicy: 'ask', group: 'catalog' },
    { name: 'shopifyPublishProduct', description: 'Publish a product to the Online Store so customers can see it', classification: 'write', defaultPolicy: 'ask', group: 'catalog' },
    { name: 'shopifySetProductMetafields', description: 'Set structured metafields on a product (theme must read them to display)', classification: 'write', defaultPolicy: 'ask', group: 'catalog' },
    { name: 'shopifySetProductOptions', description: 'Rename a product option and its values (the storefront variant picker labels)', classification: 'write', defaultPolicy: 'ask', group: 'catalog' },
    { name: 'shopifyGetInventoryLevels', description: 'Get inventory quantities by product or SKU', classification: 'read', defaultPolicy: 'allow', group: 'inventory' },
    { name: 'shopifySetInventory', description: 'Set the available inventory quantity for a variant', classification: 'write', defaultPolicy: 'ask', group: 'inventory' },
    { name: 'shopifyListOrders', description: 'List orders with date, status, and payment filters', classification: 'read', defaultPolicy: 'allow', group: 'orders' },
    { name: 'shopifyGetOrder', description: 'Get an order with line items, fulfillment, and totals', classification: 'read', defaultPolicy: 'allow', group: 'orders' },
    { name: 'shopifyListDraftOrders', description: 'List draft orders (open quotes and invoices)', classification: 'read', defaultPolicy: 'allow', group: 'orders' },
    { name: 'shopifyListAbandonedCheckouts', description: 'List abandoned checkouts with cart value and customer', classification: 'read', defaultPolicy: 'allow', group: 'orders' },
    { name: 'shopifyCreateDraftOrder', description: 'Create a draft order (quote or invoice, never a charge)', classification: 'write', defaultPolicy: 'ask', group: 'orders' },
    { name: 'shopifySendDraftOrderInvoice', description: 'Email the invoice for a draft order', classification: 'write', defaultPolicy: 'ask', group: 'orders' },
    { name: 'shopifyCreateFulfillment', description: 'Mark an order fulfilled with an optional tracking number', classification: 'write', defaultPolicy: 'ask', group: 'orders' },
    { name: 'shopifyCompleteDraftOrder', description: 'Convert a draft order into a real order', classification: 'destructive', defaultPolicy: 'ask', group: 'orders' },
    { name: 'shopifyCancelOrder', description: 'Cancel an order, optionally restocking and notifying the customer', classification: 'destructive', defaultPolicy: 'ask', group: 'orders' },
    { name: 'shopifyRefundOrder', description: 'Refund an order in full or by line item', classification: 'destructive', defaultPolicy: 'ask', group: 'orders' },
    { name: 'shopifySearchCustomers', description: 'Search customers by email, name, or tag', classification: 'read', defaultPolicy: 'allow', group: 'customers' },
    { name: 'shopifyGetCustomer', description: 'Get a customer with order count and total spent', classification: 'read', defaultPolicy: 'allow', group: 'customers' },
    { name: 'shopifyUpdateCustomer', description: 'Update a customer note or tags (never marketing consent)', classification: 'write', defaultPolicy: 'ask', group: 'customers' },
    { name: 'shopifyGetPayoutsSummary', description: 'Get Shopify Payments balance and recent payouts', classification: 'read', defaultPolicy: 'allow', group: 'finance' },
    { name: 'shopifyListDisputes', description: 'List Shopify Payments disputes and chargebacks', classification: 'read', defaultPolicy: 'allow', group: 'finance' },
    { name: 'shopifyListDiscounts', description: 'List discount and promo codes with status and usage counts', classification: 'read', defaultPolicy: 'allow', group: 'marketing' },
    { name: 'shopifyCreateDiscountCode', description: 'Create a discount or promo code', classification: 'write', defaultPolicy: 'ask', group: 'marketing' },
    { name: 'shopifyAddTags', description: 'Add tags to an order, customer, or product', classification: 'write', defaultPolicy: 'ask', group: 'marketing' },
    { name: 'shopifyListContent', description: 'List online store pages, blog posts, or blogs', classification: 'read', defaultPolicy: 'allow', group: 'onlineStore' },
    { name: 'shopifyCreateContent', description: 'Create an online store page or blog post', classification: 'write', defaultPolicy: 'ask', group: 'onlineStore' },
    { name: 'shopifyListThemes', description: 'List online store themes and which one is live', classification: 'read', defaultPolicy: 'allow', group: 'onlineStore' },
    { name: 'shopifyListProductTemplates', description: 'List the product page templates a theme already has, with their section stacks', classification: 'read', defaultPolicy: 'allow', group: 'onlineStore' },
    { name: 'shopifyReadProductTemplate', description: 'Read a product page template from the theme', classification: 'read', defaultPolicy: 'allow', group: 'onlineStore' },
    // Destructive, not write: this lands a file in the theme customers are
    // served from, and a broken page is invisible in the Shopify admin.
    { name: 'shopifyCreateProductTemplate', description: 'Create a new product page template in the theme', classification: 'destructive', defaultPolicy: 'ask', group: 'onlineStore' },
    { name: 'shopifySetProductTemplate', description: 'Change which page template a product uses', classification: 'write', defaultPolicy: 'ask', group: 'onlineStore' },
    { name: 'shopifySalesReport', description: 'Aggregate sales over a date range (count, revenue, top items)', classification: 'read', defaultPolicy: 'allow', group: 'analytics' },
    { name: 'shopifyStorefrontFunnel', description: 'Storefront conversion funnel: sessions, cart additions, checkouts reached and completed', classification: 'read', defaultPolicy: 'allow', group: 'analytics' },
    { name: 'shopifyAnalyticsQuery', description: 'Run a read-only ShopifyQL query against store analytics', classification: 'read', defaultPolicy: 'allow', group: 'analytics' },
  ],
  // Microsoft Teams (Graph) — READ-ONLY, permanently (decision D1). Graph
  // publishes no application permission for sending, so every Graph write is
  // attributed to a human rather than to the assistant; sending stays on the
  // Teams bot. No write tool may be added here or to the factory in
  // packages/core/src/tools/base/msgraph.ts. Classification is the mechanical
  // half of that rule: a write misclassified as `read` ships past
  // gateToolsOnActionGrants ungated. Descriptions are condensed from the
  // authoritative `buildTool({ description })` text on each tool — keep the
  // two consistent. See docs/architecture/integrations/msgraph.md §1, §7.
  msgraph: [
    { name: 'msTeamsListTeams', description: 'List the teams in the tenant, including ones the assistant was never added to', classification: 'read', defaultPolicy: 'allow' },
    { name: 'msTeamsListChannels', description: 'List the channels in a team, each marked standard, private, or shared', classification: 'read', defaultPolicy: 'allow' },
    { name: 'msTeamsReadChannelMessages', description: 'Read recent root messages in a channel, including history from before the assistant joined', classification: 'read', defaultPolicy: 'allow' },
    { name: 'msTeamsReadThreadReplies', description: 'Read the replies in one channel thread', classification: 'read', defaultPolicy: 'allow' },
    { name: 'msTeamsListChats', description: "List the direct messages and group chats the connected user is in", classification: 'read', defaultPolicy: 'allow' },
    { name: 'msTeamsReadChatMessages', description: 'Read recent messages in one chat (a direct message or group chat)', classification: 'read', defaultPolicy: 'allow' },
    { name: 'msTeamsSearchMessages', description: 'Search across the Teams channels and chats the connected user can see', classification: 'read', defaultPolicy: 'allow' },
    { name: 'msTeamsListMembers', description: 'List the members of a team, or of one channel in it', classification: 'read', defaultPolicy: 'allow' },
    { name: 'msTeamsFindPerson', description: "Find a person by name, email, or directory id in the organization directory or one team's roster", classification: 'read', defaultPolicy: 'allow' },
  ],
  // Assistant Email (AgentMail) — the assistant's OWN mailbox. Sends go out
  // from the assistant's address, never the user's (that is Gmail); see
  // docs/architecture/integrations/agentmail.md → "Connector tools".
  agentmail: [
    { name: 'agentmailSendMessage', description: "Send an email from the assistant's own address", classification: 'write', defaultPolicy: 'ask' },
    { name: 'agentmailSearchThreads', description: "Search the assistant's own mailbox threads", classification: 'read', defaultPolicy: 'allow' },
    { name: 'agentmailCreateDraft', description: "Create an unsent draft in the assistant's mailbox (supports scheduled send)", classification: 'write', defaultPolicy: 'ask' },
  ],
  // Company mailbox (IMAP/SMTP) — the USER'S own corporate mailbox (third
  // identity lane beside gmail and agentmail; see
  // docs/architecture/integrations/mailbox-imap.md). Generic `imap` provider;
  // AliMail is a connect-time preset, never a branded connector (D1).
  imap: [
    { name: 'imapSearchMessages', description: "Summarize, check, or search email in the user's connected email account (INBOX + Sent)", classification: 'read', defaultPolicy: 'allow' },
    { name: 'imapGetMessage', description: "Read a specific email from the user's connected email account", classification: 'read', defaultPolicy: 'allow' },
    { name: 'imapSendMessage', description: "Send email with optional workspace-file attachments from the user's connected email account", classification: 'write', defaultPolicy: 'ask' },
    // Read/allow like syncMailboxNow: it writes only inside the workspace
    // (one inbound email attachment becomes a workspace file). Any later
    // egress stays separately gated by sendFile or imapSendMessage.
    // See mailbox-imap.md → "Attachments".
    { name: 'imapSaveAttachment', description: 'Save an email attachment into the workspace as a file', classification: 'read', defaultPolicy: 'allow' },
    { name: 'searchEmailArchive', description: 'Search the synced email archive by meaning', classification: 'read', defaultPolicy: 'allow' },
    { name: 'syncMailboxNow', description: 'Pull new email into the searchable email archive now', classification: 'read', defaultPolicy: 'allow' },
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
  // Brand — the positioning record (docs/architecture/features/brand.md).
  // Boot-injected like `files` (see BOOT_INJECTED_BUILTIN_TOOLS below), NOT
  // through mcp/inject.ts. `updateBrandDraft` is classified `write`, not
  // `destructive`: it can only ever replace the mutable draft, and approval
  // — the irreversible step — is a Studio action no tool can reach.
  brand: [
    { name: 'getBrand', description: 'Read the workspace brand record (tokens, voice, claims, rights, sources)', classification: 'read', defaultPolicy: 'allow' },
    { name: 'updateBrandDraft', description: 'Propose a change to the brand draft (an owner or admin approves it in Studio)', classification: 'write', defaultPolicy: 'ask' },
  ],
  office: [
    { name: 'createOfficeArtifact', description: 'Start a durable Brian-native Document or Presentation job', classification: 'write', defaultPolicy: 'allow' },
    { name: 'getOfficeArtifact', description: 'Read an Office artifact and its current generation state', classification: 'read', defaultPolicy: 'allow' },
    { name: 'reviseOfficeArtifact', description: 'Start an undoable Office revision or proposal job', classification: 'write', defaultPolicy: 'allow' },
  ],
  // Google Cloud Storage (bring-your-own storage) — a credentialed connector
  // with NO assistant tools. It only rebinds where the Workspace Files bytes
  // layer writes (see docs/plans/byo-google-storage.md). Present here so it
  // counts as an official (non-custom-MCP) connector via OFFICIAL_CONNECTOR_IDS;
  // the empty tool list means it surfaces no governable tools of its own.
  gcs: [],
  s3: [],
  local: [],
  cli: [],
  // Computer use — governance display for the browser/sandbox tool surface
  // (docs/architecture/engine/computer-use.md §3). Boot-injected like `files`
  // (see BOOT_INJECTED_BUILTIN_TOOLS below), NOT through mcp/inject.ts.
  // browserClick is 'allow' by default because the dynamic send gate inside
  // the tool (resolveConfirmation) asks on send-like clicks — a static 'ask'
  // would gate every composing click too.
  computer: [
    { name: 'browserNavigate', description: 'Open a URL in the controlled browser (as a browser profile)', classification: 'write', defaultPolicy: 'allow' },
    { name: 'browserOpenTab', description: 'Open an additional tab in the active local browser profile', classification: 'write', defaultPolicy: 'allow' },
    { name: 'browserListTabs', description: 'List tabs allowed by the active local browser profile', classification: 'read', defaultPolicy: 'allow' },
    { name: 'browserSwitchTab', description: 'Switch to an allowed tab in the active local browser profile', classification: 'write', defaultPolicy: 'allow' },
    { name: 'browserCloseTab', description: 'Close an allowed local-browser tab after confirmation', classification: 'write', defaultPolicy: 'allow' },
    { name: 'browserSnapshot', description: 'List the interactive elements of the current page as refs', classification: 'read', defaultPolicy: 'allow' },
    { name: 'browserClick', description: 'Click an element by ref (send-like clicks require approval)', classification: 'write', defaultPolicy: 'allow' },
    { name: 'browserType', description: 'Type text into an element by ref', classification: 'write', defaultPolicy: 'allow' },
    { name: 'browserCurrentUrl', description: 'Get the current URL and title of the controlled tab', classification: 'read', defaultPolicy: 'allow' },
    // browserReadPage is the sends-forbidden reader research workers use
    // (cloud-only, identity-less, no click/type surface at all). It is not
    // injected into interactive turns — see computer-use.md → "Reaching the
    // browser" — but it is model-callable, so it stays governable here.
    { name: 'browserReadPage', description: 'Read a rendered page in the governed cloud browser (read-only; used by research workers)', classification: 'read', defaultPolicy: 'allow' },
    // runBrowserSkill is 'allow' by default for the same reason browserClick
    // is: the governed runner gates every terminal send in-flight
    // (grant / async approval / verb ceiling) — a static 'ask' would gate
    // read-only skills too.
    { name: 'runBrowserSkill', description: 'Run a saved browser skill against a browser profile (terminal sends gate via grants/approvals)', classification: 'write', defaultPolicy: 'allow' },
    { name: 'saveBrowserSkill', description: 'Save recent browser actions as a reusable skill', classification: 'write', defaultPolicy: 'allow' },
    { name: 'listBrowserSkills', description: 'List the saved browser skills in this workspace', classification: 'read', defaultPolicy: 'allow' },
    { name: 'listBrowserProfiles', description: 'List the workspace browser profiles and which are usable', classification: 'read', defaultPolicy: 'allow' },
    { name: 'browserExplore', description: 'Explore a novel browsing flow with the watched agentic fallback (cloud only; distills into a skill)', classification: 'write', defaultPolicy: 'allow' },
    { name: 'runPython', description: 'Run isolated Python in the task sandbox (no network, paid plans)', classification: 'write', defaultPolicy: 'allow' },
    { name: 'loadFromWorkspace', description: 'Copy a workspace file into the sandbox scratch', classification: 'read', defaultPolicy: 'allow' },
    { name: 'saveToWorkspace', description: 'Save a sandbox scratch file into workspace files', classification: 'write', defaultPolicy: 'ask' },
  ],
}

/**
 * Grouping view over a connector's tool table, for the tool-list UI
 * (`connector-tool-list.tsx`): `order` is the group ids in first-appearance
 * order (registry order is display order), `byTool` maps tool name → group.
 * An empty `order` means the connector's list renders flat.
 */
export function connectorToolGrouping(connectorId: string): {
  order: BuiltinToolGroupId[]
  byTool: Record<string, BuiltinToolGroupId>
} {
  const order: BuiltinToolGroupId[] = []
  const byTool: Record<string, BuiltinToolGroupId> = {}
  for (const tool of OFFICIAL_CONNECTOR_TOOLS[connectorId] ?? []) {
    if (!tool.group) continue
    byTool[tool.name] = tool.group
    if (!order.includes(tool.group)) order.push(tool.group)
  }
  return { order, byTool }
}

/**
 * Connectors whose OAuth *app* credentials a workspace may supply itself,
 * through Studio -> Connectors instead of deployment config.
 *
 * This is deliberately NARROW and hand-maintained, in the sanctioned sense of
 * the "all built-ins" drift rule: it is not "every official connector", it is
 * the set whose provider model actually supports a customer registering their
 * own app. For `msgraph` that model is the point rather than a fallback - an
 * Entra app registered by the customer's own admin sidesteps both Microsoft
 * publisher verification and the cross-tenant admin consent that
 * `ChannelMessage.Read.All` demands unconditionally.
 * For `gdrive`, the customer's Internal Google Workspace app owns the
 * restricted `drive.readonly` grant, keeping it off Brian's public app.
 *
 * Adding a connector here requires three things to already be true: the
 * provider must let an end customer register an app, the authorize URL must be
 * derivable from that app alone, and the exchange must run server-side (see
 * `packages/api/src/connectors/app-credentials.ts`). Adding an id with no
 * route support ships a form that saves credentials nothing reads.
 *
 * See docs/architecture/integrations/msgraph.md -> "Auth" and
 * docs/architecture/integrations/mcp.md -> "The `gdrive` connector".
 */
export const CONFIGURABLE_APP_CREDENTIAL_CONNECTORS: ReadonlySet<string> = new Set(['msgraph', 'gdrive'])

/**
 * OIDC baseline scopes for the Microsoft Graph connector, requested alongside
 * whatever Graph permissions `OFFICIAL_OAUTH_SCOPES.msgraph` declares.
 *
 * They are deliberately NOT in that table: it is the inventory of Graph
 * *resource* permissions an admin reads on the consent screen, and Entra
 * collapses openid/profile/email into a single "Sign you in and read your
 * profile" line. `openid` is also what produces the `id_token` the connect
 * flow reads the tenant id and account address from.
 *
 * Lives in shared because the authorize URL (app-web, browser) and the code
 * exchange (packages/api, server) must send the SAME scope string, and they
 * are in different packages. A second hand-written list is exactly how an
 * authorize/exchange pair drifts.
 */
export const MSGRAPH_BASE_SCOPES: readonly string[] = ['openid', 'profile', 'email']

/** The full msgraph scope set: OIDC baseline + the declared Graph permissions. */
export function msGraphScopes(): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const scope of [...MSGRAPH_BASE_SCOPES, ...(OFFICIAL_OAUTH_SCOPES.msgraph ?? [])]) {
    if (seen.has(scope)) continue
    seen.add(scope)
    out.push(scope)
  }
  return out
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
  // Microsoft Graph, delegated (D3 — search is delegated-only, so an app-only
  // grant could enumerate but never find). Every scope here is a line the
  // tenant admin reads on the consent screen, so the set is the minimum the
  // nine read tools need and nothing more: no `People.Read` (managed-policy
  // exclusion, relevance ranking is a nice-to-have), no `Presence.Read.All`,
  // no `Files.Read.All` / `Sites.Read.All`, nothing meeting-related. There is
  // no Send / ReadWrite / Migrate scope and there never will be — D1.
  // `ChannelMessage.Read.All` forces admin consent unconditionally, which is
  // free under BYO (D2): the consenting admin IS the person who registered
  // the Entra app for the Azure Bot.
  // See docs/architecture/integrations/msgraph.md §6 and research §5.1.
  msgraph: [
    'offline_access',
    'User.Read',
    'User.ReadBasic.All',
    'Team.ReadBasic.All',
    'Channel.ReadBasic.All',
    'ChannelMessage.Read.All',
    'Chat.Read',
    'TeamMember.Read.All',
    'ChannelMember.Read.All',
  ],
  shopify: [
    // Full catalog scope set (docs/plans/shopify-connector.md §6 + D13: the
    // app registered with zero installs, so the two-wave split collapsed and
    // everything is requested at install). NOT read_all_orders - it is
    // approval-gated by Shopify; add it here only AFTER the approval lands
    // (requesting it unapproved breaks the consent screen), and if real
    // installs exist by then, bump scopeVersion (D12) for the reconnect banner.
    //
    // This list is DERIVED from the operations in packages/api/src/shopify/
    // client.ts, not hand-guessed: `scripts/validate-shopify-graphql.mjs`
    // reports the scopes each operation requires. Re-run it after adding or
    // editing any operation. A scope error is invisible to every test we have
    // (they mock fetch, so nothing ever checks a grant) and only surfaces as
    // an access-denied against a real install.
    'read_products',
    'write_products',
    'read_orders',
    'write_orders',
    'read_customers',
    'write_customers',
    'read_draft_orders',
    'write_draft_orders',
    'read_discounts',
    'write_discounts',
    'read_inventory',
    'write_inventory',
    // Location fields other than `id` have required read_locations since API
    // 2024-07. Both inventory operations select `location { name }`, so
    // without this shopifyGetInventoryLevels and shopifySetInventory (which
    // resolves its location through the same query) fail access-denied.
    'read_locations',
    // Two DISTINCT families, both needed. read/write_fulfillments cover the
    // Fulfillment resource itself (GetOrder selects `fulfillments`,
    // fulfillmentCreate returns one); the *_fulfillment_orders scopes cover
    // FulfillmentOrder, which is what shopifyCreateFulfillment resolves and
    // passes as `lineItemsByFulfillmentOrder`. Granting only the first family
    // leaves that tool broken end to end.
    'read_fulfillments',
    'write_fulfillments',
    // The merchant_managed + third_party pair is the documented posture for an
    // order-management app. The *_assigned_fulfillment_orders scopes are for
    // apps that ARE a fulfillment service registering their own locations,
    // which we are not, so they stay out (App Store rule 3.2: request only
    // what the app needs).
    'read_merchant_managed_fulfillment_orders',
    'write_merchant_managed_fulfillment_orders',
    'read_third_party_fulfillment_orders',
    'write_third_party_fulfillment_orders',
    // Pages/articles/blogs need the granular online-store-pages pair in
    // addition to the broader content pair.
    'read_content',
    'write_content',
    'read_online_store_pages',
    'write_online_store_pages',
    // Payouts and disputes both resolve through shopifyPaymentsAccount, which
    // requires read_shopify_payments OR read_shopify_payments_accounts - an
    // either/or, not both. Only the granular one is offered in the Dev
    // Dashboard, so that is the one we request; do NOT re-add
    // `read_shopify_payments` from validator output (it reports alternatives
    // alongside requirements, and the app config rejects the broad name).
    'read_shopify_payments_accounts',
    'read_shopify_payments_payouts',
    'read_shopify_payments_disputes',
    // shopifyPublishProduct only. `productCreate` leaves a product UNPUBLISHED
    // no matter what `status` says, so without this pair a product created
    // through the connector can never reach the storefront.
    'read_publications',
    'write_publications',
    // shopifyStorefrontFunnel + shopifyAnalyticsQuery (the `shopifyqlQuery`
    // Admin field). Storefront session/traffic data has no other source - the
    // rest of the connector reads entities, and no amount of order fetching
    // reconstructs how many visitors added to cart and left.
    //
    // Shopify's denial ALSO names "Level 2 access to Customer data". For a
    // custom-distribution app that is granted at install; a public app must be
    // approved for it. If a merchant's install is denied with the scope
    // present, that approval is what is missing - relay it rather than
    // retrying.
    'read_reports',
    // NOT listed, on purpose: `read_themes` / `write_themes`.
    //
    // The four theme-template tools need them, but theme access is the most
    // dangerous grant this connector could ask for — a bad write breaks the
    // storefront for every visitor, and unlike a bad product it is invisible
    // in the Shopify admin. Requesting it from every merchant to serve the
    // minority who author product pages is a trust cost that buys nothing for
    // the rest, so it is OPT-IN: a merchant who wants page authoring adds the
    // pair to their own app, and until they do the tools fail with Shopify's
    // own honest "Required access: read_themes access scope" error rather than
    // silently doing nothing. Moving them into this list would flip that
    // default for every install — do it deliberately or not at all.
    // See docs/architecture/integrations/shopify.md → "Theme product templates".
  ],
}

/**
 * Customer-owned Google Drive grant. Kept separate from
 * `OFFICIAL_OAUTH_SCOPES.gdrive`: that table is Brian's managed app and must
 * never acquire the restricted full-Drive scope by accident.
 */
export const GDRIVE_BYO_OAUTH_SCOPES: readonly string[] = [
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
]

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
  office: [
    'createOfficeArtifact',
    'getOfficeArtifact',
    'reviseOfficeArtifact',
  ],
  // Brand (docs/architecture/features/brand.md): wired at boot from
  // packages/core/src/brand/tools.ts, gated on the `brand` capability.
  brand: [
    'getBrand',
    'updateBrandDraft',
  ],
  // Computer use (docs/architecture/engine/computer-use.md): wired at boot
  // from packages/core/src/sandbox/tools.ts, always present (a missing
  // extension/sandbox backend returns a clear tool error, never a hang).
  computer: [
    'browserNavigate',
    'browserOpenTab',
    'browserListTabs',
    'browserSwitchTab',
    'browserCloseTab',
    'browserSnapshot',
    'browserClick',
    'browserType',
    'browserCurrentUrl',
    'browserReadPage',
    'runBrowserSkill',
    'saveBrowserSkill',
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
