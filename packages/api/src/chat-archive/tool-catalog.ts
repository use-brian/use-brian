/** The single agent-facing capability exposed by a local chat archive. */
export const CHAT_ARCHIVE_SEARCH_TOOL = {
  name: 'searchChatHistory',
  description:
    "Hybrid meaning and keyword search over the user's locally archived WeChat and WhatsApp history. " +
    'Use this first for questions about a named person, how the user knows them, their relationship, ' +
    'what they discussed, past decisions, promises, or anything that may come from personal chats. ' +
    'For a personal identity question such as "Who is X?", search the exact name before using public ' +
    'web search or CRM/contact tools; chat evidence is personal context, not a public biography. ' +
    'Filters can narrow the source, conversation, sender, direction, message kind, or time range. ' +
    'Keyword recall covers every archived message; the result states when semantic indexing is partial.',
  classification: 'read',
  defaultPolicy: 'allow',
} as const
