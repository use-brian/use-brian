# Current action and delivery admission

The architectural rebuild removes the unused action snapshot cache, execution
snapshot provider and permission-invalidation subscriber. Native chat constructed
these objects but the tool executor never selected them. The production action
contract remains with the actual tool executor and invocation lease.

Every tool action checks live authority after queue or confirmation waits and
checks it again on return. Each action retains its original maximum scope and
identity. Grant expiry is observed from live facts without a timer or notification.
A revoked action cannot start; an effect that may already have executed is never
automatically replayed. A permission change does not convert completed work into
an unexecuted action. Stop abandons the wait according to the existing tool contract.

Native web output uses one `TurnDeliveryAdmission` in
`packages/api/src/context-scope/admission.ts`. It binds the original execution,
accumulator and stored destination, checks all accumulated evidence afresh for
every event, fences asynchronous evidence changes and owns sticky refusal and
disposal. It stores no allow decision, refreshed execution or selected-grant map.

The former proposal to switch immutable executions between actions and relax
in-flight grant withdrawal was never enabled. This rebuild preserves the live
SQL/source/credential rules rather than introducing that separate behavior.
Historical migration 8208 remains immutable. The authenticated forward migration
retires its four unused notification triggers and their producer function.

Coverage: actual tool-executor authority and Stop tests, session authority
expiry/revocation integration tests, and delivery identity/disposal/race tests.
