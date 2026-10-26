/** An unrelated deployed module using only the public module kit. */
import type { ApplicationModuleDefinition, ApplicationRegisteredOperation, ApplicationRegisteredCommand, defineApplicationModules } from '@use-brian/brian-app/module'
export function createDispatchNotesModule<T>(ports:{read:ApplicationRegisteredOperation<T>;change:ApplicationRegisteredCommand<T>}):ApplicationModuleDefinition<T>{
 if(!ports?.read?.authorize||!ports.read.authorizeResult||!ports.change?.authorize||!ports.change.authorizeResult)throw new Error('operation_not_available')
 return{key:'dispatch_notes',defaultState:'enabled',application:{version:'1',dependencies:[],resources:[{typeKey:'dispatch_note',origin:{kind:'native',moduleKey:'dispatch_notes'},schemaVersion:'1',fields:[{key:'title',label:'Title',kind:'text'}]}],queries:['lookup'],commands:['change_note'],events:['dispatch.changed'],policyCapabilities:[],backgroundHandlers:[],uiContributions:[]},queries:{lookup:ports.read},commands:{change_note:{...ports.change,eventKey:'dispatch.changed'}}}
}
export function registerDispatchNotesModule<T>(register:typeof defineApplicationModules<T>,existing:Parameters<typeof defineApplicationModules<T>>[1],ports:Parameters<typeof createDispatchNotesModule<T>>[0]){return register([createDispatchNotesModule(ports)],existing)}
