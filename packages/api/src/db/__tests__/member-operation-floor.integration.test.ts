import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { getPool, getAppPool, queryWithRLS } from '../client.js'
import { createDbWorkspaceGroupStore } from '../workspace-group-store.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool()

// Migration 589's per-row floor, verbatim, as the reference 611 must match.
const FLOOR_589=`CREATE FUNCTION pg_temp.floor_589(w uuid,sensitivity text,compartments text[],mutation boolean)
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE actor uuid=nullif(current_setting('app.current_user_id',true),'')::uuid;
  member_role text; clearance text; reach text[];
BEGIN
  SELECT m.role,CASE WHEN m.role IN('owner','admin') THEN 'confidential' ELSE m.clearance END
    INTO member_role,clearance FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=actor;
  IF member_role IS NULL OR sensitivity_rank(clearance) IS NULL OR sensitivity_rank(sensitivity) IS NULL
    OR sensitivity_rank(sensitivity)>sensitivity_rank(clearance) THEN RETURN false; END IF;
  reach=CASE WHEN mutation THEN effective_member_team_compartments(actor,w) ELSE effective_member_read_compartments(actor,w) END;
  RETURN reach IS NULL OR coalesce(compartments,'{}') <@ reach;
END $$`

async function user() {
  const id=randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[id])
  return id
}
async function workspace(ownerId:string) {
  const id=randomUUID()
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Member floor fixture',$2)",[id,ownerId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','public')",[id,ownerId])
  return id
}
async function member(workspaceId:string,userId:string,role:string,clearance:string,extra='') {
  await pool.query(`INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,$3,$4)`,[workspaceId,userId,role,clearance])
  if(extra)await pool.query(`UPDATE workspace_members SET ${extra} WHERE workspace_id=$1 AND user_id=$2`,[workspaceId,userId])
}

/** Two workspaces, members across roles/clearances/Team modes, and a row grid. */
async function grid() {
  const owner=await user(),admin=await user(),assigned=await user(),legacy=await user(),restricted=await user(),outsider=await user()
  const ws=await workspace(owner),other=await workspace(owner)
  const groups=createDbWorkspaceGroupStore()
  const finance=await groups.createTeam(owner,ws,{name:'Finance',key:'finance'})
  const ops=await groups.createTeam(owner,ws,{name:'Ops',key:'ops'})
  await member(ws,admin,'admin','internal')
  await member(ws,assigned,'member','internal',"team_scope_mode='assigned',compartments=NULL")
  await groups.addMember(owner,finance.id,assigned)
  await member(ws,legacy,'member','public')
  await member(ws,restricted,'member','confidential',"compartments='{}'")
  await member(other,assigned,'member','confidential')
  const keys=[[],[finance.compartmentKey],[ops.compartmentKey],[finance.compartmentKey,ops.compartmentKey]]
  for(const w of [ws,other])for(const sensitivity of ['public','internal','confidential'])for(const compartments of (w===ws?keys:[[]])) {
    await pool.query("INSERT INTO entities(workspace_id,created_by_user_id,kind,display_name,source,sensitivity,compartments) VALUES($1,$2,'person','Grid row','user',$3,$4)",[w,owner,sensitivity,compartments])
  }
  return {ws,other,actors:{owner,admin,assigned,legacy,restricted,outsider}}
}

