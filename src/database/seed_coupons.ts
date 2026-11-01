import { prisma } from "./prisma.js";

export const COUPONS_SEED_DATA = [
  // 1. Universal Coupons (Applicable for both Guest and Authenticated users)
  {
    code: "SAFFRON10",
    type: "PERCENTAGE",
    value: 1000, // 10%
    description: "10% off on all made-to-order collections",
    minSubtotalMinor: 300000, // Min ₹3,000
    status: "Active",
    maxRedemptions: 1000,
  },
  {
    code: "WELCOME5",
    type: "PERCENTAGE",
    value: 500, // 5%
    description: "5% welcome discount for all new visitors and guests",
    minSubtotalMinor: 0,
    status: "Active",
    maxRedemptions: 2000,
  },
  {
    code: "FESTIVE",
    type: "FIXED_AMOUNT",
    value: 100000, // Flat ₹1,000
    description: "Flat ₹1,000 off on festive orders above ₹6,000",
    minSubtotalMinor: 600000, // Min ₹6,000
    status: "Active",
    maxRedemptions: 500,
  },
  {
    code: "HERITAGE15",
    type: "PERCENTAGE",
    value: 1500, // 15%
    description: "15% off on royal heritage collections",
    minSubtotalMinor: 500000, // Min ₹5,000
    status: "Active",
    maxRedemptions: 500,
  },

  // 2. Product-Based Coupons (Targeted at specific product categories)
  {
    code: "SUZANI20",
    type: "PERCENTAGE",
    value: 2000, // 20%
    description: "20% off on Suzani Embroidered Jackets & Kimonos [product:suzani]",
    minSubtotalMinor: 400000, // Min ₹4,000
    status: "Active",
    maxRedemptions: 500,
  },
  {
    code: "JACKET10",
    type: "PERCENTAGE",
    value: 1000, // 10%
    description: "10% off on all Handcrafted Jackets [product:jacket]",
    minSubtotalMinor: 350000, // Min ₹3,500
    status: "Active",
    maxRedemptions: 500,
  },
  {
    code: "KIMONO15",
    type: "PERCENTAGE",
    value: 1500, // 15%
    description: "15% off on all Kimonos & Dusters [product:kimono]",
    minSubtotalMinor: 400000, // Min ₹4,000
    status: "Active",
    maxRedemptions: 500,
  },

  // 3. Member-Only Coupons (Checking Authenticated vs Guest users)
  {
    code: "MEMBER10",
    type: "PERCENTAGE",
    value: 1000, // 10%
    description: "10% exclusive discount for registered members [auth_only]",
    minSubtotalMinor: 300000, // Min ₹3,000
    status: "Active",
    maxRedemptions: 1000,
  },
  {
    code: "FIRSTORDER",
    type: "PERCENTAGE",
    value: 1500, // 15%
    description: "15% off for signed-in members on their first made-to-order purchase [auth_only]",
    minSubtotalMinor: 350000, // Min ₹3,500
    status: "Active",
    maxRedemptions: 500,
  },
];

export async function seedCoupons() {
  console.log("Seeding Saffron Vastra promo coupons...");
  for (const c of COUPONS_SEED_DATA) {
    const res = await prisma.coupon.upsert({
      where: { code: c.code },
      update: {
        type: c.type,
        value: c.value,
        description: c.description,
        minSubtotalMinor: c.minSubtotalMinor,
        status: c.status,
        maxRedemptions: c.maxRedemptions,
      },
      create: {
        code: c.code,
        type: c.type,
        value: c.value,
        description: c.description,
        minSubtotalMinor: c.minSubtotalMinor,
        status: c.status,
        maxRedemptions: c.maxRedemptions,
      },
    });
    console.log(`✓ Coupon: ${res.code} (${res.type === "PERCENTAGE" ? res.value / 100 + "%" : "₹" + res.value / 100}) - ${res.description}`);
  }
  console.log(`\nSuccessfully seeded ${COUPONS_SEED_DATA.length} coupons!`);
}

if (process.argv[1]?.endsWith("seed_coupons.ts") || process.argv[1]?.endsWith("seed_coupons.js")) {
  seedCoupons()
    .then(() => prisma.$disconnect())
    .catch((e) => {
      console.error("Seeding failed:", e);
      prisma.$disconnect();
      process.exit(1);
    });
}

