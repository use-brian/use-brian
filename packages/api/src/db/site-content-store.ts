/** Transactional draft/publication authority for website content collections. [COMP:crm/site-content] */
import type { Pool, PoolClient } from 'pg'
import { AssociationError, parseSiteContent, resolveSiteContent, siteContentPublicationIssueDetails, siteContentPublicationIssues, SITE_CONTENT_COLLECTIONS, SITE_CONTENT_READERS,
  type AssociationActor, type SiteContentCollection, type SiteContentDocument, type SiteContentSite } from '@use-brian/core'
import { getPool } from './client.js'

type Observations = Record<string, { revision: number; observedAt: string }>
type State = { draft_version: number; draft: SiteContentDocument | null; published_revision: number; observations: Observations }
const empty: State = { draft_version: 0, draft: null, published_revision: 0, observations: {} }

export function createSiteContentStore(pool: Pool = getPool()) {
  // Website content is not commerce: the Association module state never freezes editing (owner/admin is checked by the service).
  async function transaction<T>(workspaceId: string, collection: SiteContentCollection, fn: (client: PoolClient) => Promise<T>) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      // One lock per collection: publishing news never waits on the home page, and never on checkouts.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('site-content:'||$1||':'||$2,0))", [workspaceId, collection])
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
  async function state(client: PoolClient, workspaceId: string, collection: SiteContentCollection): Promise<State> {
    return (await client.query<State>('SELECT * FROM association_site_content WHERE workspace_id=$1 AND collection=$2', [workspaceId, collection])).rows[0] ?? empty
  }
  async function published(client: PoolClient, workspaceId: string, collection: SiteContentCollection, revision: number) {
    const row = (await client.query<{ document: unknown }>('SELECT document FROM association_site_content_revisions WHERE workspace_id=$1 AND collection=$2 AND revision=$3',
      [workspaceId, collection, revision])).rows[0]
    return row ? parseSiteContent(collection, row.document) : null
  }
  async function audit(client: PoolClient, workspaceId: string, action: string, collection: SiteContentCollection, version: number, actor: AssociationActor) {
    await client.query(`INSERT INTO association_audit_log (workspace_id,action,subject_kind,subject_id,actor_kind,actor_credential_id,acting_user_id,metadata)
      VALUES ($1,$2,'site_content',$1,$3,$4,$5,$6)`, [workspaceId, action, actor.credentialKind, actor.credentialId, actor.actingUserId ?? null, { collection, version }])
  }
  return {
    async draft(workspaceId: string, collection: SiteContentCollection) {
      return transaction(workspaceId, collection, async client => {
        const row = await state(client, workspaceId, collection)
        return { collection, version: row.draft_version, document: row.draft, publishedRevision: row.published_revision,
          published: await published(client, workspaceId, collection, row.published_revision), observations: row.observations,
          readers: SITE_CONTENT_READERS[collection], issues: row.draft ? siteContentPublicationIssues(collection, row.draft) : [],
          issueDetails: row.draft ? siteContentPublicationIssueDetails(collection, row.draft) : [] }
      })
    },
    async save(workspaceId: string, collection: SiteContentCollection, expectedVersion: number, raw: unknown, actor: AssociationActor) {
      const document = parseSiteContent(collection, raw)
      return transaction(workspaceId, collection, async client => {
        const current = await state(client, workspaceId, collection)
        if (current.draft_version !== expectedVersion) throw new AssociationError('conflict', 'The draft changed. Reload before saving.')
        const version = expectedVersion + 1
        await client.query(`INSERT INTO association_site_content(workspace_id,collection,draft_version,draft) VALUES($1,$2,$3,$4)
          ON CONFLICT(workspace_id,collection) DO UPDATE SET draft_version=$3,draft=$4,updated_at=now()`, [workspaceId, collection, version, document])
        await audit(client, workspaceId, 'site_content.draft_saved', collection, version, actor)
        const issueDetails = siteContentPublicationIssueDetails(collection, document)
        return { collection, version, issues: issueDetails.map(issue => issue.message), issueDetails }
      })
    },
    async publish(workspaceId: string, collection: SiteContentCollection, expectedVersion: number, actor: AssociationActor) {
      return transaction(workspaceId, collection, async client => {
        const current = await state(client, workspaceId, collection)
        if (current.draft_version !== expectedVersion || !current.draft) throw new AssociationError('conflict', 'The draft changed. Preview it again before publishing.')
        if (current.published_revision === expectedVersion) return { collection, revision: expectedVersion, synchronization: 'pending', observations: current.observations }
        const document = parseSiteContent(collection, current.draft)
        const issues = siteContentPublicationIssues(collection, document)
        if (issues.length) throw new AssociationError('conflict', issues.join('; '))
        await client.query('INSERT INTO association_site_content_revisions(workspace_id,collection,revision,document,actor) VALUES($1,$2,$3,$4,$5)',
          [workspaceId, collection, expectedVersion, document, actor])
        await client.query('UPDATE association_site_content SET published_revision=$3,observations=\'{}\'::jsonb,updated_at=now() WHERE workspace_id=$1 AND collection=$2',
          [workspaceId, collection, expectedVersion])
        await audit(client, workspaceId, 'site_content.published', collection, expectedVersion, actor)
        return { collection, revision: expectedVersion, synchronization: 'pending', observations: {} }
      })
    },
    async read(workspaceId: string, collection: SiteContentCollection, site: SiteContentSite) {
      if (!SITE_CONTENT_READERS[collection].includes(site)) throw new AssociationError('not_available', `${collection} is not published for ${site}.`)
      return transaction(workspaceId, collection, async client => {
        const row = await state(client, workspaceId, collection)
        const document = await published(client, workspaceId, collection, row.published_revision)
        if (!document) throw new AssociationError('not_available', `Website ${collection} content has not been published.`)
        return { collection, revision: row.published_revision, source: 'brian', site, document: resolveSiteContent(collection, document, site) }
      })
    },
    /** Summaries for every collection (no document bodies): what the console Home and Pages & sections show. */
    async status(workspaceId: string) {
      const rows = (await pool.query<State & { collection: SiteContentCollection; updated_at: Date; published_at: Date | null }>(
        `SELECT c.*, r.published_at FROM association_site_content c
           LEFT JOIN association_site_content_revisions r ON r.workspace_id=c.workspace_id AND r.collection=c.collection AND r.revision=c.published_revision
          WHERE c.workspace_id=$1`, [workspaceId])).rows
      return SITE_CONTENT_COLLECTIONS.map(collection => {
        const row = rows.find(candidate => candidate.collection === collection)
        return { collection, readers: SITE_CONTENT_READERS[collection], version: row?.draft_version ?? 0, publishedRevision: row?.published_revision ?? 0,
          publishedAt: row?.published_at?.toISOString() ?? null, updatedAt: row?.updated_at?.toISOString() ?? null, observations: row?.observations ?? {},
          issueCount: row?.draft ? siteContentPublicationIssues(collection, row.draft).length : 0 }
      })
    },
    async observe(workspaceId: string, collection: SiteContentCollection, site: SiteContentSite, revision: number) {
      await pool.query(`UPDATE association_site_content SET observations=jsonb_set(observations,ARRAY[$3],$4::jsonb)
        WHERE workspace_id=$1 AND collection=$2 AND published_revision=$5`,
        [workspaceId, collection, site, JSON.stringify({ revision, observedAt: new Date().toISOString() }), revision])
      return { collection, revision, site }
    },
  }
}
