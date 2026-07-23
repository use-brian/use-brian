/**
 * Human-readable display names for tools shown in confirmation prompts.
 *
 * Used by Telegram, Slack, and web routes when asking users to approve
 * a tool action. Maps internal camelCase tool names to short, plain
 * English descriptions so users see "Create calendar event" instead of
 * "googleCalendarCreateEvent".
 */

const TOOL_DISPLAY_NAMES: Record<string, string> = {
  // Google Calendar
  googleCalendarListEvents: 'List calendar events',
  googleCalendarGetEvent: 'View calendar event',
  googleCalendarCreateEvent: 'Create calendar event',
  googleCalendarUpdateEvent: 'Update calendar event',
  googleCalendarDeleteEvent: 'Delete calendar event',

  // Gmail
  gmailListMessages: 'List emails',
  gmailGetMessage: 'Read email',
  gmailSendMessage: 'Send email',

  // Google Drive
  googleDriveListFiles: 'List Drive files',
  googleDriveGetFile: 'View Drive file info',
  googleDriveGetFileContent: 'Read Drive file',
  googleDriveCreateFile: 'Create Drive file',
  googleDriveUpdateFile: 'Update Drive file',

  // Google Docs
  googleDocsGetContent: 'Read Google Doc',
  googleDocsAppendText: 'Append to Google Doc',
  googleDocsReplaceText: 'Find & replace in Google Doc',
  googleDocsCreate: 'Create Google Doc',

  // Google Sheets
  googleSheetsGetInfo: 'View spreadsheet info',
  googleSheetsReadRange: 'Read spreadsheet data',
  googleSheetsWriteRange: 'Write to spreadsheet',
  googleSheetsAppendRows: 'Append rows to spreadsheet',
  googleSheetsCreate: 'Create Google Sheet',
  googleSheetsFormat: 'Format spreadsheet',
  googleSheetsBatchUpdate: 'Apply spreadsheet changes',

  // Google Slides
  googleSlidesGetPresentation: 'View presentation',
  googleSlidesGetSlideContent: 'Read slide content',
  googleSlidesGetThumbnail: 'Preview slide',
  googleSlidesCreateSlide: 'Create slide',
  googleSlidesUpdateSlideContent: 'Edit slide text',
  googleSlidesInsertImage: 'Insert image on slide',
  googleSlidesDeleteSlide: 'Delete slide',
  googleSlidesReorderSlides: 'Reorder slides',
  googleSlidesDuplicateSlide: 'Duplicate slide',
  googleSlidesBatchUpdate: 'Apply slides changes',
  googleSlidesCreatePresentation: 'Create Google Slides presentation',

  // Google Drive — local index of files the assistant created
  findGDriveFiles: 'Search my Google Drive files',

  // Google Tasks
  googleTasksListTaskLists: 'List task lists',
  googleTasksListTasks: 'List tasks',
  googleTasksGetTask: 'View task',
  googleTasksCreateTask: 'Create task',
  googleTasksUpdateTask: 'Update task',
  googleTasksDeleteTask: 'Delete task',

  // Notion
  notionSearch: 'Search Notion',
  notionGetPage: 'Read Notion page',
  notionGetDatabase: 'View Notion database',
  notionQueryDatabase: 'Query Notion database',
  notionCreatePage: 'Create Notion page',
  notionUpdatePage: 'Update Notion page',
  notionAppendBlocks: 'Append to Notion page',

  // GitHub
  githubSearchRepositories: 'Search GitHub repos',
  githubGetRepository: 'View GitHub repo',
  githubListIssues: 'List GitHub issues',
  githubGetIssue: 'View GitHub issue',
  githubListPullRequests: 'List pull requests',
  githubGetPullRequest: 'View pull request',
  githubCreateIssue: 'Create GitHub issue',
  githubCreateIssueComment: 'Comment on GitHub issue',
  githubGetFileContents: 'Read GitHub file',
  githubWriteFile: 'Write GitHub file',

  // Fathom
  fathomListMeetings: 'List Fathom meetings',
  fathomGetMeeting: 'View Fathom meeting',
  fathomGetTranscript: 'Read meeting transcript',
  fathomGetSummary: 'Read meeting summary',

  // Shopify
  shopifyGetShop: 'View store info',
  shopifyListProducts: 'List products',
  shopifyGetProduct: 'View product',
  shopifyListOrders: 'List orders',
  shopifyGetOrder: 'View order',
  shopifySearchCustomers: 'Search customers',
  shopifyGetCustomer: 'View customer',
  shopifyGetInventoryLevels: 'Check inventory',
  shopifyListCollections: 'List collections',
  shopifyListDraftOrders: 'List draft orders',
  shopifyListDiscounts: 'List discount codes',
  shopifyListAbandonedCheckouts: 'List abandoned checkouts',
  shopifyGetPayoutsSummary: 'View payouts',
  shopifyListDisputes: 'List disputes',
  shopifyListContent: 'List store content',
  shopifySalesReport: 'Run sales report',
  shopifyUpdateProduct: 'Update product',
  shopifyCreateProduct: 'Create product',
  shopifyCreateDraftOrder: 'Create draft order',
  shopifySendDraftOrderInvoice: 'Send draft order invoice',
  shopifyAddTags: 'Add Shopify tags',
  shopifyUpdateCustomer: 'Update customer',
  shopifySetInventory: 'Set inventory',
  shopifyCreateFulfillment: 'Fulfill order',
  shopifyCreateDiscountCode: 'Create discount code',
  shopifyCreateContent: 'Create store content',
  shopifyCancelOrder: 'Cancel order',
  shopifyRefundOrder: 'Refund order',
  shopifyCompleteDraftOrder: 'Complete draft order',

  // Assistant Email (AgentMail) — the assistant's own mailbox
  agentmailSendMessage: 'Send email as the assistant',
  agentmailSearchThreads: 'Search the assistant\'s mailbox',
  agentmailCreateDraft: 'Draft email as the assistant',

  // Company mailbox (IMAP/SMTP) — the user's own corporate mailbox
  imapSearchMessages: 'Search company mailbox',
  imapGetMessage: 'Read company email',
  imapSendMessage: 'Send email from company mailbox',
  syncMailboxNow: 'Sync company mailbox now',
  searchEmailArchive: 'Search mailbox archive',

  // Workspace files (Q3 / company-brain §10)
  fileWrite: 'Save workspace file',
  fileAppend: 'Append to workspace file',
  fileRead: 'Read workspace file',
  fileSearch: 'Search workspace files',
  fileSetMeta: 'Update file metadata',
  fileDelete: 'Delete workspace file',
  saveFileToBrain: 'Save uploaded file to brain',
  saveFileBytes: 'Save file bytes to brain',
  sendFile: 'Send a file to the chat',

  // Decks (docs/architecture/features/deck-generation.md)
  generatePowerpoint: 'Create a PowerPoint deck',
  updatePowerpoint: 'Edit a PowerPoint deck',
  getPowerpoint: 'Read a PowerPoint deck',

  // Computer use (docs/architecture/engine/computer-use.md)
  browserNavigate: 'Open a page in the browser',
  browserSnapshot: 'Look at the browser page',
  browserClick: 'Click in the browser',
  browserType: 'Type in the browser',
  browserCurrentUrl: 'Check the browser address',
  browserReadPage: 'Read a page in the browser',
  runBrowserSkill: 'Run a browser skill',
  listBrowserSkills: 'List browser skills',
  listBrowserProfiles: 'List browser profiles',
  browserExplore: 'Explore a browsing flow',
  runPython: 'Run Python in the sandbox',
  loadFromWorkspace: 'Load a file into the sandbox',
  saveToWorkspace: 'Save a sandbox file to the workspace',

  // Knowledge base
  searchKnowledge: 'Search knowledge base',
  browseKnowledge: 'Browse knowledge base',
  readKnowledgeEntry: 'Read knowledge entry',
  addKnowledgeEntry: 'Add to knowledge base',

  // Scheduling
  createScheduledJob: 'Create scheduled reminder',
  updateScheduledJob: 'Update scheduled reminder',
  deleteScheduledJob: 'Delete scheduled reminder',

  // Inter-assistant
  askAssistant: 'Ask another assistant',
  listConnectedAssistants: 'List connected assistants',
  publishSnapshot: 'Publish sharing snapshot',
  reviewDataRequest: 'Data access request',

  // Q5 Views (§16)
  renderView: 'Render a view',
  saveView: 'Save view',

  // Doc pages
  findPage: 'Find a doc page',
}

