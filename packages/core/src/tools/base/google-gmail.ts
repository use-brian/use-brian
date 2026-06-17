/**
 * Gmail tools — list, read, and send messages.
 *
 * Read tools are concurrency-safe; send requires confirmation.
 * The `callApi` callback is injected by the API layer so core stays
 * free of network/OAuth deps.
 */

import { z } from 'zod'
import { buildTool, type Tool } from '../types.js'
import { type Json, str } from './_connector-result.js'

export type GmailApi = {
  listMessages(params: {
    query?: string
    maxResults?: number
  }): Promise<unknown>

  getMessage(messageId: string): Promise<unknown>

  sendMessage(params: {
    to: string
    subject: string
    body: string
  }): Promise<unknown>
}

export function createGmailTools(api: GmailApi): Tool[] {
  const listMessages = buildTool({
    name: 'gmailListMessages',
    description:
      'Search Gmail messages. Returns sender, subject, date, and a snippet for each result. ' +
      'Use Gmail search syntax for the query (e.g. "from:alice subject:invoice after:2026/04/01").',
    inputSchema: z.object({
      query: z.string().optional().describe('Gmail search query. Omit to list recent messages.'),
      maxResults: z.number().optional().describe('Max messages to return (default 10).'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 15_000,

    async execute(input) {
      try {
        const data = await api.listMessages({
          query: input.query,
          maxResults: input.maxResults,
        })
        return { data }
      } catch (err) {
        return { data: `Gmail error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const getMessage = buildTool({
    name: 'gmailGetMessage',
    description: 'Get the full content of a Gmail message by ID. Returns from, to, subject, date, and body text.',
    inputSchema: z.object({
      messageId: z.string().describe('The Gmail message ID to fetch.'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 10_000,

    async execute(input) {
      try {
        const data = await api.getMessage(input.messageId)
        return { data }
      } catch (err) {
        return { data: `Gmail error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const sendMessage = buildTool({
    name: 'gmailSendMessage',
    description:
      'Send an email via Gmail. ' +
      'The email is sent from the authenticated user\'s account. ' +
      'Call this tool directly — the user will see an Approve/Deny prompt.',
    inputSchema: z.object({
      to: z.string().describe('Recipient email address.'),
      subject: z.string().describe('Email subject line.'),
      body: z.string().describe('Plain text email body.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 15_000,

    async execute(input) {
      try {
        const data = await api.sendMessage({
          to: input.to,
          subject: input.subject,
          body: input.body,
        })
        const m = (data ?? {}) as Json
        return { data: { id: str(m, 'id'), threadId: str(m, 'threadId') } }
      } catch (err) {
        return { data: `Gmail error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  return [
    // Phase 2: requires gmail.readonly scope (restricted, needs CASA audit)
    // listMessages,
    // getMessage,
    sendMessage,
  ]
}
