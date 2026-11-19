/**
 * Fixture-only privileged setup for native integration suites.
 *
 * The disposable PostgreSQL fixture (`scripts/crm/local-fixture.mjs`) migrates
 * as an ordinary owner: no SUPERUSER, BYPASSRLS, CREATEROLE or CREATEDB. A
 * suite that needs a disposable observer role, a role setting, a scratch
 * database or a role switch performs only that setup through the fixture's
 * bootstrap role (the cluster superuser that provisioned the owner). Migrations
 * and the behavior under test keep running as the ordinary owner and app_user.
 *
 * Legacy rows that product triggers now refuse are modelled through the same
 * path a migration must use: the owner suspends a table's own triggers by exact
 * name inside one transaction (`withTableTriggersSuspended`). Nothing here sets
 * `session_replication_role` or disables `ALL` triggers.
 */
import pg from 'pg'

type Marker = { port: number; bootstrapRole?: string }
type Queryable = Pick<pg.ClientBase, 'query'>

const fixtureModule = new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href

async function ownedMarker(): Promise<Marker | null> {
  if (!process.env.BRIAN_ASSURANCE_FIXTURE) return null
  const { assertLocalFixture } = await import(fixtureModule) as { assertLocalFixture: () => Promise<Marker> }
  return assertLocalFixture()
}

/**
 * The bootstrap login for the database `connectionString` names. Inside the
 * owned fixture this is the marker's bootstrap role (same generated secret as
 * the owner). Outside a fixture, or for a URL that is not on the fixture's
 * port, the caller's own connection is returned unchanged: such a database was
 * supplied explicitly and its role already carries whatever it carries.
 */
export async function bootstrapConnectionString(connectionString = process.env.DATABASE_URL!): Promise<string> {
  const marker = await ownedMarker()
  const url = new URL(connectionString)
  if (!marker?.bootstrapRole || Number(url.port) !== marker.port) return url.href
  url.username = marker.bootstrapRole
  return url.href
}

/** The login role a connection string names (the ordinary owner for DATABASE_URL). */
export function connectionRole(connectionString = process.env.DATABASE_URL!): string {
  return decodeURIComponent(new URL(connectionString).username)
}

/** A connected bootstrap client; the caller ends it. */
export async function connectBootstrap(connectionString = process.env.DATABASE_URL!): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: await bootstrapConnectionString(connectionString) })
  await client.connect()
  return client
}

/** Runs fixture-only privileged setup (roles, role settings, databases) on a short-lived bootstrap session. */
export async function withBootstrap<T>(run: (client: pg.Client) => Promise<T>, connectionString = process.env.DATABASE_URL!): Promise<T> {
  const client = await connectBootstrap(connectionString)
  try { return await run(client) } finally { await client.end() }
}

/**
 * A bootstrap session that acts as `role` (normally the ordinary owner) for
 * everything it runs, so the tested statements keep the owner's privileges.
 * Because the session user is the bootstrap role, the suite may switch to a
 * disposable observer or app_user with `SET LOCAL ROLE` and then back to the
 * owner with `actAs`, which an ordinary owner session cannot do. `privileged`
 * runs one statement batch as the bootstrap role and restores the actor.
 */
export async function connectActingAs(role = connectionRole(), connectionString = process.env.DATABASE_URL!) {
  const client = await connectBootstrap(connectionString)
  const identifier = pg.escapeIdentifier(role)
  await client.query(`SET ROLE ${identifier}`)
  return {
    client,
    role,
    /** Restore the acting role (session-level, survives the transaction). */
    actAs: async () => { await client.query(`SET ROLE ${identifier}`) },
    privileged: async <T>(run: () => Promise<T>): Promise<T> => {
      await client.query('RESET ROLE')
      try { return await run() } finally { await client.query(`SET ROLE ${identifier}`) }
    },
  }
}

/**
 * Creates a scratch database for a bounded historical replay. Like the
 * maintained fixture, the ordinary owner owns the database and the two
 * extensions the open baseline moves into `public`, so the replay itself runs
 * without elevated attributes. Returns its owner URL and a disposer.
 */
export async function createOwnedScratchDatabase(name: string, connectionString = process.env.DATABASE_URL!) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) throw new Error('Invalid scratch database name')
  const owner = pg.escapeIdentifier(connectionRole(connectionString))
  const maintenance = new URL(connectionString); maintenance.pathname = '/postgres'
  await withBootstrap(client => client.query(`CREATE DATABASE ${name} OWNER ${owner} TEMPLATE template0`), maintenance.href)
  const scratch = new URL(connectionString); scratch.pathname = `/${name}`
  const dispose = () => withBootstrap(client => client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`), maintenance.href)
  try {
    await withBootstrap(async client => {
      const installer = `scratch_extension_${name}`.slice(0, 63)
      await client.query(`BEGIN;
        CREATE ROLE ${installer} SUPERUSER NOLOGIN;
        SET LOCAL ROLE ${installer};
        CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
        CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
        RESET ROLE;
        REASSIGN OWNED BY ${installer} TO ${owner};
        DROP ROLE ${installer};
        COMMIT`)
    }, scratch.href)
  } catch (error) { await dispose(); throw error }
  return { url: scratch.href, dispose }
}

/**
 * The sanctioned path for a fixture-only legacy row that a product trigger now
 * refuses or stamps: inside the caller's open transaction, the table owner
 * disables each listed table's origin-enabled user triggers by exact name,
 * runs `run`, then re-enables exactly those names before the caller commits.
 * Internal constraint triggers keep firing and `session_replication_role`
 * stays `origin`. A failure leaves the caller to roll back, which also
 * restores the triggers; concurrent sessions never observe them disabled.
 */
export async function withTableTriggersSuspended<T>(client: Queryable, tables: string[], run: () => Promise<T>): Promise<T> {
  // Refuse outside a transaction block: an autocommitted DISABLE would leak.
  await client.query('SAVEPOINT fixture_trigger_suspension')
  await client.query('RELEASE SAVEPOINT fixture_trigger_suspension')
  const suspended: Array<{ relation: string; name: string }> = []
  for (const table of tables) {
    const rows = (await client.query<{ relation: string; name: string }>(
      `SELECT t.tgrelid::regclass::text AS relation, t.tgname AS name FROM pg_trigger t
       WHERE t.tgrelid=$1::regclass AND NOT t.tgisinternal AND t.tgenabled='O' ORDER BY t.tgname`, [table])).rows
    for (const row of rows) {
      await client.query(`ALTER TABLE ${row.relation} DISABLE TRIGGER ${pg.escapeIdentifier(row.name)}`)
      suspended.push(row)
    }
  }
  const result = await run()
  for (const row of suspended) await client.query(`ALTER TABLE ${row.relation} ENABLE TRIGGER ${pg.escapeIdentifier(row.name)}`)
  return result
}