/**
 * Get a human-readable display name for a tool.
 * Falls back to converting camelCase to spaced words if not in the map.
 */
export function getToolDisplayName(toolName: string): string {
  if (TOOL_DISPLAY_NAMES[toolName]) return TOOL_DISPLAY_NAMES[toolName]

  // Fallback: convert camelCase to "Camel case" (e.g. "mcp_someAction" → "Mcp some action")
  return toolName
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase())
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase())
}

// ── Tool timeline helpers (Telegram/Slack status messages) ────

/**
 * Status-message form of tool names — present participle ("Saving to memory")
 * for use in tool timeline UIs (Telegram edit-in-place, Slack status).
 */
const TOOL_STATUS_NAMES: Record<string, string> = {
  saveMemory: 'Saving to memory',
  getMemory: 'Recalling memories',
  webSearch: 'Searching the web',
  urlReader: 'Reading a page',
  mcp_search: 'Searching tools',
  mcp_call: 'Using a tool',
  spawnWorker: 'Delegating research',
  scheduleCron: 'Setting a reminder',
  listCrons: 'Checking reminders',
  deleteCron: 'Removing a reminder',
  updateCron: 'Updating a reminder',
  notionSearch: 'Searching Notion',
  notionCreatePage: 'Creating a Notion page',
  useSkill: 'Using a skill',
  // Browser / computer-use. These are fallbacks before the input arrives;
  // `describeToolInput` overrides the URL-carrying ones with the page host
  // ("Browsing news.ycombinator.com") so the timeline says WHERE, not just WHAT.
  browserNavigate: 'Opening a page',
  browserReadPage: 'Reading a page',
  browserClick: 'Clicking in the browser',
  browserType: 'Typing in the browser',
  browserSnapshot: 'Reading the page',
  browserCurrentUrl: 'Checking the page',
  runBrowserSkill: 'Running a browser task',
  browserExplore: 'Exploring the web',
}

