/** [COMP:api/native-chat-read-cost] Lossless graph scheduling, separate from source admission. */
import {afterAll,describe,expect,it} from 'vitest'
import {getAppPool,getPool} from '../../db/client.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool()
type Node={tag:'source';kind:'session_message';id:string;version:string}
type Edge={parent:Node;child:Node;edge_kind:string}
type Graph={nodes:Node[];edges:number[][]}
const node=(i:number):Node=>({tag:'source',kind:'session_message',id:`00000000-0000-4000-8000-${i.toString(16).padStart(12,'0')}`,version:'1'})
async function seed(nodes:Node[]){return(await pool.query<{value:Graph|null}>('SELECT native_retained_graph_seed($1,false) value',[JSON.stringify(nodes)])).rows[0].value}
async function append(graph:Graph,edges:Edge[]){return(await pool.query<{value:Graph|null}>('SELECT native_retained_graph_append($1,$2,false) value',[JSON.stringify(graph),JSON.stringify(edges)])).rows[0].value}
afterAll(async()=>{await getAppPool().end();await pool.end()})

describe.sequential('[COMP:api/native-chat-read-cost] packed graph representation',()=>{
 it('retains every kind-bearing relationship beyond the expanded compiler edge budget',async()=>{
  const nodes=Array.from({length:192},(_,i)=>node(i+1))
  const edges:Edge[]=[]
  for(let parent=1;parent<nodes.length;parent++)for(let child=0;child<parent;child++){
   edges.push({parent:nodes[parent],child:nodes[child],edge_kind:'derivation'})
  }
  expect(edges.length).toBeGreaterThan(16_384)
  let graph=(await seed(nodes))!
  for(let start=0;start<edges.length;start+=256){
   const next=await append(graph,edges.slice(start,start+256));expect(next).not.toBeNull();graph=next!
  }
  expect(graph.edges).toHaveLength(edges.length)
  const result=(await pool.query<{order:string[];expanded:Edge[];bytes:number}>(`SELECT
   native_retained_graph_topology($1) "order",
   (SELECT jsonb_agg(to_jsonb(e) ORDER BY parent,child,edge_kind) FROM native_retained_graph_edges($1,false) e) expanded,
   pg_column_size($1::jsonb) bytes`,[JSON.stringify(graph)])).rows[0]
  expect(result.expanded).toHaveLength(edges.length)
  expect(new Set(result.expanded.map(edge=>JSON.stringify(edge))).size).toBe(edges.length)
  expect(new Set(result.order).size).toBe(nodes.length)
  const positions=new Map(result.order.map((key,index)=>[key,index]))
  const key=(n:Node)=>JSON.stringify(['source',n.kind,n.id,n.version]).replaceAll(',',', ')
  for(const edge of edges)expect(positions.get(key(edge.child))!).toBeLessThan(positions.get(key(edge.parent))!)
  expect(result.bytes).toBeLessThan(16*1024*1024)
  // Distinct kinds between identical endpoints remain separate obligations.
  const parallel=await append(graph,[{...edges[0],edge_kind:'observation'}])
  expect(parallel!.edges).toHaveLength(edges.length+1)
 },90_000)

 it('compares complete tuples independently of private dictionary order and rejects cycles',async()=>{
  const a=node(1001),b=node(1002)
  const graph=(await append((await seed([a,b]))!,[{parent:b,child:a,edge_kind:'derivation'}]))!
  const reversed={nodes:[...graph.nodes].reverse(),edges:graph.edges.map(([parent,child,kind])=>[1-parent,1-child,kind])}
  expect((await pool.query('SELECT native_retained_graph_equal($1,$2,false) value',[JSON.stringify(graph),JSON.stringify(reversed)])).rows[0].value).toBe(true)
  reversed.nodes[0]={...reversed.nodes[0],version:'2'}
  expect((await pool.query('SELECT native_retained_graph_equal($1,$2,false) value',[JSON.stringify(graph),JSON.stringify(reversed)])).rows[0].value).toBe(false)
  const cyclic=(await append(graph,[{parent:a,child:b,edge_kind:'derivation'}]))!
  expect((await pool.query('SELECT native_retained_graph_topology($1) value',[JSON.stringify(cyclic)])).rows[0].value).toBeNull()
  expect(await append(graph,[{parent:node(1003),child:a,edge_kind:'derivation'}])).toBeNull()
  expect(await append(graph,[{parent:b,child:a,edge_kind:'unknown'}])).toBeNull()
  expect(await seed([...graph.nodes,{...a,unexpected:true} as Node])).toBeNull()
  expect(await seed(Array.from({length:4097},(_,i)=>node(i+2000)))).toBeNull()
 })

 it('keeps the graph constructors and contract registry inaccessible to the application role',async()=>{
  expect((await pool.query(`SELECT has_table_privilege('app_user','native_retained_contract_helpers','SELECT') read,
   has_table_privilege('app_user','native_retained_contract_helpers','UPDATE') write`)).rows[0]).toEqual({read:false,write:false})
  expect((await pool.query(`SELECT p.oid::regprocedure::text signature FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'native_retained_%'
    AND has_function_privilege('app_user',p.oid,'EXECUTE')`)).rows).toEqual([])
 })
})
