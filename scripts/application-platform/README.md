# Reference host client preconditions

Purchasing browser and reconciliation clients require the fixed explicit OSS
reference host, existing current authentication and reviewed app configuration:

```sh
scripts/rig-up.sh --admin-only --reference-applications
```

Normal OSS and hosted boot omit purchasing while retaining canonical `native`
and `records`. To change a running owned administrative composition, first use
`scripts/rig-down.sh --admin-only --keep-db`; never redeploy, reconfigure or
reseed merely to switch hosts. Preserve original app/schema/binding, credential,
resource and receipt identities. Runtime selection grants no authority.

See the [reference deployment contract](../../examples/application-platform/README.md).
Administrative mode has no providers/workers and does not qualify background
source workflows. Canonical CRM `native` operations do not require purchasing.
Actual maintained-rig/browser continuity and review of the browser-client assets
remain separate acceptance gates. The historical campaign collector is not part
of this host composition or its verification.