/**
 * Get a human-readable status message for a tool (present participle form).
 * Used in Telegram/Slack tool timeline UIs. Falls back to title-casing the name.
 */
export function humanizeToolName(name: string): string {
  return TOOL_STATUS_NAMES[name] ?? name.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).trim()
}

/**
 * Produce a more descriptive status line from a tool's input.
 * Returns undefined if no meaningful description can be derived.
 */
export function describeToolInput(name: string, input: Record<string, unknown>): string | undefined {
  if (name === 'webSearch') {
    const q = input.query as string | undefined
    return q ? `Searching "${q}"` : undefined
  }
  if (name === 'urlReader') {
    const url = input.url as string | undefined
    if (url) {
      try { return `Reading ${new URL(url).hostname.replace(/^www\./, '')}` } catch { return undefined }
    }
  }
  // Browser tools: show WHICH page. Only navigate/read carry a URL in their
  // input — click/type/snapshot act on the current page and keep the status
  // label (see TOOL_STATUS_NAMES). Mirrors the urlReader host rendering.
  if (name === 'browserNavigate') {
    const url = input.url as string | undefined
    if (url) {
      try { return `Browsing ${new URL(url).hostname.replace(/^www\./, '')}` } catch { return undefined }
    }
  }
  if (name === 'browserReadPage') {
    const url = input.url as string | undefined
    if (url) {
      try { return `Reading ${new URL(url).hostname.replace(/^www\./, '')}` } catch { return undefined }
    }
  }
  if (name === 'mcp_call') {
    const tool = input.tool as string | undefined
    if (tool) return tool.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
  }
  if (name === 'spawnWorker') {
    const prompt = input.prompt as string | undefined
    if (prompt) {
      const first = prompt.split(/[.\n]/)[0].trim()
      return first.length > 50 ? first.slice(0, 47) + '...' : first
    }
  }
  if (name === 'notionSearch') {
    const q = input.query as string | undefined
    return q ? `Searching Notion for "${q}"` : undefined
  }
  return undefined
}

// ── Confirmation input formatting ────────────────────────────

/** Fields to hide from confirmation prompts (IDs, internal identifiers). */
const HIDDEN_FIELDS = new Set([
  'taskId', 'eventId', 'messageId', 'pageId', 'databaseId', 'fileId',
  'issueNumber', 'pullNumber', 'commentId', 'blockId', 'entryId',
])

/** Human-friendly labels for camelCase field names. */
const FIELD_LABELS: Record<string, string> = {
  currentTitle: 'Title',
  title: 'Title',
  taskListId: 'Task list',
  status: 'Status',
  notes: 'Notes',
  due: 'Due',
  name: 'Name',
  summary: 'Summary',
  description: 'Description',
  query: 'Query',
  responseStatus: 'RSVP',
  subject: 'Subject',
  body: 'Body',
  to: 'To',
  parent: 'Parent',
}

/**
 * Sort and format tool input entries for a confirmation prompt.
 *
 * Human-readable fields (title, name, summary) are sorted first so users
 * see what matters before IDs. Internal ID fields are hidden. Field names
 * are converted to human-friendly labels. Used by all channel routes
 * (Telegram, Slack, WhatsApp) for consistent confirmation prompts.
 *
 * @param input   - The tool input object.
 * @param bullet  - Prefix for each line (default `"• "`).
 * @returns Array of formatted lines, e.g. `["• Title: Draft newsletter", "• Task list: @default"]`.
 *          Empty array if input is empty.
 */
export function formatConfirmationInput(
  input: Record<string, unknown>,
  bullet = '• ',
): string[] {
  const entries = Object.entries(input)
    .filter(([k, v]) => v !== undefined && v !== null && !HIDDEN_FIELDS.has(k))
  // Sort: human-readable fields first, then everything else in original order
  const priority = ['currentTitle', 'title', 'name', 'summary', 'description', 'status', 'notes']
  entries.sort((a, b) => {
    const ai = priority.indexOf(a[0])
    const bi = priority.indexOf(b[0])
    if (ai !== -1 && bi !== -1) return ai - bi
    if (ai !== -1) return -1
    if (bi !== -1) return 1
    return 0
  })
  return entries.map(([k, v]) => {
    const label = FIELD_LABELS[k] ?? k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase())
    return `${bullet}${label}: ${typeof v === 'object' ? JSON.stringify(v) : v}`
  })
}
