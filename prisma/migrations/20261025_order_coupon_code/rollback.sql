-- Manual rollback (Prisma does not run this file)
ALTER TABLE "orders" DROP COLUMN IF EXISTS "couponCode";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261025_order_coupon_code';
