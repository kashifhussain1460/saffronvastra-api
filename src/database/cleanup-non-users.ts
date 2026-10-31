import { PrismaClient } from "@prisma/client";
import { prisma } from "./prisma.js";

/**
 * Tables to truncate - removes all product data, categories, orders, carts,
 * reviews, media, logs, and telemetry while strictly preserving user tables.
 */
export const TABLES_TO_TRUNCATE = [
  // 1. Product, Variant, and Collection Hierarchy
  "variant_images",
  "product_images",
  "product_variants",
  "collection_products",
  "products",
  "collections",

  // 2. Category Hierarchy
  "categories",

  // 3. Orders, Payments, Shipments & Fulfillment
  "refunds",
  "payments",
  "shipments",
  "order_status_history",
  "order_notes",
  "order_request_events",
  "order_request_items",
  "order_requests",
  "order_items",
  "orders",

  // 4. Shopping Carts & Wishlists
  "cart_items",
  "carts",
  "wishlist_items",
  "wishlists",

  // 5. Content, Marketing & Media
  "reviews",
  "coupons",
  "articles",
  "media_assets",

  // 6. Analytics, Telemetry, Notifications & Logs
  "activity_events",
  "admin_audit_logs",
  "tracking_sessions",
  "session_summaries",
  "contact_messages",
  "newsletter_subscribers",
  "newsletter_campaigns",
  "email_messages",
  "notification_deliveries",
  "notifications",
  "guest_profiles",
  "idempotency_keys",
  "webhook_events",
  "outbox_events",
];

export const PRESERVED_USER_TABLES = [
  "users",
  "roles",
  "user_roles",
  "customer_profiles",
  "addresses",
  "auth_sessions",
  "notification_preferences",
  "email_verification_tokens",
  "password_reset_tokens",
  "store_settings",
];

export async function executeCleanup(client: PrismaClient = prisma) {
  console.log("===================================================================");
  console.log("   CLEANUP: REMOVING ALL DATA EXCLUDING USER TABLES               ");
  console.log("===================================================================\n");

  // Pre-cleanup counts
  const initialUsers = await client.user.count();
  const initialRoles = await client.role.count();
  const initialUserRoles = await client.userRole.count();
  const initialProfiles = await client.customerProfile.count();
  const initialProducts = await client.product.count();
  const initialCategories = await client.category.count();
  const initialOrders = await client.order.count();
  const initialCarts = await client.cart.count();

  console.log("Pre-cleanup state:");
  console.log(`  - Users:        ${initialUsers}`);
  console.log(`  - Roles:        ${initialRoles}`);
  console.log(`  - User Roles:   ${initialUserRoles}`);
  console.log(`  - Profiles:     ${initialProfiles}`);
  console.log(`  - Products:     ${initialProducts}`);
  console.log(`  - Categories:   ${initialCategories}`);
  console.log(`  - Orders:       ${initialOrders}`);
  console.log(`  - Carts:        ${initialCarts}`);
  console.log("-------------------------------------------------------------------\n");

  console.log(`Truncating ${TABLES_TO_TRUNCATE.length} tables with CASCADE...`);
  const truncateSql = `TRUNCATE TABLE ${TABLES_TO_TRUNCATE.map((t) => `"${t}"`).join(", ")} CASCADE;`;
  await client.$executeRawUnsafe(truncateSql);

  // Post-cleanup counts
  const finalUsers = await client.user.count();
  const finalRoles = await client.role.count();
  const finalUserRoles = await client.userRole.count();
  const finalProfiles = await client.customerProfile.count();
  const finalProducts = await client.product.count();
  const finalCategories = await client.category.count();
  const finalOrders = await client.order.count();
  const finalCarts = await client.cart.count();

  console.log("Post-cleanup verification:");
  console.log(`✓ Preserved Users:       ${finalUsers} (Unchanged: ${finalUsers === initialUsers})`);
  console.log(`✓ Preserved Roles:       ${finalRoles} (Unchanged: ${finalRoles === initialRoles})`);
  console.log(`✓ Preserved UserRoles:   ${finalUserRoles} (Unchanged: ${finalUserRoles === initialUserRoles})`);
  console.log(`✓ Preserved Profiles:    ${finalProfiles} (Unchanged: ${finalProfiles === initialProfiles})`);
  console.log(`✓ Products Count:        ${finalProducts}`);
  console.log(`✓ Categories Count:      ${finalCategories}`);
  console.log(`✓ Orders Count:          ${finalOrders}`);
  console.log(`✓ Carts Count:           ${finalCarts}`);
  console.log("===================================================================");
  console.log("   CLEANUP COMPLETED SUCCESSFULLY                                  ");
  console.log("===================================================================\n");

  return {
    preserved: {
      users: finalUsers,
      roles: finalRoles,
      userRoles: finalUserRoles,
      profiles: finalProfiles,
    },
    cleared: {
      products: finalProducts,
      categories: finalCategories,
      orders: finalOrders,
      carts: finalCarts,
    },
  };
}

// Allow direct CLI execution: `npx tsx src/database/cleanup-non-users.ts`
const isDirectExecution =
  Boolean(process.argv[1]) &&
  (process.argv[1].endsWith("cleanup-non-users.ts") ||
    process.argv[1].endsWith("cleanup-non-users.js") ||
    process.argv[1].includes("cleanup-non-users"));

if (isDirectExecution) {
  executeCleanup()
    .then(async () => {
      await prisma.$disconnect();
      process.exit(0);
    })
    .catch(async (e) => {
      console.error("Cleanup failed:", e);
      await prisma.$disconnect();
      process.exit(1);
    });
}

