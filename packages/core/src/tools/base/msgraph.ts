/**
 * Microsoft Graph tools — read-only Teams access.
 *
 * The shipped Teams *channel* (a bot) sees only what arrives at its webhook:
 * conversations it was installed into, from the moment it was installed. These
 * tools cover the residual — channels the bot was never added to, history
 * predating installation, tenant-wide search, directory lookup.
 *
 * **Read-only, permanently (decision D1).** Graph has no application
 * permission for sending, so every Graph write is attributed to a human rather
 * than to the assistant; sending stays on the bot. No write tool may be added
 * through this factory.
 *
 * The `api` object is injected by the API layer so core stays free of
 * network/OAuth deps. See docs/plans/msteams-connector.md §5 P2.
 */

import { z } from 'zod'
import { buildTool, type Tool, type ToolResult } from '../types.js'
import { type Json, str, obj, asRows, projectList } from './_connector-result.js'

// ── Graph result projections ───────────────────────────────────
// Graph bodies are heavy: every collection carries `@odata.context` /
// `@odata.count`, every row an `@odata.etag`, a dozen null-filled fields, a
// nested `from` identity envelope with `application`/`device` slots that are
// null for human messages, and an HTML `body.content`. System-event rows add
// an `eventDetail` object with its own `@odata.type` and member arrays.
// None of that reaches the model. See `_connector-result.ts`.

/** Decode the handful of HTML entities Teams message bodies actually carry. */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * Flatten a chatMessage body to plain text. Teams stores channel and chat
 * bodies as HTML; handing the markup to the model is pure noise, and the tag
 * soup is where a prompt-injection payload would hide.
 */
