# Explicit reference applications

Normal OSS and hosted boot omit purchasing. Canonical `native` and `records`
remain available. The fixed administrative reference composition uses the shipped
[purchasing factory](../../packages/api/src/application-platform/purchasing/host.ts)
and its existing canonical runtime; it grants no data authority.

From the OSS root, after the existing reviewed deployment, schema, role,
configuration and activation setup:

```sh
scripts/rig-up.sh --admin-only --reference-applications
```

The deployment assets are [operations/deploy.sql](operations/deploy.sql). Apply
that versioned setup through the installation process once. Switching host mode
does not rerun deployment SQL, configuration, role assignment, binding or seeding.
Keep existing application, schema, binding, credential and receipt identities.
Unconfigured or currently unauthorized workspaces continue to refuse.

To switch a running owned administrative rig, first stop it with data retained:

```sh
scripts/rig-down.sh --admin-only --keep-db
scripts/rig-up.sh --admin-only
```

Use the reference flag again to restore the same factory. A normal/reference or
unmarked/stale runtime receipt refuses warm reuse. Missing reference handlers
return typed unavailable-operation errors and never enable a generic writer
for semantic-owned records. Administrative mode starts no paid providers or
workers. Synthetic fixture host swaps are not maintained-rig/browser proof;
that continuity rehearsal and browser-client adoption remain separate gates.