describe('[COMP:api/member-operation-floor] per-statement member operation floor',()=>{
  afterAll(async()=>{await getAppPool().end();await pool.end()})

  it('decides exactly as the 589 per-row floor for every actor, row and operation',async()=>{
    const g=await grid(),client=await pool.connect()
    try {
      await client.query(FLOOR_589)
      let allowed=0,denied=0
      for(const [name,actor] of Object.entries(g.actors)) {
        await client.query("SELECT set_config('app.current_user_id',$1,false)",[actor])
        const rows=(await client.query(`SELECT e.id,v.m,
            pg_temp.floor_589(e.workspace_id,e.sensitivity,e.compartments,v.m) ref,
            member_operation_scope_allows(e.workspace_id,e.sensitivity,e.compartments,v.m) scalar,
            member_operation_row_allows(member_operation_grants(v.m),e.workspace_id,e.sensitivity,e.compartments) policy
          FROM entities e CROSS JOIN (VALUES(false),(true)) v(m) WHERE e.workspace_id=ANY($1)`,[[g.ws,g.other]])).rows
        expect(rows.length).toBeGreaterThan(0)
        for(const row of rows) {
          expect({name,...row,scalar:row.scalar}).toEqual({name,...row,scalar:row.ref})
          expect({name,...row,policy:row.policy}).toEqual({name,...row,policy:row.ref})
          if(row.ref)allowed++;else denied++
        }
        // The live app-role RLS path returns exactly the rows the reference allows.
        const visible=(await queryWithRLS(actor,'SELECT id FROM entities WHERE workspace_id=ANY($1)',[[g.ws,g.other]])).rows.map(r=>r.id).sort()
        expect({name,visible}).toEqual({name,visible:rows.filter(r=>r.m===false&&r.ref).map(r=>r.id).sort()})
      }
      // A degenerate grid (all allowed or all denied) would prove nothing.
      expect(allowed).toBeGreaterThan(10)
      expect(denied).toBeGreaterThan(10)
    }finally{client.release()}
  })

  it('resolves member reach once per statement, not once per scanned row',async()=>{
    const owner=await user(),reader=await user(),ws=await workspace(owner)
    const team=await createDbWorkspaceGroupStore().createTeam(owner,ws,{name:'Finance',key:'finance'})
    await member(ws,reader,'member','internal',"team_scope_mode='assigned',compartments=NULL")
    await createDbWorkspaceGroupStore().addMember(owner,team.id,reader)
    const rows=400
    await pool.query("INSERT INTO entities(workspace_id,created_by_user_id,kind,display_name,source) SELECT $1,$2,'person','Row '||n,'user' FROM generate_series(1,$3) n",[ws,owner,rows])
    const appRole=new URL(process.env.DATABASE_URL_APP!).username
    await pool.query(`ALTER ROLE ${pg.escapeIdentifier(appRole)} SET track_functions='all'`)
    const calls=async()=>{
      await pool.query('SELECT pg_stat_clear_snapshot()')
      return Number((await pool.query("SELECT coalesce(sum(calls),0) calls FROM pg_stat_user_functions WHERE funcname='effective_member_read_compartments'")).rows[0].calls)
    }
    const app=new pg.Client({connectionString:process.env.DATABASE_URL_APP})
    await app.connect()
    try {
      const before=await calls()
      await app.query('BEGIN')
      await app.query("SELECT set_config('app.current_user_id',$1,true)",[reader])
      // A name miss forces RLS to evaluate the floor on every row first:
      // lower() is not leakproof, so the caller predicate cannot run earlier.
      const miss=await app.query("SELECT id FROM entities WHERE workspace_id=$1 AND lower(display_name)=lower('No such name')",[ws])
      const all=await app.query('SELECT count(*)::int n FROM entities WHERE workspace_id=$1',[ws])
      await app.query('COMMIT')
      await app.query('SELECT pg_stat_force_next_flush()')
      expect(miss.rows).toEqual([])
      expect(all.rows[0].n).toBe(rows)
      let delta=0
      for(let attempt=0;attempt<20&&delta===0;attempt++){delta=(await calls())-before;if(!delta)await new Promise(r=>setTimeout(r,100))}
      // Two statements, one membership: bounded by statements, not by 2 x 400 rows.
      expect(delta).toBeGreaterThan(0)
      expect(delta).toBeLessThanOrEqual(4)
    }finally{await app.end();await pool.query(`ALTER ROLE ${pg.escapeIdentifier(appRole)} RESET track_functions`)}
  })

  it('leaves no policy evaluating the floor per row',async()=>{
    const policies=(await pool.query(`SELECT polrelid::regclass::text tab,polname,
        coalesce(pg_get_expr(polqual,polrelid),'')||' '||coalesce(pg_get_expr(polwithcheck,polrelid),'') expr FROM pg_policy`)).rows
    expect(policies.filter(p=>/member_operation_scope_allows\(/.test(p.expr)).map(p=>`${p.tab}.${p.polname}`)).toEqual([])
    const floor=policies.filter(p=>/member_operation_grants\(/.test(p.expr))
    expect(floor).toHaveLength(40)
    // Every grants call must sit inside a sub-select, which PostgreSQL runs once.
    for(const p of floor)expect({policy:`${p.tab}.${p.polname}`,bare:/(?<!SELECT )member_operation_grants\(/.test(p.expr)}).toEqual({policy:`${p.tab}.${p.polname}`,bare:false})
  })
})
