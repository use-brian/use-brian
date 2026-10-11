import express from 'express'
import request from 'supertest'
import { describe, it, expect } from 'vitest'
import { createProtectedFillService } from '../../../../core/src/sandbox/protected-fill.js'
import { createComputerTools } from '../../../../core/src/sandbox/tools.js'
import { createLocalBrowserProvider } from '../../../../core/src/sandbox/local-browser-provider.js'
import { createInMemoryBrowserProfileStore } from '../../../../core/src/sandbox/profiles.js'
import type { ToolContext } from '../../../../core/src/tools/types.js'
import { createRelayCommandTransport } from '../relay-transport.js'
import { protectedBrowserFillRoutes } from '../../routes/protected-browser-fill.js'
import { signBrowserExtSessionToken } from '../../auth/browser-ext-pair-token.js'

describe('protected fill API → tool → relay → direct extension resolve → cleanup', () => {
  it('keeps sentinel values solely in the direct authenticated resolution response', async () => {
    const profiles = createInMemoryBrowserProfileStore()
    const profile = await profiles.create({ workspaceId: 'w', ownerUserId: 'u', name: 'Local', clearance: 'confidential', defaultBackend: 'local', enabledAssistantIds: ['a'] })
    const scope = { userId: 'u', workspaceId: 'w', sessionId: 's', taskId: 'task', browserProfileId: profile.id, destinationOrigin: 'https://example.com' }
    const { userId: _, ...binding } = scope
    const service = createProtectedFillService({ authorize: async () => true, validateSource: async () => true, readSource: async () => 'SECRET_SENTINEL' })
    const token = signBrowserExtSessionToken(scope, 'secret')
    const extensionOrigin = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    let completed = false
    const app = express().use(express.json()).use('/api/protected-browser-fill', protectedBrowserFillRoutes({ service, jwtSecret: 'secret', extensionOrigins: new Set([extensionOrigin]),
      userAuth: (req, _res, next) => { req.userId = 'u'; next() }, onComplete: async () => { completed = true },
    }))
    const issued = await request(app).post('/api/protected-browser-fill/references').send({ ...binding, sources: [
      { kind: 'crm', entityId: '00000000-0000-4000-8000-000000000001', field: 'email' },
      { kind: 'crm', entityId: '00000000-0000-4000-8000-000000000001', field: 'phone' },
    ] })
    expect(issued.status).toBe(201)
    const wire: unknown[] = []
    const transport = createRelayCommandTransport({ relayUrl: 'https://relay.example', relaySecret: 'secret', protectedFill: service,
      fetchImpl: async (_url, init) => {
        const command = JSON.parse(String(init?.body))
        wire.push(command)
        let data: unknown = { url: 'https://example.com/form', title: 'Form', nodes: [{ ref: '@e1', role: 'textbox', name: 'Email' }, { ref: '@e2', role: 'textbox', name: 'Phone' }] }
        if (command.op === 'browserFillReference') {
          // Simulates extension-only HTTPS retrieval, not a tool/relay return.
          const direct = await request(app).post('/api/protected-browser-fill/resolve').set('Origin', extensionOrigin).set('Authorization', `Bearer ${token}`).send(command.args)
          expect(direct.status).toBe(200)
          expect(direct.body.items).toEqual([{ ref: '@e1', value: 'SECRET_SENTINEL' }, { ref: '@e2', value: 'SECRET_SENTINEL' }])
          data = { status: 'filled', filledCount: 2, requiresHumanCompletion: true }
        }
        return new Response(JSON.stringify({ ok: true, data }))
      },
    })
    const local = createLocalBrowserProvider({ admit: async () => async () => {}, transport })
    const tools = createComputerTools({ local, cloud: { ...local, kind: 'cloud' }, profiles: { store: profiles, assistantClearance: async () => 'confidential' },
      protectedFill: { scope: async () => scope, blocked: () => service.isLocked(scope) },
    })
    const context: ToolContext = { userId: 'u', workspaceId: 'w', sessionId: 's', assistantId: 'a', appId: 'app', channelType: 'web', attended: true, channelId: 'web', abortSignal: new AbortController().signal }
    await tools.browserNavigate.execute({ url: 'https://example.com/form' }, context)
    const result = await tools.browserFillReference.execute({ destinationOrigin: scope.destinationOrigin,
      items: issued.body.references.map((r: { referenceId: string }, i: number) => ({ referenceId: r.referenceId, ref: `@e${i + 1}` })),
    }, context)
    expect(result.isError).not.toBe(true)
    expect(JSON.stringify({ result, wire, trace: tools.getSessionTrace('s'), issued: issued.body })).not.toContain('SECRET_SENTINEL')
    expect((await tools.browserSnapshot.execute({}, context)).isError).toBe(true)
    const { destinationOrigin: _origin, ...identity } = binding
    const done = await request(app).post('/api/protected-browser-fill/complete').set('Origin', extensionOrigin).set('Authorization', `Bearer ${token}`).send(identity)
    expect(done.status).toBe(200)
    expect(completed).toBe(true)
    expect(service.isLocked(scope)).toBe(false)
  })
})
