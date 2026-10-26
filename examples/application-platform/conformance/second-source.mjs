/** Separate source adapter with no operations-module or host ACL imports. */
import { createConnectorActorVerifier, handleSourceSidecar, SourceProtocolError } from '@use-brian/brian-app/connector'
export function createDispatchNotesSource({trust,consumeReplay,authenticateTransport,source}={}){
 if(!trust||typeof consumeReplay!=='function'||typeof authenticateTransport!=='function'||!source?.capabilities||!source.authorize||!source.reconcile)throw new SourceProtocolError('source_unavailable')
 const verifyActor=createConnectorActorVerifier({...trust,consumeReplay})
 return{sidecar(endpoint,request,assertion){return handleSourceSidecar({endpoint,request,assertion,authenticateTransport,verifyActor},source)}}
}
