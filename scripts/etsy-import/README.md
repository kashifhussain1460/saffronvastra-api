# Etsy listing import

Source: `D:\saff\EtsyListingsDownload (1).csv` (45 listings, 232 images). Run everything from `D:\saff\backend`.

1. `node scripts/etsy-import/download-images.cjs` saves every image to `D:\saff\product-images\<slug>\NN-<slug>.jpg`
   (NN = position, 01 is the cover) and writes `manifest.json` and `INDEX.csv` (title, folder, image count) next to them.
2. `node scripts/etsy-import/import-products.cjs` is a dry run (prints title, meta title, meta description, colour, sizes, price, image and tag counts).
   `node scripts/etsy-import/import-products.cjs apply` creates the products and is safe to repeat (existing slugs are skipped).

What an imported product gets
- Status **Draft**, category Jackets, brand Saffron Threads, type Jacket, price in rupees from the CSV.
- Meta title (60 characters or fewer, ends with `| Saffron Threads`) from the lead of the title; meta description (155 or fewer) from the opening sentences of the description.
- The Etsy tags (underscores turned into spaces) are stored as the product's focus keywords.
- One variant per size (S, M, L, XL) with SKU `SJ-<number>-<size>`; colour is the first colour named in the title.
- Images are copied to `backend/public/uploads/<slug>-NN.jpg`, registered in the Media Library (folder Product Images, alt text "<title lead> - photo N") and attached in order, first image as cover.

Not imported: quantity (the shop has no stock counts), the Etsy "Has lining" option (only sizes are kept).
