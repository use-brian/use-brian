# Application SDK and scaffolds

Status: R5a implementation contract; runtime qualification is false. Nothing here
activates protected app access or certifies an installed application.

Public profiles: `@use-brian/brian-app` (bundle validation), `./application`
(browser client and app-bound PKCE/Home adapters), `./module` (canonical deployed
module types and server credentials), `./connector` (Node-only actor/source kit).
See the package README for executable commands and deployment ports. The SDK
preserves opaque versions, actual returned fields, source evidence and receipts;
it does not grant access, cache protected data or automatically retry writes.

The app-bound OAuth consent lifecycle supplies user identity. Home uses its
existing authenticated parent-window bridge. Service/delegated keys stay on the
server; delegated identity requires a validated app-bound OAuth proof. Never put
keys, cookies or native JWTs in a bundle or localStorage.

Schema preview/apply requires the final R2 registered transport contract; missing
ports explicitly refuse. R3 owns retained evidence/client cache integration, R5b
management, R5c reference journeys and R6 runtime qualification. Source identity
mapping/trust, retention support and adoption require independent source work.
Publication, real installations and activation remain owed.

The browser client/auth phase is implemented with a memory-only popup PKCE proof,
exact-source/origin/app callback checks and the existing signed Home token handoff.
Use `./module` only on the server for service/delegated credentials; the browser
profile accepts only app OAuth tokens. No automatic effect retry is implemented.
