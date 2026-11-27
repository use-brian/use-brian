# Adding another CLI connector

In Studio > Connectors, use **Add another** on the connected CLI row or its
Browse Directory card. Both entry points open a blank CLI setup draft in the
selected connector's detail panel, closing the directory and revealing the
panel on phones. Existing connector settings use a separate draft.

Enter a label, an absolute executable path, and optional arguments and working
directory. Saving calls `POST /api/connectors/cli/connect`, which probes MCP
stdio and creates a fresh personal connector instance. It does not update the
selected connector. Probe or network failures leave the draft available with
an error so it can be retried.

Do not send CLI **Add another** to `/api/connectors/directory/cli/add`: directory
installation is idempotent and returns the existing installation. The directory
uses `resolveConnectorAddAnotherFlow` to hand inline setup and OAuth entries
back to the page; remote directory entries retain their directory-add path.
GitHub add-another uses its dedicated new-account PAT draft, not the primary
account's credential editor. OAuth retains its add-another and workspace-app
options.

Regression coverage: `browse-directory-connect.test.tsx` exercises directory
button handoff and remote fallback; `cli-connector-form-state.test.ts` pins
form visibility, blank creation drafts, and separation from existing settings.
