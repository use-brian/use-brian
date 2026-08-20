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
    'semantically indexed, so a thin result set can be told apart from an unindexed one. ' +
    'Hits carry the sender\'s id (a phone number or platform id), their display/push name, and the ' +
    'saved contact name when the user\'s synced address book has one — when only a bare number comes ' +
    'back, cross-check it against the CRM with listContacts before telling the user no name is known. ' +
    'Hits with media also carry `media_sha256`: pass it to saveChatMedia to save or send the actual file.',
  classification: 'read',
  defaultPolicy: 'allow',
} as const

/**
 * The retrieval half of "send me that file".
 *
 * Search hits describe media (`media_sha256`, `media_mime`, extraction state)
 * but the bytes live in the archive's content-addressed store. This tool pulls
 * them into the workspace file layer, where `sendFile` and the web app's Files
 * view can reach them.
 */
export const CHAT_ARCHIVE_SAVE_MEDIA_TOOL = {
  name: 'saveChatMedia',
  description:
    'Save a photo, voice note, video, or document from the user\'s archived WeChat/WhatsApp history into the workspace as a real file. ' +
    'Use when the user asks you to send, save, or forward something that arrived in a chat: find the message with searchChatHistory, take the hit\'s `media_sha256`, save it here, then pass the returned `fileId` to sendFile to deliver it. ' +
    'Only works for hits whose media is stored (`extraction_status` present and media coverage not `missing`); if the digest is absent the original bytes were never captured and cannot be recovered — say so instead of retrying.',
  classification: 'write',
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
