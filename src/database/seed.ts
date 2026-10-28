import { prisma } from "./prisma.js";
import { hashPassword } from "../common/crypto.utils.js";

export async function runSeed() {
  console.log("===================================================================");
  console.log("   SEEDING SAFFRON THREADS PRODUCTION DATABASE                     ");
  console.log("===================================================================\n");

  // 1. Roles
  const adminRole = await prisma.role.upsert({
    where: { code: "ADMIN" },
    update: {},
    create: { code: "ADMIN", description: "Super Administrator / Studio Manager" },
  });

  const customerRole = await prisma.role.upsert({
    where: { code: "CUSTOMER" },
    update: {},
    create: { code: "CUSTOMER", description: "Clientele / Shopper" },
  });

  const staffRole = await prisma.role.upsert({
    where: { code: "ATELIER_STAFF" },
    update: {},
    create: { code: "ATELIER_STAFF", description: "Jaipur Atelier Master Artisan & Fulfillment Staff" },
  });

  console.log("✓ Roles seeded: ADMIN, CUSTOMER, ATELIER_STAFF");

  // 2. Admin User
  const adminPasswordHash = await hashPassword("SaffronAdmin2026!");
  const adminUser = await prisma.user.upsert({
    where: { email: "admin@saffronthreads.com" },
    update: { passwordHash: adminPasswordHash },
    create: {
      email: "admin@saffronthreads.com",
      passwordHash: adminPasswordHash,
      emailVerifiedAt: new Date(),
      status: "ACTIVE",
      profile: {
        create: {
          displayName: "Master Artisan Concierge",
          phone: "+91 98765 43210",
          tier: "Atelier VIP",
        },
      },
      userRoles: {
        create: [
          { roleId: adminRole.id },
          { roleId: customerRole.id },
        ],
      },
    },
  });

  // 3. Demo Customer User
  const customerPasswordHash = await hashPassword("RoyalAtelier2026!");
  const demoCustomer = await prisma.user.upsert({
    where: { email: "kashif.hussain@gmail.com" },
    update: { passwordHash: customerPasswordHash },
    create: {
      email: "kashif.hussain@gmail.com",
      passwordHash: customerPasswordHash,
      emailVerifiedAt: new Date(),
      status: "ACTIVE",
      profile: {
        create: {
          displayName: "Kashif Hussain",
          phone: "+91 98765 43210",
          tier: "Circle Member",
        },
      },
      userRoles: {
        create: [{ roleId: customerRole.id }],
      },
      addresses: {
        create: {
          fullName: "Kashif Hussain",
          phone: "+91 98765 43210",
          street: "123, Green Park Colony",
          apartment: "Villa 4B, Central Park",
          city: "Jaipur",
          state: "Rajasthan",
          pincode: "302001",
          country: "India",
          isDefault: true,
        },
      },
    },
  });

  console.log("✓ Users seeded: admin@saffronthreads.com, kashif.hussain@gmail.com");

  // 4. Categories (Matching Admin Dashboard Mockup)
  const categoryDefs = [
    {
      slug: "jackets",
      name: "Jackets",
      shortDescription: "Hand-embroidered luxury velvet and silk jackets tailored for modern silhouettes.",
      image: "/images/categories/jackets.jpg",
      sortOrder: 1,
    },
    {
      slug: "kimonos",
      name: "Kimonos",
      shortDescription: "Flowing artisanal robes and wrap jackets adorned with intricate heritage needlework.",
      image: "/images/products/beige_kimono.jpg",
      sortOrder: 2,
    },
    {
      slug: "co-ord-sets",
      name: "Co-ord Sets",
      shortDescription: "Harmonious two-piece ensembles blending contemporary cuts with traditional embroidery.",
      image: "/images/products/olive_coord.jpg",
      sortOrder: 3,
    },
    {
      slug: "tops",
      name: "Tops",
      shortDescription: "Delicate embroidered tops and blouses designed for versatile luxury layering.",
      image: "/images/products/beige_inner_top.jpg",
      sortOrder: 4,
    },
    {
      slug: "new-arrivals",
      name: "New Arrivals",
      shortDescription: "The latest handcrafted releases from our Jaipur ateliers.",
      image: "/images/products/rust_jacket.jpg",
      sortOrder: 5,
    },
    {
      slug: "best-sellers",
      name: "Best Sellers",
      shortDescription: "Our most coveted heritage silhouettes, cherished by clientele worldwide.",
      image: "/images/products/black_kimono.jpg",
      sortOrder: 6,
    },
    {
      slug: "autumn-edit",
      name: "Autumn Edit",
      shortDescription: "Warm terracotta and olive tones for evening receptions and celebratory soirees.",
      image: "/images/products/sage_jacket.jpg",
      sortOrder: 7,
    },
  ];

  const categoryMap = new Map<string, string>();
  for (const cat of categoryDefs) {
    const record = await prisma.category.upsert({
      where: { slug: cat.slug },
      update: {
        name: cat.name,
        shortDescription: cat.shortDescription,
        image: cat.image,
        sortOrder: cat.sortOrder,
      },
      create: {
        slug: cat.slug,
        name: cat.name,
        shortDescription: cat.shortDescription,
        image: cat.image,
        sortOrder: cat.sortOrder,
        status: "Active",
      },
    });
    categoryMap.set(cat.slug, record.id);
  }
  console.log(`✓ Categories seeded: ${categoryDefs.length} categories`);

  // 5. Collections
  const collectionDefs = [
    {
      slug: "velvet-jackets",
      title: "The Velvet Edit",
      tagline: "Regal Heritage Velvet Crafted for Modern Evenings",
      description: "An exclusive capsule celebrating rich velvet textures, metallic zari zardozi needlework, and structured tailoring.",
      bannerImage: "/images/hero/velvet_hero.jpg",
      sortOrder: 1,
    },
    {
      slug: "timeless-kimonos",
      title: "Timeless Kimonos",
      tagline: "Bespoke Draping with Royal Jaipur Embroidery",
      description: "Fluid lines meeting age-old Rajasthani motifs, tailored in hand-loomed silk and lightweight velvet blends.",
      bannerImage: "/images/hero/kimono_hero.jpg",
      sortOrder: 2,
    },
    {
      slug: "autumn-edit",
      title: "Autumn Winter Atelier",
      tagline: "Earthy Palettes and Gilded Accents",
      description: "Sophisticated autumnal shades of deep saffron, rust, sage, and forest emerald designed for celebratory layered warmth.",
      bannerImage: "/images/hero/autumn_hero.jpg",
      sortOrder: 3,
    },
  ];

  const collectionMap = new Map<string, string>();
  for (const col of collectionDefs) {
    const record = await prisma.collection.upsert({
      where: { slug: col.slug },
      update: {
        title: col.title,
        tagline: col.tagline,
        description: col.description,
        bannerImage: col.bannerImage,
      },
      create: {
        slug: col.slug,
        title: col.title,
        tagline: col.tagline,
        description: col.description,
        bannerImage: col.bannerImage,
        sortOrder: col.sortOrder,
        status: "Active",
      },
    });
    collectionMap.set(col.slug, record.id);
  }
  console.log(`✓ Collections seeded: ${collectionDefs.length} collections`);

  // 6. Products (All 8 Authentic Saffron Threads items)
  const productDefs = [
    {
      slug: "maroon-velvet-embroidered-jacket",
      title: "Maroon Velvet Embroidered Jacket",
      description: "A timeless jacket crafted in rich velvet, adorned with intricate hand embroidery. Designed for modern living with a touch of heritage. Features deep metallic zari and silk thread work inspired by royal Mughal botanical motifs.",
      material: "Premium heavyweight velvet",
      embroidery: "Zari & Resham Floral Threadwork",
      basePriceMinor: 1149900, // ₹11,499
      comparePriceMinor: 1299900, // ₹12,999
      leadTimeDays: 7,
      availabilityMode: "Made to Order",
      categorySlug: "jackets",
      collectionSlugs: ["velvet-jackets", "autumn-edit"],
      isFeatured: true,
      isBestseller: true,
      rating: 4.9,
      reviewsCount: 128,
      images: [
        { url: "/images/products/maroon_jacket.jpg", isCover: true, alt: "Maroon Velvet Embroidered Jacket front view" },
        { url: "/images/products/pink_velvet_jacket.jpg", isCover: false, alt: "Maroon Velvet side angle" },
        { url: "/images/products/ivory_jacket.jpg", isCover: false, alt: "Maroon Velvet detail embroidery" },
      ],
      colors: [
        { name: "Maroon", hex: "#6B1F1F" },
        { name: "Ivory", hex: "#F5EFE6" },
        { name: "Beige", hex: "#D9B89B" },
      ],
      sizes: ["S", "M", "L", "XL"],
    },
    {
      slug: "pink-velvet-embroidered-jacket",
      title: "Pink Velvet Embroidered Jacket",
      description: "Indulge in soft femininity with this blush rose velvet jacket. Decorated with masterfully embroidered blossoms that bring artisanal romance into modern daytime and evening ensembles.",
      material: "Luxe velvet with delicate sheen",
      embroidery: "Pastel Botanical Threadwork",
      basePriceMinor: 1099900, // ₹10,999
      comparePriceMinor: 1249900,
      leadTimeDays: 7,
      availabilityMode: "Made to Order",
      categorySlug: "jackets",
      collectionSlugs: ["velvet-jackets"],
      isFeatured: true,
      isNewArrival: true,
      rating: 4.8,
      reviewsCount: 94,
      images: [
        { url: "/images/products/pink_velvet_jacket.jpg", isCover: true, alt: "Pink Velvet Jacket front view" },
        { url: "/images/products/maroon_jacket.jpg", isCover: false, alt: "Pink Velvet angle view" },
      ],
      colors: [
        { name: "Blush Pink", hex: "#E8A598" },
        { name: "Rosewood", hex: "#9E4A56" },
      ],
      sizes: ["S", "M", "L", "XL"],
    },
    {
      slug: "black-embroidered-kimono",
      title: "Black Embroidered Kimono",
      description: "Striking black kimono-style wrap jacket displaying gilded zardozi borders and delicate vine motifs. Drapes effortlessly over tailored trousers or evening slips.",
      material: "Hand-spun silk & velvet blend",
      embroidery: "Golden Zardozi Needlework",
      basePriceMinor: 999900, // ₹9,999
      comparePriceMinor: 1149900,
      leadTimeDays: 7,
      availabilityMode: "Available to Order",
      categorySlug: "kimonos",
      collectionSlugs: ["timeless-kimonos"],
      isFeatured: true,
      isBestseller: true,
      rating: 5.0,
      reviewsCount: 86,
      images: [
        { url: "/images/products/black_kimono.jpg", isCover: true, alt: "Black Embroidered Kimono" },
      ],
      colors: [
        { name: "Midnight Black", hex: "#1A1A1A" },
        { name: "Gilded Gold", hex: "#D4AF37" },
      ],
      sizes: ["Free Size", "S", "M", "L"],
    },
    {
      slug: "ivory-handwork-jacket",
      title: "Ivory Handwork Jacket",
      description: "An angelic ivory piece featuring pristine tonal embroidery and subtle pearl beading. An exquisite choice for daytime wedding rituals and milestone gatherings.",
      material: "Raw silk & organza accents",
      embroidery: "Tonal Chikankari & Pearl Work",
      basePriceMinor: 1049900, // ₹10,499
      comparePriceMinor: 1199900,
      leadTimeDays: 7,
      availabilityMode: "Available to Order",
      categorySlug: "jackets",
      collectionSlugs: ["velvet-jackets", "autumn-edit"],
      isFeatured: false,
      isNewArrival: true,
      rating: 4.7,
      reviewsCount: 62,
      images: [
        { url: "/images/products/ivory_jacket.jpg", isCover: true, alt: "Ivory Handwork Jacket" },
      ],
      colors: [
        { name: "Ivory White", hex: "#FDFBF7" },
        { name: "Champagne", hex: "#F7E7CE" },
      ],
      sizes: ["XS", "S", "M", "L", "XL"],
    },
    {
      slug: "sage-embroidered-jacket",
      title: "Sage Green Embroidered Jacket",
      description: "Calming sage green velvet enveloped in vintage silver gota patti and thread embroidery, inspired by the palace courtyards of the Pink City.",
      material: "Heritage micro-velvet",
      embroidery: "Silver Gota Patti & Dabka",
      basePriceMinor: 1099900,
      comparePriceMinor: 1249900,
      leadTimeDays: 7,
      availabilityMode: "Made to Order",
      categorySlug: "jackets",
      collectionSlugs: ["autumn-edit"],
      isFeatured: false,
      isBestseller: false,
      rating: 4.8,
      reviewsCount: 45,
      images: [
        { url: "/images/products/sage_jacket.jpg", isCover: true, alt: "Sage Green Embroidered Jacket" },
      ],
      colors: [
        { name: "Sage Green", hex: "#8A9A86" },
        { name: "Forest Olive", hex: "#3B4D3C" },
      ],
      sizes: ["S", "M", "L", "XL"],
    },
    {
      slug: "olive-embroidered-co-ord-set",
      title: "Olive Embroidered Co-ord Set",
      description: "A synchronized two-piece set featuring tailored high-waist cigarette pants paired with a relaxed embroidered lapel blazer in rich olive green.",
      material: "Italian linen-cotton blend",
      embroidery: "Minimalist Border Aari Work",
      basePriceMinor: 1299900,
      comparePriceMinor: 1449900,
      leadTimeDays: 7,
      availabilityMode: "Made to Order",
      categorySlug: "co-ord-sets",
      collectionSlugs: ["autumn-edit"],
      isFeatured: true,
      isBestseller: true,
      rating: 4.9,
      reviewsCount: 71,
      images: [
        { url: "/images/products/olive_coord.jpg", isCover: true, alt: "Olive Embroidered Co-ord Set" },
      ],
      colors: [
        { name: "Olive", hex: "#4A5D4E" },
      ],
      sizes: ["XS", "S", "M", "L", "XL"],
    },
    {
      slug: "beige-embroidered-kimono",
      title: "Beige Handwoven Kimono",
      description: "Warm neutral beige silk with earthen terracotta embroidery. Lightweight, breathable, and gracefully versatile across seasons.",
      material: "Hand-spun Tussar Silk",
      embroidery: "Earthen Resham Stitching",
      basePriceMinor: 949900,
      comparePriceMinor: 1099900,
      leadTimeDays: 7,
      availabilityMode: "Available to Order",
      categorySlug: "kimonos",
      collectionSlugs: ["timeless-kimonos"],
      isFeatured: false,
      isNewArrival: false,
      rating: 4.7,
      reviewsCount: 39,
      images: [
        { url: "/images/products/beige_kimono.jpg", isCover: true, alt: "Beige Handwoven Kimono" },
      ],
      colors: [
        { name: "Warm Beige", hex: "#D8C7B5" },
        { name: "Terracotta", hex: "#C45724" },
      ],
      sizes: ["Free Size", "S", "M", "L"],
    },
    {
      slug: "rust-velvet-festive-jacket",
      title: "Rust Velvet Festive Jacket",
      description: "A regal burnt rust velvet statement silhouette with dense zardozi cuffs and royal crest button closures.",
      material: "Heavy Silk Velvet",
      embroidery: "Royal Crest Zardozi",
      basePriceMinor: 1199900,
      comparePriceMinor: 1349900,
      leadTimeDays: 7,
      availabilityMode: "Made to Order",
      categorySlug: "jackets",
      collectionSlugs: ["velvet-jackets", "autumn-edit"],
      isFeatured: true,
      isBestseller: false,
      rating: 5.0,
      reviewsCount: 53,
      images: [
        { url: "/images/products/rust_jacket.jpg", isCover: true, alt: "Rust Velvet Festive Jacket" },
      ],
      colors: [
        { name: "Rust", hex: "#B8542E" },
        { name: "Deep Saffron", hex: "#C45724" },
      ],
      sizes: ["S", "M", "L", "XL"],
    },
  ];

  for (const p of productDefs) {
    const categoryId = categoryMap.get(p.categorySlug) || categoryMap.get("jackets")!;

    const product = await prisma.product.upsert({
      where: { slug: p.slug },
      update: {
        title: p.title,
        description: p.description,
        material: p.material,
        embroidery: p.embroidery,
        basePriceMinor: p.basePriceMinor,
        comparePriceMinor: p.comparePriceMinor,
        availabilityMode: p.availabilityMode,
        leadTimeDays: p.leadTimeDays,
        isFeatured: p.isFeatured,
        isBestseller: p.isBestseller,
        isNewArrival: p.isNewArrival || false,
        rating: p.rating,
        reviewsCount: p.reviewsCount,
        categoryId,
      },
      create: {
        slug: p.slug,
        title: p.title,
        description: p.description,
        material: p.material,
        embroidery: p.embroidery,
        basePriceMinor: p.basePriceMinor,
        comparePriceMinor: p.comparePriceMinor,
        currency: "INR",
        availabilityMode: p.availabilityMode,
        leadTimeDays: p.leadTimeDays,
        status: "Active",
        isFeatured: p.isFeatured,
        isBestseller: p.isBestseller,
        isNewArrival: p.isNewArrival || false,
        rating: p.rating,
        reviewsCount: p.reviewsCount,
        categoryId,
      },
    });

    // Seed Images
    for (let i = 0; i < p.images.length; i++) {
      const img = p.images[i];
      const existingImg = await prisma.productImage.findFirst({
        where: { productId: product.id, url: img.url },
      });

      if (!existingImg) {
        await prisma.productImage.create({
          data: {
            productId: product.id,
            url: img.url,
            altText: img.alt,
            isCover: img.isCover,
            sortOrder: i,
          },
        });
      }
    }

    // Seed Variants (Combinations of size and color)
    for (const color of p.colors) {
      for (const size of p.sizes) {
        const sku = `ST-${p.slug.slice(0, 3).toUpperCase()}-${color.name.slice(0, 2).toUpperCase()}-${size}`;
        await prisma.productVariant.upsert({
          where: { sku },
          update: {
            priceOverrideMinor: null,
          },
          create: {
            productId: product.id,
            sku,
            size,
            colourName: color.name,
            colourHex: color.hex,
            status: "Active",
          },
        });
      }
    }

    // Link Collections
    for (const colSlug of p.collectionSlugs) {
      const colId = collectionMap.get(colSlug);
      if (colId) {
        await prisma.collectionProduct.upsert({
          where: {
            collectionId_productId: {
              collectionId: colId,
              productId: product.id,
            },
          },
          update: {},
          create: {
            collectionId: colId,
            productId: product.id,
          },
        });
      }
    }
  }
  console.log(`✓ Products & Variants seeded: ${productDefs.length} products`);

  // 7. Media Assets (Matching Central Media Library)
  const mediaAssetDefs = [
    { name: "maroon_jacket_cover.jpg", url: "/images/products/maroon_jacket.jpg", folder: "Product Images", bytes: 2450000, width: 2400, height: 3200, alt: "Maroon Velvet Embroidered Jacket Studio Cover" },
    { name: "pink_velvet_angle.jpg", url: "/images/products/pink_velvet_jacket.jpg", folder: "Product Images", bytes: 1980000, width: 2400, height: 3200, alt: "Pink Velvet Jacket Editorial Shoot" },
    { name: "black_kimono_hero.jpg", url: "/images/products/black_kimono.jpg", folder: "Product Images", bytes: 2800000, width: 2400, height: 3200, alt: "Black Embroidered Kimono Luxury Drapery" },
    { name: "ivory_jacket_detail.jpg", url: "/images/products/ivory_jacket.jpg", folder: "Product Images", bytes: 1850000, width: 2400, height: 3200, alt: "Ivory Handwork Jacket Raw Silk" },
    { name: "sage_jacket_flatlay.jpg", url: "/images/products/sage_jacket.jpg", folder: "Product Images", bytes: 2150000, width: 2400, height: 3200, alt: "Sage Green Embroidered Jacket Detail" },
    { name: "olive_coord_model.jpg", url: "/images/products/olive_coord.jpg", folder: "Product Images", bytes: 3100000, width: 2400, height: 3200, alt: "Olive Co-ord Set Two Piece Ensemble" },
    { name: "beige_kimono_outdoor.jpg", url: "/images/products/beige_kimono.jpg", folder: "Product Images", bytes: 2200000, width: 2400, height: 3200, alt: "Beige Handwoven Kimono Tussar Silk" },
    { name: "rust_jacket_portrait.jpg", url: "/images/products/rust_jacket.jpg", folder: "Product Images", bytes: 2650000, width: 2400, height: 3200, alt: "Rust Velvet Festive Jacket Zardozi" },
    { name: "banner_velvet_heritage.jpg", url: "/images/hero/hero_model.jpg", folder: "Banner Images", bytes: 4200000, width: 3840, height: 2160, alt: "Atelier Hero Campaign Banner" },
    { name: "artisan_jaipur_loom.jpg", url: "/images/editorial/artisan_embroidery.jpg", folder: "Editorial", bytes: 3400000, width: 2800, height: 2100, alt: "Jaipur Master Artisan Loom Handwork" },
  ];

  for (const m of mediaAssetDefs) {
    const storageKey = `assets/${m.name}`;
    await prisma.mediaAsset.upsert({
      where: { storageKey },
      update: {
        name: m.name,
        url: m.url,
        folder: m.folder,
        altText: m.alt,
      },
      create: {
        storageKey,
        name: m.name,
        url: m.url,
        mimeType: "image/jpeg",
        bytes: m.bytes,
        width: m.width,
        height: m.height,
        folder: m.folder,
        altText: m.alt,
      },
    });
  }
  console.log(`✓ Media Assets seeded: ${mediaAssetDefs.length} assets`);

  // 8. Coupons (Matching Frontend Promo Codes)
  const couponDefs = [
    {
      code: "SAFFRON10",
      type: "PERCENTAGE",
      value: 1000, // 10%
      status: "Active",
      maxRedemptions: 500,
    },
    {
      code: "HERITAGE15",
      type: "PERCENTAGE",
      value: 1500, // 15%
      status: "Active",
      maxRedemptions: 200,
    },
    {
      code: "WELCOME5",
      type: "PERCENTAGE",
      value: 500, // 5%
      status: "Active",
      maxRedemptions: 1000,
    },
    {
      code: "FESTIVE",
      type: "FIXED_AMOUNT",
      value: 100000, // ₹1,000 in minor units (paise)
      status: "Active",
      maxRedemptions: 300,
    },
  ];

  for (const c of couponDefs) {
    await prisma.coupon.upsert({
      where: { code: c.code },
      update: {
        type: c.type,
        value: c.value,
        status: c.status,
        maxRedemptions: c.maxRedemptions,
      },
      create: {
        code: c.code,
        type: c.type,
        value: c.value,
        status: c.status,
        maxRedemptions: c.maxRedemptions,
      },
    });
  }
  console.log(`✓ Coupons seeded: ${couponDefs.length} promo coupons`);

  // 9. Initial Orders (Matching Admin Dashboard Mockups #ST10234, #ST10233)
  const existingOrder = await prisma.order.findUnique({
    where: { orderNumber: "ST10234" },
  });

  if (!existingOrder) {
    // Order 1: #ST10234 (Processing)
    await prisma.order.create({
      data: {
        orderNumber: "ST10234",
        userId: demoCustomer.id,
        status: "Processing",
        paymentStatus: "Paid",
        currency: "INR",
        subtotalMinor: 2199800,
        shippingMinor: 0,
        taxMinor: 0,
        discountMinor: 0,
        totalMinor: 2199800,
        shippingAddress: {
          fullName: "Ayesha Khan",
          phone: "+91 98765 43210",
          street: "123, Green Park Colony",
          apartment: "Villa 4B",
          city: "Jaipur",
          state: "Rajasthan",
          pincode: "302001",
          country: "India",
        },
        billingAddress: {
          fullName: "Ayesha Khan",
          phone: "+91 98765 43210",
          street: "123, Green Park Colony",
          apartment: "Villa 4B",
          city: "Jaipur",
          state: "Rajasthan",
          pincode: "302001",
          country: "India",
        },
        paymentMethod: {
          provider: "UPI",
          upiId: "ayesha@okhdfcbank",
          transactionId: "UPI-9821749812",
        },
        bespokeNotes: "Custom sleeve length +1 inch for winter wear.",
        items: {
          create: [
            {
              productTitle: "Maroon Velvet Embroidered Jacket",
              productSlug: "maroon-velvet-embroidered-jacket",
              productImage: "/images/products/maroon_jacket.jpg",
              sku: "ST-MVJ-001-M-MAR",
              size: "M",
              colour: "Maroon",
              quantity: 1,
              unitPriceMinor: 1149900,
              taxMinor: 0,
              lineTotalMinor: 1149900,
            },
            {
              productTitle: "Olive Co-ord Set",
              productSlug: "olive-coord-set",
              productImage: "/images/products/olive_coord.jpg",
              sku: "ST-OCS-006-S-OLI",
              size: "S",
              colour: "Olive",
              quantity: 1,
              unitPriceMinor: 1049900,
              taxMinor: 0,
              lineTotalMinor: 1049900,
            },
          ],
        },
        payments: {
          create: {
            provider: "UPI",
            providerReference: "UPI-9821749812",
            amountMinor: 2199800,
            currency: "INR",
            status: "SUCCESS",
          },
        },
        statusHistory: {
          create: [
            {
              oldStatus: null,
              newStatus: "Processing",
              actorUserId: adminUser.id,
              note: "Artisan production initiated at Jaipur Atelier.",
            },
          ],
        },
      },
    });

    // Order 2: #ST10233 (Shipped)
    await prisma.order.create({
      data: {
        orderNumber: "ST10233",
        status: "Shipped",
        paymentStatus: "Paid",
        currency: "INR",
        subtotalMinor: 1049900,
        shippingMinor: 0,
        taxMinor: 0,
        discountMinor: 0,
        totalMinor: 1049900,
        shippingAddress: {
          fullName: "Priya Sharma",
          phone: "+91 98123 45678",
          street: "45, Civil Lines",
          city: "Jaipur",
          state: "Rajasthan",
          pincode: "302006",
          country: "India",
        },
        paymentMethod: {
          provider: "CARD",
          cardLast4: "4242",
          transactionId: "TXN-88231920",
        },
        items: {
          create: [
            {
              productTitle: "Pink Velvet Embroidered Jacket",
              productSlug: "pink-velvet-embroidered-jacket",
              productImage: "/images/products/pink_velvet_jacket.jpg",
              sku: "ST-PVJ-002-S-PIN",
              size: "S",
              colour: "Pink",
              quantity: 1,
              unitPriceMinor: 1049900,
              taxMinor: 0,
              lineTotalMinor: 1049900,
            },
          ],
        },
        payments: {
          create: {
            provider: "CARD",
            providerReference: "TXN-88231920",
            amountMinor: 1049900,
            currency: "INR",
            status: "SUCCESS",
          },
        },
        shipments: {
          create: {
            carrier: "Bluedart",
            trackingNumber: "BD98274192",
            trackingUrl: "https://www.bluedart.com/tracking?track=BD98274192",
            status: "In Transit",
            shippedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
          },
        },
        statusHistory: {
          create: [
            {
              oldStatus: "Processing",
              newStatus: "Shipped",
              actorUserId: adminUser.id,
              note: "Dispatched via Bluedart air express.",
            },
          ],
        },
      },
    });

    console.log("✓ Initial Orders seeded: #ST10234, #ST10233");
  }

  console.log("\n===================================================================");
  console.log("   DATABASE SEED COMPLETED SUCCESSFULLY!                           ");
  console.log("===================================================================\n");
}

if (process.argv[1]?.endsWith("seed.ts") || process.argv[1]?.endsWith("seed.js")) {
  runSeed()
    .then(async () => {
      await prisma.$disconnect();
      process.exit(0);
    })
    .catch(async (e) => {
      console.error("Seed failed:", e);
      await prisma.$disconnect();
      process.exit(1);
    });
}
