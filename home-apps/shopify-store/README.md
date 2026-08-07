# Shopify — a custom Home app

One app covering the three store jobs: **Today** (orders, inventory), **Growth**
(the storefront funnel), and **New product** (create → image → price → publish).

Not a workspace package and not deployed — it is a static bundle, installed the
same way any other custom app is:

```bash
cd use-brian/home-apps/shopify-store && zip -r ../shopify-store.zip . -x '*.DS_Store'
# then Studio → Mini apps → Import bundle
```

It arrives at `needs_consent` like every other import; an owner or admin grants
the scopes before it renders.

## Why it asks for `data: read_write`

Only to attach product photos. `shopifyAddProductImage` takes a **workspace
file**, never raw bytes, so a picked image has to become one first — and the
only route across the bridge is `saveFileBytes`, a write tool gated on the brain
scope.

That is a real widening: `read_write` also reaches memories, tasks, CRM and
pages, which a store app has no business writing. It buys exactly one feature.
Drop it back to `read` if photo upload is not needed here; the form degrades to
"no photo attached" and says so rather than failing silently.

Widening it also **voids the existing grant** — the app drops to
`needs_consent` on re-import and an admin has to approve it again. That is the
drift rule working, not a bug.

## Why one app and not two

An earlier draft split read and write into separate apps. A manifest carries one
`scopes.store` tier, so splitting is the only way to run the dashboard at
least privilege — at the cost of two icons, two grants, and two things to
explain. One app at `write` is the shape the product wants; the containment that
matters is that **no tier reaches a destructive tool**, which holds either way.

Spec: `docs/architecture/features/home-apps.md` → "Store scope".