function bodyText(body: Json | undefined): string {
  const content = str(body, 'content') ?? ''
  if (str(body, 'contentType') === 'text') return content.trim()
  return decodeEntities(
    content.replace(/<(br|\/p|\/div|\/li)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** A team row. The settings blobs, internal thread id and tenant id are dropped. */
function teamRow(o: Json) {
  return {
    id: str(o, 'id'),
    displayName: str(o, 'displayName'),
    description: str(o, 'description'),
    visibility: str(o, 'visibility'),
    isArchived: o.isArchived === true,
    webUrl: str(o, 'webUrl'),
  }
}

/**
 * A channel row. `membershipType` tells the model standard vs private vs shared.
 *
 * Microsoft returns `displayName: null` for a team's General channel rather
 * than the string "General", so that each client can localize the name itself.
 * We are not localizing anything here, and a nameless channel is one the model
 * cannot refer to or ask the user about, so the literal "General" is the
 * honest fallback: it is the name every Teams client shows for that channel in
 * English, and it is the name a user will type.
 *
 * The corroborating signal is that General's channel id is the team's own id.
 * That equality only holds when both are spelled the same way (the
 * `19:…@thread.tacv2` thread id, which is how the Bot Framework side spells a
 * team); Graph's own team id is a GUID, so against a Graph-sourced team id the
 * comparison simply will not fire. The absent display name is therefore the
 * load-bearing test and the id match is a second opinion, never a requirement.
 */
function channelRow(teamId: string) {
  return (o: Json) => {
    const id = str(o, 'id')
    const name = str(o, 'displayName')
    const isGeneral = name === undefined || (id !== undefined && id === teamId)
    return {
      id,
      displayName: name ?? 'General',
      description: str(o, 'description'),
      membershipType: str(o, 'membershipType'),
      createdDateTime: str(o, 'createdDateTime'),
      webUrl: str(o, 'webUrl'),
      ...(isGeneral ? { isGeneral: true } : {}),
    }
  }
}

/**
 * A chat row. A one-on-one chat has a null `topic`, so the member display
 * names carried by `$expand=members` are the only thing that identifies it.
 */
function chatRow(o: Json) {
  return {
    id: str(o, 'id'),
    topic: str(o, 'topic'),
    chatType: str(o, 'chatType'),
    lastUpdatedDateTime: str(o, 'lastUpdatedDateTime'),
    members: asRows(o.members)
      .map((m) => str(m, 'displayName'))
      .filter((n): n is string => !!n),
    webUrl: str(o, 'webUrl'),
  }
}

/**
 * A channel or chat message row. `fromIdentityType` is carried deliberately:
 * only `aadUser` ids are Entra object ids, so any downstream identity join
 * must gate on it rather than assume (research §2.4).
 */
function messageRow(o: Json) {
  const user = obj(obj(o, 'from'), 'user')
  return {
    id: str(o, 'id'),
    createdDateTime: str(o, 'createdDateTime'),
    messageType: str(o, 'messageType'),
    subject: str(o, 'subject'),
    from: str(user, 'displayName'),
    fromUserId: str(user, 'id'),
    fromIdentityType: str(user, 'userIdentityType'),
    text: bodyText(obj(o, 'body')),
    hasAttachments: asRows(o.attachments).length > 0,
    webUrl: str(o, 'webUrl'),
  }
}

/**
 * A search hit. Search does not return message bodies, only a `summary`
 * snippet wrapped in `<c0>` hit-highlight markers, so the snippet goes
 * through the same tag strip as a real body.
 */
function searchHitRow(hit: Json) {
  const r = obj(hit, 'resource') ?? {}
  const user = obj(obj(r, 'from'), 'user')
  const channel = obj(r, 'channelIdentity')
  return {
    id: str(r, 'id'),
    createdDateTime: str(r, 'createdDateTime'),
    subject: str(r, 'subject'),
    from: str(user, 'displayName'),
    fromUserId: str(user, 'id'),
    fromIdentityType: str(user, 'userIdentityType'),
    teamId: str(channel, 'teamId'),
    channelId: str(channel, 'channelId'),
    chatId: str(r, 'chatId'),
    snippet: bodyText({ contentType: 'html', content: str(hit, 'summary') ?? '' }),
    webUrl: str(r, 'webUrl'),
  }
}

/**
 * Drop keys with nothing behind them. Graph fills absent values with `null`
 * and `""` (a channel with no address returns `email: ""`, a plain member
 * returns `roles: []`); emitting those as-is teaches the model that a field
 * was checked and came back blank, which is not what happened.
 */
function compact(o: Json): Json {
  const out: Json = {}
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null || v === '') continue
    if (Array.isArray(v) && v.length === 0) continue
    out[k] = v
  }
  return out
}

/**
 * `#microsoft.graph.aadUserConversationMember` → `aadUser`. Only `aadUser`
 * ids are Entra object ids; the anonymous / federated / phone / email member
 * kinds carry ids that mean something else entirely, so the kind travels with
 * every person row rather than being inferred downstream (research §2.4).
 */
function memberKind(o: Json): string | undefined {
  const t = str(o, '@odata.type')
  if (!t) return undefined
  return t.replace(/^#microsoft\.graph\./, '').replace(/ConversationMember$/, '')
}

/**
 * A person, from either a membership roster or the directory. The two shapes
 * disagree on where the user id lives: a roster row's `id` is the OPAQUE
 * membership id and its Entra id is `userId`, while a directory row's `id` IS
 * the Entra id. Conflating them hands the model an id that resolves nowhere.
 *
 * An anonymous guest has no Entra id, no mail and no UPN. Rather than emit
 * three blanks, those keys are dropped and the row carries a note saying so.
 */
function personRow(o: Json): Json {
  const kind = memberKind(o)
  // The Entra object id travels under three spellings: `userId` on a Graph
  // aadUserConversationMember, `objectId` on a membership row, and
  // `aadObjectId` on the Bot Framework Activity the shipped Teams channel
  // parses. They are the same value. Anything joining a Graph member to a
  // channel-side user misses silently unless one side normalizes, so this
  // projection collapses all three to `userId` and emits nothing else.
  // A directory row has no membership envelope at all: there, plain `id` IS
  // the Entra id, which is why it is only consulted when no explicit
  // object-id field is present.
  const userId =
    str(o, 'userId') ??
    str(o, 'objectId') ??
    str(o, 'aadObjectId') ??
    (kind === undefined ? str(o, 'id') : undefined)
  const email = str(o, 'mail') ?? str(o, 'email')
  const upn = str(o, 'userPrincipalName')
  const row = compact({
    userId,
    displayName: str(o, 'displayName'),
    email,
    userPrincipalName: upn,
    jobTitle: str(o, 'jobTitle'),
    department: str(o, 'department'),
    identityKind: kind ?? 'aadUser',
    roles: o.roles,
  })
  if (!userId && !email && !upn) {
    // An anonymous or external guest has no object id under any spelling, no
    // mail and no UPN. Dropping every empty key would leave a row the model
    // cannot tell apart from the next guest, so the membership row's own id
    // comes along as the one remaining handle. It is deliberately NOT called
    // `userId`: Graph documents membership ids as opaque, they resolve through
    // no lookup, and a row that has a real identity never carries one.
    row.membershipId = str(o, 'id')
    row.note =
      'Anonymous or external guest. No directory identity, so this person cannot be looked up by id or email. ' +
      'membershipId identifies this membership row only and is not a user id.'
  }
  return row
}

/** Graph collections all arrive as `{ value: [...] }`. */
function rowsOf(data: unknown): Json[] {
  return asRows(((data ?? {}) as Json).value)
}

/**
 * Turn an api-layer rejection into a tool result the model can act on. A
 * throw out of `execute()` reaches the model as a generic executor failure
 * with no room to say "the token expired" or "back off"; a string result
 * keeps the turn going. Same convention as the other connectors.
 */
async function guard(run: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return { data: await run() }
  } catch (err) {
    return {
      data: `Microsoft Teams error: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    }
  }
}

/**
 * The narrow port this factory needs. The concrete client lives in
 * `packages/api/src/msgraph/client.ts`; each method returns the raw Graph
 * JSON body, which the tools project before the model ever sees it.
 */
export type MsGraphApi = {
  listTeams(params: { search?: string; limit?: number }): Promise<unknown>
  listChannels(params: { teamId: string; limit?: number }): Promise<unknown>
  listChannelMessages(params: {
    teamId: string
    channelId: string
    limit?: number
  }): Promise<unknown>
  listMessageReplies(params: {
    teamId: string
    channelId: string
    messageId: string
    limit?: number
  }): Promise<unknown>
  listChats(params: { limit?: number }): Promise<unknown>
  listChatMessages(params: { chatId: string; limit?: number }): Promise<unknown>
  searchMessages(params: { query: string; limit?: number }): Promise<unknown>
  listMembers(params: { teamId: string; channelId?: string; limit?: number }): Promise<unknown>
  /**
   * Resolve people by name / email. With `teamId` the lookup is scoped to
   * that team's roster (`GET /teams/{id}/members?$filter=…`, which is where
   * guests live); without it, the tenant directory (`GET /users?$filter=…`).
   */
  findPeople(params: { query: string; teamId?: string; limit?: number }): Promise<unknown>
}

export function createMsGraphTools(api: MsGraphApi): Tool[] {
  const read = { isConcurrencySafe: true, isReadOnly: true, timeoutMs: 20_000 } as const

  const listTeams = buildTool({
    name: 'msTeamsListTeams',
    description:
      'List the teams in this Microsoft Teams tenant, including teams the assistant was never ' +
      'added to. Returns team ids to pass to msTeamsListChannels and msTeamsListMembers. ' +
      'Read-only.',
    inputSchema: z.object({
      search: z
        .string()
        .optional()
        .describe('Filter by team display name. Omit to list every team you can see.'),
      limit: z.number().int().min(1).max(100).optional().describe('Max teams to return (default 25).'),
    }),
    ...read,
    execute(input) {
      return guard(async () => {
        const data = await api.listTeams({ search: input.search, limit: input.limit })
        return projectList(rowsOf(data), input.limit ?? 25, teamRow)
      })
    },
  })

  const listChannels = buildTool({
    name: 'msTeamsListChannels',
    description:
      'List the channels in one Microsoft Teams team, with each channel id, name, and whether it ' +
      'is standard, private, or shared. Get the team id from msTeamsListTeams. Read-only.',
    inputSchema: z.object({
      teamId: z.string().min(1).describe('Team id from msTeamsListTeams.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('Max channels to return (default 50).'),
    }),
    ...read,
    execute(input) {
      return guard(async () => {
        const data = await api.listChannels({ teamId: input.teamId, limit: input.limit })
        return projectList(rowsOf(data), input.limit ?? 50, channelRow(input.teamId))
      })
    },
  })

  const readChannelMessages = buildTool({
    name: 'msTeamsReadChannelMessages',
    description:
      'Read recent root messages in a Microsoft Teams channel, newest first, including history ' +
      'from before the assistant joined. Replies are not included: pass a message id to ' +
      'msTeamsReadThreadReplies for a thread. Read-only.',
    inputSchema: z.object({
      teamId: z.string().min(1).describe('Team id from msTeamsListTeams.'),
      channelId: z.string().min(1).describe('Channel id from msTeamsListChannels.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('Max messages, newest first (default 20, Microsoft caps this at 50).'),
    }),
    ...read,
    execute(input) {
      return guard(async () => {
        const data = await api.listChannelMessages({
          teamId: input.teamId,
          channelId: input.channelId,
          limit: input.limit,
        })
        return projectList(rowsOf(data), input.limit ?? 20, messageRow)
      })
    },
  })

  const readThreadReplies = buildTool({
    name: 'msTeamsReadThreadReplies',
    description:
      'Read the replies in one Microsoft Teams channel thread. Takes the team id, channel id, and ' +
      'the root message id from msTeamsReadChannelMessages or msTeamsSearchMessages. Read-only.',
    inputSchema: z.object({
      teamId: z.string().min(1).describe('Team id from msTeamsListTeams.'),
      channelId: z.string().min(1).describe('Channel id from msTeamsListChannels.'),
      messageId: z
        .string()
        .min(1)
        .describe('Id of the root message whose thread you want, from msTeamsReadChannelMessages.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('Max replies to return (default 30, Microsoft caps this at 50).'),
    }),
    ...read,
    execute(input) {
      return guard(async () => {
        const data = await api.listMessageReplies({
          teamId: input.teamId,
          channelId: input.channelId,
          messageId: input.messageId,
          limit: input.limit,
        })
        return projectList(rowsOf(data), input.limit ?? 30, messageRow)
      })
    },
  })

  const listChats = buildTool({
    name: 'msTeamsListChats',
    description:
      'List the Microsoft Teams chats (direct messages and group chats) the connected user is in, ' +
      'most recently active first. A one to one chat has no topic, so it is identified by its ' +
      'member names. Microsoft returns at most 25 members per chat, so on a large group chat the ' +
      'member list is a sample and not the full roster. Read-only.',
    inputSchema: z.object({
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('Max chats, most recently active first (default 20).'),
    }),
    ...read,
    execute(input) {
      return guard(async () => {
        const data = await api.listChats({ limit: input.limit })
        return projectList(rowsOf(data), input.limit ?? 20, chatRow)
      })
    },
  })

  const readChatMessages = buildTool({
    name: 'msTeamsReadChatMessages',
    description:
      'Read recent messages in one Microsoft Teams chat (a direct message or group chat), newest ' +
      'first. Get the chat id from msTeamsListChats or from a msTeamsSearchMessages hit. ' +
      'Read-only.',
    inputSchema: z.object({
      chatId: z.string().min(1).describe('Chat id from msTeamsListChats or msTeamsSearchMessages.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('Max messages, newest first (default 20, Microsoft caps this at 50).'),
    }),
    ...read,
    execute(input) {
      return guard(async () => {
        const data = await api.listChatMessages({ chatId: input.chatId, limit: input.limit })
        return projectList(rowsOf(data), input.limit ?? 20, messageRow)
      })
    },
  })

  const searchMessages = buildTool({
    name: 'msTeamsSearchMessages',
    description:
      'Search across the Microsoft Teams channels and chats the connected user can see, including ' +
      'history from before the assistant joined. Use this to find where something was discussed. ' +
      'Returns who, when, which channel or chat, and a short snippet, but not the full message: ' +
      'follow a hit with msTeamsReadChannelMessages or msTeamsReadChatMessages for context. ' +
      'Read-only.',
    inputSchema: z.object({
      query: z
        .string()
        .min(1)
        .describe(
          'Keywords, optionally with Microsoft search operators: from:<name>, to:<name>, ' +
            'sent>2026-03-01, hasAttachment:true. Example: "pricing from:robin sent>2026-03-01".',
        ),
      limit: z.number().int().min(1).max(50).optional().describe('Max hits to return (default 20).'),
    }),
    ...read,
    execute(input) {
      return guard(async () => {
        const data = await api.searchMessages({ query: input.query, limit: input.limit })
        const container = asRows(((data ?? {}) as Json).value)
          .flatMap((r) => asRows(r.hitsContainers))
          .at(0)
        return {
          ...projectList(asRows(container?.hits), input.limit ?? 20, searchHitRow),
          moreResultsAvailable: container?.moreResultsAvailable === true,
        }
      })
    },
  })

  const listMembers = buildTool({
    name: 'msTeamsListMembers',
    description:
      'List the members of a Microsoft Teams team, or of one channel in it, with each person\'s ' +
      'display name, email, and directory id. Use this to answer who is on a team. Read-only.',
    inputSchema: z.object({
      teamId: z.string().min(1).describe('Team id from msTeamsListTeams.'),
      channelId: z
        .string()
        .min(1)
        .optional()
        .describe('Narrow to one channel. Omit to list the whole team roster.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe('Max members to return (default 100).'),
    }),
    ...read,
    execute(input) {
      return guard(async () => {
        const data = await api.listMembers({
          teamId: input.teamId,
          channelId: input.channelId,
          limit: input.limit,
        })
        return projectList(rowsOf(data), input.limit ?? 100, personRow)
      })
    },
  })

  const findPerson = buildTool({
    name: 'msTeamsFindPerson',
    description:
      'Find a person by name, email, or directory id in the Microsoft Teams organization ' +
      'directory, or in one team\'s roster when a team id is given. Use this to resolve someone ' +
      'who is not in the current conversation, or to turn a user id from any other Microsoft ' +
      'Teams tool back into a person. An id is matched exactly. For a name or an address, ' +
      'matching differs between the two: the directory matches only names ' +
      'and addresses that START WITH the query, while a team roster matches anywhere in the ' +
      'name or address. So a surname or a middle word finds nobody in the directory. If a ' +
      'directory search comes back empty, that is not proof the person does not exist: retry ' +
      'with the first part of their name, or pass teamId to search a roster instead. ' +
      'Guests may have no directory id or email. Read-only.',
    inputSchema: z.object({
      query: z
        .string()
        .min(1)
        .describe(
          'A name, an email address, or a Microsoft Entra user id (the fromUserId on a message ' +
            'or the userId on a member, as returned by the other Microsoft Teams tools). An id ' +
            'is matched exactly, and pairing it with teamId also resolves the person\'s email. ' +
            'A name or address without teamId must be what the name or address STARTS WITH, ' +
            'not a fragment from the middle. With teamId any fragment matches.',
        ),
      teamId: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Search this team\'s roster instead of the tenant directory. Guests appear only here.',
        ),
      limit: z.number().int().min(1).max(50).optional().describe('Max people to return (default 10).'),
    }),
    ...read,
    execute(input) {
      return guard(async () => {
        const data = await api.findPeople({
          query: input.query,
          teamId: input.teamId,
          limit: input.limit,
        })
        return projectList(rowsOf(data), input.limit ?? 10, personRow)
      })
    },
  })

  return [
    listTeams,
    listChannels,
    readChannelMessages,
    readThreadReplies,
    listChats,
    readChatMessages,
    searchMessages,
    listMembers,
    findPerson,
  ]
}
