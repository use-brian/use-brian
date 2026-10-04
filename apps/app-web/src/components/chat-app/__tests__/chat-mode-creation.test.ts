import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
const source=readFileSync(new URL('../chat-surface.tsx',import.meta.url),'utf8');
describe('[COMP:app-web/mode-aware-context] shared chat creation hosts',()=>{
 it('routes new shared work through explicit intent and preview before both create calls',()=>{
 expect(source).toContain('activeSessionId?"existing":view==="workspace"?"new-shared":"private"');
 expect(source).toContain('<ModeAwareCreationContext context={creationContext}/>');
 expect(source.match(/expectedPolicyRevision:admitted.expectedPolicyRevision/g)).toHaveLength(2);
 expect(source.match(/contextGroupId: admitted.contextGroupId/g)).toHaveLength(2);
 expect(source).toContain('!creationContext.snapshot()');
 });
 it('leaves existing session and private explicit-null stream context unchanged',()=>{
 expect(source).toContain('...(!sessionIdRef.current');
 expect(source).toContain('contextGroupId: pickedContextGroupId');
 expect(source).toContain('sessionId: sessionIdRef.current');
 expect(source).toContain('creationContext.fail()');
 });
});
