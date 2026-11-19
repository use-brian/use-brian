/** [COMP:invariants/chat-import-graph] Seed a connected fixture mailbox and synced archive bytes. */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { MAILBOX_QUERY, MAILBOX_RECEIPT } from './mailbox-archive-probe.mjs'

const { BRIAN_ACCEPTANCE_OSS_ROOT: root, BRIAN_ACCEPTANCE_WORKSPACE_ID: workspaceId, CHANNEL_CREDENTIAL_KEY: credentialKey } = process.env
if (!root || !workspaceId || !credentialKey || !process.send) throw new Error('Fixture mailbox requires disposable database identity and private IPC')
const { assertLocalFixture } = await import(pathToFileURL(join(root, 'scripts/crm/local-fixture.mjs')).href)
await assertLocalFixture()
const built = path => import(pathToFileURL(join(root, 'packages/api/dist', path)).href)
const [{ getPool, getAppPool }, { createConnectorInstanceStore }, { insertEmailArchiveMessage, searchEmailArchive },
  { createDbAssistantConnectorStore }, { createConnectorGrantStore }] = await Promise.all([
  built('db/client.js'), built('db/connector-instance-store.js'), built('db/email-archive-store.js'),
  built('db/assistant-connector-store.js'), built('db/connector-grant-store.js'),
])
try {
  const expected = (await getPool().query(`SELECT w.owner_user_id AS owner,a.id AS assistant,
   (SELECT id FROM users WHERE auth_provider_id='m6-fictional-runtime-outsider') AS outsider
   FROM workspaces w JOIN users u ON u.id=w.owner_user_id JOIN assistants a ON a.workspace_id=w.id AND a.kind='primary'
   WHERE w.id=$1 AND u.auth_provider_id='m6-fictional-runtime-owner'`, [workspaceId])).rows[0]
  if (!expected?.owner || !expected.assistant || !expected.outsider) throw new Error('Fixture workspace or user binding is absent')
  const email = 'm4-mailbox@example.test'
  const instance = await createConnectorInstanceStore(Buffer.from(credentialKey, 'base64')).createUserInstance({
    userId: expected.owner, createdBy: expected.owner, provider: 'imap', label: 'Fictional M4 mailbox', custom: false, connected: true,
    credentials: { type: 'imap', email, appPassword: 'fictional-only', imapHost: '127.0.0.1', imapPort: 1, smtpHost: '127.0.0.1', smtpPort: 1 },
  })
  await createConnectorGrantStore().create({ actingUserId: expected.owner, connectorInstanceId: instance.id,
    targetType: 'workspace', targetId: workspaceId, compartments: [], projectIds: [] })
  await createDbAssistantConnectorStore().setEnabled(expected.assistant, 'imap', true)
  const { inserted, segmentCount } = await insertEmailArchiveMessage({
    workspaceId, ownerUserId: expected.owner, instanceId: instance.id, folder: 'INBOX', providerMessageId: 'INBOX:6291',
    subject: MAILBOX_QUERY, from: 'm4-sender@example.test', to: [email], bodyText: MAILBOX_RECEIPT, sentAt: new Date(),
  })
  if (!inserted || segmentCount !== 1) throw new Error('Expected one synced fixture message segment')
  const outsider = await searchEmailArchive({ ownerUserId: expected.outsider, instanceId: instance.id, query: MAILBOX_QUERY })
  if (outsider.hits.length !== 0) throw new Error('Fictional archive was readable by the other fixture identity')
  process.send({ type: 'fixture-mailbox', segmentCount, outsiderVisible: false })
} finally {
  await Promise.allSettled([getPool().end(), getAppPool().end()])
}
