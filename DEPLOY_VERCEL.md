# Deploying the API on Vercel

The API is an Express app. `src/index.ts` exports it (`export default app`) and Vercel runs it as one function. Nothing
here has been run on Vercel itself yet: it was checked locally (build, loading the compiled app the way Vercel does, the
cron route, uploads and the test suites that touch them). Do the first deploy as a Preview and run the checks at the end.

## 1. Before you start

| Need | Why |
|---|---|
| Hosted Postgres with a **pooled** connection address (Neon, Supabase, Vercel Postgres) | A serverless function opens many short connections; a direct address runs out |
| A Vercel Blob store (Dashboard > Storage > Blob) connected to this project | Vercel's disk does not persist, so uploaded images cannot live on it |
| Vercel plan | **Hobby is for personal, non-commercial use** (Vercel's terms) and allows cron only once a day. A live shop should be on Pro |

## 2. Create the project

1. Vercel > Add New > Project > import the `saffronvastra-api` repo. Framework preset: Express (detected). Node.js 22.
2. Environment variables (Project Settings > Environment Variables). Names only; never put values in the repo.

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `APP_DATABASE_URL` | the Postgres connection string. With the Prisma Postgres integration Vercel adds it with exactly this name. The integration also adds `APP_POSTGRES_URL` and `APP_PRISMA_DATABASE_URL`; on this project all three hold the same address, this app reads only `APP_DATABASE_URL`. If "too many connections" errors appear, add `&connection_limit=1` |
| `COOKIE_SECRET` | long random string (the API refuses to start in production without it) |
| `CORS_ORIGIN` | storefront address, e.g. `https://www.saffronvastra.com` |
| `APP_URL` | the same storefront address (used in email links) |
| `TRUST_PROXY` | `2` to start with (the storefront forwards `/api` to this project, so a request crosses Vercel twice) |
| `CRON_SECRET` | random string, 16+ characters. Vercel sends it to the cron route |
| `BLOB_READ_WRITE_TOKEN` | added automatically when the Blob store is connected |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM_NAME`, `SMTP_FROM_EMAIL`, `ADMIN_NOTIFY_EMAIL` | as in `.env.example` |
| `CASHFREE_ENV` (`sandbox` first, then `production`), `CASHFREE_APP_ID`, `CASHFREE_SECRET_KEY`, `PUBLIC_API_URL` | `PUBLIC_API_URL` = this project's public https address |

Do **not** set `CASHFREE_BASE_URL_OVERRIDE` (the API refuses to start in production if it is set).

## 3. Database

Migrations are applied by hand, not on every deploy (preview deployments would otherwise change the shared database).
Run from your machine or CI, with the **direct** (non-pooled) address:

```
APP_DATABASE_URL="<direct connection string>" npx prisma migrate deploy
```

An empty database gets the baseline and both payment migrations. A database created earlier with `db push` needs
`npx prisma migrate resolve --applied 0_baseline` first. Take a backup before running it on real data.

## 4. Scheduled work (cron)

`vercel.json` defines one job: `GET /api/v1/internal/cron/reconcile`. It confirms open online payments and refunds with
Cashfree when a webhook was missed, and cancels online orders left unpaid for 24 hours (returning the promo code use).

- On **Hobby** it runs **once a day** (`0 3 * * *`, UTC) and Vercel may start it anywhere inside that hour.
- On **Pro** change the schedule to `*/10 * * * *` in `vercel.json` and redeploy.
- The route needs `Authorization: Bearer <CRON_SECRET>`; without it the answer is 401. Cron runs only on the Production deployment.
- It is safe to run twice or to be missed. Customers are also covered without the cron: the order page checks the payment
  when it opens, and Cashfree's webhook confirms it.
- Admin can run the same job from the orders page ("check now").

## 5. Cashfree

Register `https://<this-project>/api/v1/payments/cashfree/webhook` in the Cashfree dashboard (Developers > Webhooks) for
payment and refund events. Test the sandbox first.

## 6. What behaves differently on Vercel

- **Emails, notifications and audit lines** that used to run "in the background" are handed to Vercel's `waitUntil`, so they finish after the response is sent.
- **Uploads** go to Blob. A single request body is limited to **4.5 MB** on Vercel, so images above 4 MB are refused (the limit is 15 MB on a normal server). Large originals must be shrunk before upload.
- **Rate limits are kept in memory**, so each function instance counts separately. They still slow abuse but are not exact. For login and checkout protection also turn on Vercel Firewall rate limiting.
- **Visitor address**: if every request shows the same address in the audit log, adjust `TRUST_PROXY`.
- No `setInterval` timers run (the 10-minute payment check is replaced by the cron above).

## 7. Checks after the first Preview deploy

1. `GET /health/live` and `/health/ready` answer 200.
2. Sign in as admin through the storefront; upload an image in Admin > Media and confirm its address starts with `https://...public.blob.vercel-storage.com`.
3. Place a COD order: confirmation email arrives (proves `waitUntil` works).
4. Sandbox online payment: order becomes Paid and Processing, one confirmation email.
5. Call the cron route with and without the secret: 200 and 401.

## 8. Adding images by hand to the Blob store (bulk), then linking them in the admin

1. Vercel dashboard > Storage > the **public** Blob store > upload files into these folders (lowercase, no spaces). The folder or file name is the item's **slug**:

```
uploads/products/<product-slug>/01.webp, 02.webp ...   the first file in name order is the cover
uploads/categories/<category-slug>.webp
uploads/collections/<collection-slug>.webp             also set as the collection banner
uploads/banners/<any-name>.webp                        library only
```

   Shrink images first (about 2000 px wide, WebP, 200 to 500 KB). If the dashboard has no folder option, type the path in the file name, e.g. `products/velvet-jacket-maroon/01.webp` under `uploads/`.
2. Admin > Media > **Import from Blob**. Each file is checked by its real type, added to the library (folder Product Images, Category Images, Collection Images or Banner Images) and linked to the product, category or collection with the same slug.
3. The report lists what was not linked (no item with that slug, or a category/collection that already has an image, which is left unchanged) and what could not be imported (not an image, over 25 MB).
4. It is safe to run again whenever new files are added. A product created after its images were uploaded gets them on the next import.
5. Files outside these four folders (the ones the admin uploads itself, customer return photos) are never touched.
6. Tests: `npm test` (path rules) and `npm run test:db` (import with a fake Blob store, needs the local database).
