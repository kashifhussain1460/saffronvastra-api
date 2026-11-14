# Etsy -> own storage image migration

Moves every product image that still points at Etsy (`i.etsystatic.com`) into our own storage (Vercel Blob, through the
existing `publishBuffer` in `src/common/storage.ts`) and re-points the SAME `ProductImage` row at the new address.
Row id, `sortOrder` and `isCover` never change, so gallery order and the primary image are preserved. A `MediaAsset` is
created for each file and linked through `mediaAssetId`. Images already in our storage are not touched.

Run from `D:\saff\backend` (the database in `backend/.env` is PRODUCTION):

    node node_modules/tsx/dist/cli.mjs scripts/image-migration/migrate.ts <command> [--limit N] [--only <slug>]

| Command | What it does | Writes |
|---|---|---|
| `inventory` | product-image-inventory.json (every product/image, source, duplicates) | files only |
| `download` | Etsy images -> `product-images/<slug>/image-NN.<ext>` + `manifest.json`. Retries with backoff, validates real image bytes, SHA-256. Resumes from the manifests; failed images are retried on the next run | files only |
| `verify` (`export`) | migration-summary.json, migration-failures.json, migration-report.csv and the upload gate (validated.json) | files only |
| `upload` | dry run by default. `--apply`: saves `backup-original.json` once, uploads, checks the new URL by checksum, then one DB transaction per product | Blob + DB |
| `verify-live` | re-reads the DB and every new URL: order, cover, media links, product/variant fields unchanged vs backup | files only |
| `status` | progress monitor (products, images, failures, percent) | none |
| `pause` / `resume` | creates / removes `_migration/PAUSE`; running commands stop after the current product | none |
| `rollback` | `--apply` restores the original URLs from `backup-original.json` (uploaded files stay in Blob) | DB |

NN is the image's position in the whole gallery, so a product whose photos 1-2 were already ours has its Etsy photo as
`image-03.jpg`. State and reports live in `product-images/_migration/` (`upload-state.json` = crash-recovery checkpoint,
`url-mapping.json` = old Etsy URL -> new URL, `migration-log.jsonl` = per-step log).

Blob keys are `uploads/products/<slug>/NN-<sha10>.<ext>` (deterministic, so a re-run after a crash reuses the file).
Each product gets its own copy, so removing an image from one product can never break another.

Note: the admin "Etsy import" (src/modules/etsy-import) stores the CSV's Etsy image URLs on the product as they are, which is
how these rows got there. Re-running it for new listings will put Etsy URLs back; run `inventory` afterwards and then
`download` / `verify` / `upload --apply` again (already migrated rows are skipped).
