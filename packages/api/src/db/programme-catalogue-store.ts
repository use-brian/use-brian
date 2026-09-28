/** Transactional draft/publication authority for website programme content. [COMP:crm/programme-catalogue] */
import type { Pool, PoolClient } from 'pg'
import { AssociationError, ProgrammeCatalogueDocumentSchema, programmePublicationIssues, resolveProgrammeCatalogue,
  type ProgrammeCatalogueDocument, type ProgrammeSite, type AssociationActor } from '@use-brian/core'
import { getPool } from './client.js'

type State = { draft_version: number; draft: ProgrammeCatalogueDocument | null; published_revision: number; observations: Record<string, { revision: number; observedAt: string }> }
const empty: State = { draft_version: 0, draft: null, published_revision: 0, observations: {} }
export function createProgrammeCatalogueStore(pool: Pool = getPool()) {
  // Programme pages are website content: the Association module state never freezes editing (owner/admin is checked by the service).
  async function transaction<T>(workspaceId: string, fn: (client: PoolClient) => Promise<T>) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      // Own lock key: content publication never serialises against membership checkouts.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('programme-catalogue:'||$1,0))", [workspaceId])
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
  async function state(client: PoolClient, workspaceId: string): Promise<State> {
    return (await client.query<State>('SELECT * FROM association_programme_catalogues WHERE workspace_id=$1', [workspaceId])).rows[0] ?? empty
  }
  async function published(client: PoolClient, workspaceId: string, revision: number) {
    const row = (await client.query<{ document: ProgrammeCatalogueDocument }>('SELECT document FROM association_programme_catalogue_revisions WHERE workspace_id=$1 AND revision=$2', [workspaceId, revision])).rows[0]
    return row ? ProgrammeCatalogueDocumentSchema.parse(row.document) : null
  }
  async function audit(client: PoolClient, workspaceId: string, action: string, version: number, actor: AssociationActor) {
    await client.query(`INSERT INTO association_audit_log (workspace_id,action,subject_kind,subject_id,actor_kind,actor_credential_id,acting_user_id,metadata)
      VALUES ($1,$2,'programme_catalogue',$1,$3,$4,$5,$6)`, [workspaceId, action, actor.credentialKind, actor.credentialId, actor.actingUserId ?? null, { version }])
  }
  return {
    async draft(workspaceId: string) {
      return transaction(workspaceId, async client => {
        const row = await state(client, workspaceId)
        return { version: row.draft_version, document: row.draft, publishedRevision: row.published_revision,
          published: await published(client, workspaceId, row.published_revision), observations: row.observations,
          issues: row.draft ? programmePublicationIssues(row.draft) : [] }
      })
    },
    async save(workspaceId: string, expectedVersion: number, raw: ProgrammeCatalogueDocument, actor: AssociationActor) {
      const document = ProgrammeCatalogueDocumentSchema.parse(raw)
      return transaction(workspaceId, async client => {
        const current = await state(client, workspaceId)
        if (current.draft_version !== expectedVersion) throw new AssociationError('conflict', 'The draft changed. Reload before saving.')
        const version = expectedVersion + 1
        await client.query(`INSERT INTO association_programme_catalogues(workspace_id,draft_version,draft) VALUES($1,$2,$3)
          ON CONFLICT(workspace_id) DO UPDATE SET draft_version=$2,draft=$3,updated_at=now()`, [workspaceId, version, document])
        await audit(client, workspaceId, 'programme_catalogue.draft_saved', version, actor)
        return { version, issues: programmePublicationIssues(document) }
      })
    },
    async publish(workspaceId: string, expectedVersion: number, actor: AssociationActor) {
      return transaction(workspaceId, async client => {
        const current = await state(client, workspaceId)
        if (current.draft_version !== expectedVersion || !current.draft) throw new AssociationError('conflict', 'The draft changed. Preview it again before publishing.')
        if (current.published_revision === expectedVersion) return { revision: expectedVersion, synchronization: 'pending', observations: current.observations }
        const document = ProgrammeCatalogueDocumentSchema.parse(current.draft)
        const issues = programmePublicationIssues(document)
        if (issues.length) throw new AssociationError('conflict', issues.join('; '))
        const previous = await published(client, workspaceId, current.published_revision)
        // Inbound links and redirects depend on slugs: retire a programme instead of deleting it.
        const missing = (previous?.programmes ?? []).filter(programme => !document.programmes.some(next => next.slug === programme.slug))
        if (missing.length) throw new AssociationError('conflict', `Keep previously published programme slugs for inbound links; set status to retired instead: ${missing.map(programme => programme.slug).join(', ')}`)
        await client.query('INSERT INTO association_programme_catalogue_revisions(workspace_id,revision,document,actor) VALUES($1,$2,$3,$4)', [workspaceId, expectedVersion, document, actor])
        await client.query('UPDATE association_programme_catalogues SET published_revision=$2,observations=\'{}\'::jsonb,updated_at=now() WHERE workspace_id=$1', [workspaceId, expectedVersion])
        await audit(client, workspaceId, 'programme_catalogue.published', expectedVersion, actor)
        return { revision: expectedVersion, synchronization: 'pending', observations: {} }
      })
    },
    async read(workspaceId: string, site: ProgrammeSite) {
      return transaction(workspaceId, async client => {
        const row = await state(client, workspaceId)
        const document = await published(client, workspaceId, row.published_revision)
        if (!document) throw new AssociationError('not_available', 'Programme content has not been published.')
        // Retired programmes are included so the website can redirect their old URLs.
        return { revision: row.published_revision, source: 'brian', site, ...resolveProgrammeCatalogue(document, site, true) }
      })
    },
    /** Summary without the document body: what the console Home and Website overview show. */
    async status(workspaceId: string) {
      const row = (await pool.query<State & { updated_at: Date; published_at: Date | null }>(
        `SELECT c.*, r.published_at FROM association_programme_catalogues c
           LEFT JOIN association_programme_catalogue_revisions r ON r.workspace_id=c.workspace_id AND r.revision=c.published_revision
          WHERE c.workspace_id=$1`, [workspaceId])).rows[0]
      return { version: row?.draft_version ?? 0, publishedRevision: row?.published_revision ?? 0, publishedAt: row?.published_at?.toISOString() ?? null,
        updatedAt: row?.updated_at?.toISOString() ?? null, observations: row?.observations ?? {}, issueCount: row?.draft ? programmePublicationIssues(row.draft).length : 0 }
    },
    async observe(workspaceId: string, site: ProgrammeSite, revision: number) {
      await pool.query(`UPDATE association_programme_catalogues SET observations=jsonb_set(observations,ARRAY[$2],$3::jsonb)
        WHERE workspace_id=$1 AND published_revision=$4`, [workspaceId, site, JSON.stringify({ revision, observedAt: new Date().toISOString() }), revision])
      return { revision, site }
    },
  }
}
