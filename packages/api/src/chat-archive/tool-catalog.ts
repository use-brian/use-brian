/** The agent-facing capabilities exposed by a local chat archive. */
export const CHAT_ARCHIVE_SEARCH_TOOL = {
  name: 'searchChatHistory',
  description:
    "Hybrid meaning and keyword search over the user's locally archived WeChat and WhatsApp history. " +
    'Use this first for questions about a named person, how the user knows them, their relationship, ' +
    'what they discussed, past decisions, promises, or anything that may come from personal chats. ' +
    'For a personal identity question such as "Who is X?", search the exact name before using public ' +
    'web search or CRM/contact tools; chat evidence is personal context, not a public biography. ' +
    'Narrow with `channel` (get one from listChatChannels or a prior hit) and a `since`/`until` range. ' +
    'Image OCR and descriptions, document passages, audio transcripts, and sampled video content are ' +
    'searched alongside captions and message text. Results report how much of the range is not yet ' +
    'semantically indexed, so a thin result set can be told apart from an unindexed one.',
  classification: 'read',
  defaultPolicy: 'allow',
} as const

/**
 * Resolver for the search tool.
 *
 * Without it a model has no way to discover a channel handle except by lifting
 * one out of a previous search hit — the same gap the recordings tools solved by
 * pairing a temporal/nominal lister with a precision search.
 */
export const CHAT_ARCHIVE_CHANNELS_TOOL = {
  name: 'listChatChannels',
  description:
    'List archived chat conversations, most recently active first, with a preview of the last message. ' +
    'Use this to find the `channel` handle for searchChatHistory when the user names a person or group ' +
    'rather than giving an id, or to answer "which chats do I have?". ' +
    'Returns opaque channel handles; pass one straight back into searchChatHistory.',
  classification: 'read',
  defaultPolicy: 'allow',
} as const
