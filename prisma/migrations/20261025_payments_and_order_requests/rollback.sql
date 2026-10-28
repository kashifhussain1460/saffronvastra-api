-- Manual rollback for 20261025_payments_and_order_requests (Prisma does not run this file).
-- Only safe while the new tables are still empty / the new columns unused, otherwise take a dump first.
DROP TABLE IF EXISTS "order_request_events";
DROP TABLE IF EXISTS "order_request_items";
ALTER TABLE "refunds" DROP CONSTRAINT IF EXISTS "refunds_requestId_fkey";
DROP TABLE IF EXISTS "order_requests";
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_amounts_non_negative", DROP CONSTRAINT IF EXISTS "orders_status_valid", DROP CONSTRAINT IF EXISTS "orders_payment_status_valid";
ALTER TABLE "order_items" DROP CONSTRAINT IF EXISTS "order_items_quantity_positive";
ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "payments_amount_non_negative", DROP CONSTRAINT IF EXISTS "payments_status_valid";
ALTER TABLE "refunds" DROP CONSTRAINT IF EXISTS "refunds_amount_positive", DROP CONSTRAINT IF EXISTS "refunds_status_valid", DROP CONSTRAINT IF EXISTS "refunds_method_valid";
DROP INDEX IF EXISTS "payments_providerOrderId_key", "payments_providerPaymentId_key", "refunds_refundRef_key", "refunds_requestId_idx";
ALTER TABLE "payments" DROP COLUMN IF EXISTS "failureReason", DROP COLUMN IF EXISTS "paidAt", DROP COLUMN IF EXISTS "providerOrderId", DROP COLUMN IF EXISTS "providerPaymentId", ALTER COLUMN "status" SET DEFAULT 'SUCCESS';
ALTER TABLE "refunds" DROP COLUMN IF EXISTS "failureReason", DROP COLUMN IF EXISTS "initiatedByUserId", DROP COLUMN IF EXISTS "manualReference", DROP COLUMN IF EXISTS "method", DROP COLUMN IF EXISTS "processedAt", DROP COLUMN IF EXISTS "refundRef", DROP COLUMN IF EXISTS "requestId", DROP COLUMN IF EXISTS "updatedAt", ALTER COLUMN "status" SET DEFAULT 'COMPLETED';
ALTER TABLE "orders" ALTER COLUMN "paymentStatus" SET DEFAULT 'Paid';
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261025_payments_and_order_requests';
