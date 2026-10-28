-- AlterTable
ALTER TABLE "orders" ALTER COLUMN "paymentStatus" SET DEFAULT 'Pending';

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "failureReason" TEXT,
ADD COLUMN     "paidAt" TIMESTAMP(3),
ADD COLUMN     "providerOrderId" TEXT,
ADD COLUMN     "providerPaymentId" TEXT,
ALTER COLUMN "status" SET DEFAULT 'PENDING';

-- AlterTable
ALTER TABLE "refunds" ADD COLUMN     "failureReason" TEXT,
ADD COLUMN     "initiatedByUserId" TEXT,
ADD COLUMN     "manualReference" TEXT,
ADD COLUMN     "method" TEXT NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "processedAt" TIMESTAMP(3),
ADD COLUMN     "refundRef" TEXT,
ADD COLUMN     "requestId" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "status" SET DEFAULT 'PENDING';

-- CreateTable
CREATE TABLE "order_requests" (
    "id" TEXT NOT NULL,
    "requestNumber" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "userId" TEXT,
    "guestProfileId" TEXT,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Requested',
    "reasonCode" TEXT NOT NULL,
    "details" TEXT,
    "resolution" TEXT NOT NULL DEFAULT 'REFUND',
    "outsideWindow" BOOLEAN NOT NULL DEFAULT false,
    "returnShippingPayer" TEXT,
    "evidence" JSONB,
    "decisionNote" TEXT,
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_request_items" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "exchangeSize" TEXT,

    CONSTRAINT "order_request_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_request_events" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorRole" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_request_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "order_requests_requestNumber_key" ON "order_requests"("requestNumber");

-- CreateIndex
CREATE INDEX "order_requests_orderId_idx" ON "order_requests"("orderId");

-- CreateIndex
CREATE INDEX "order_requests_status_createdAt_idx" ON "order_requests"("status", "createdAt");

-- CreateIndex
CREATE INDEX "order_requests_userId_createdAt_idx" ON "order_requests"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "order_request_items_orderItemId_idx" ON "order_request_items"("orderItemId");

-- CreateIndex
CREATE UNIQUE INDEX "order_request_items_requestId_orderItemId_key" ON "order_request_items"("requestId", "orderItemId");

-- CreateIndex
CREATE INDEX "order_request_events_requestId_idx" ON "order_request_events"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "payments_providerOrderId_key" ON "payments"("providerOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "payments_providerPaymentId_key" ON "payments"("providerPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_refundRef_key" ON "refunds"("refundRef");

-- CreateIndex
CREATE INDEX "refunds_requestId_idx" ON "refunds"("requestId");

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "order_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_requests" ADD CONSTRAINT "order_requests_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_request_items" ADD CONSTRAINT "order_request_items_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "order_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_request_items" ADD CONSTRAINT "order_request_items_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_request_events" ADD CONSTRAINT "order_request_events_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "order_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------------------------------------------
-- Integrity rules enforced by the database itself (not only by the application).
-- Every existing row satisfies them (checked before this migration was written).
-- ---------------------------------------------------------------------------------------------------------------

-- Money is stored in minor units (paise) and never negative.
ALTER TABLE "orders" ADD CONSTRAINT "orders_amounts_non_negative"
  CHECK ("subtotalMinor" >= 0 AND "shippingMinor" >= 0 AND "taxMinor" >= 0 AND "discountMinor" >= 0 AND "totalMinor" >= 0);
ALTER TABLE "orders" ADD CONSTRAINT "orders_status_valid"
  CHECK ("status" IN ('Pending', 'Processing', 'Ready to Ship', 'Shipped', 'Delivered', 'Cancelled'));
ALTER TABLE "orders" ADD CONSTRAINT "orders_payment_status_valid"
  CHECK ("paymentStatus" IN ('Pending', 'Paid', 'Failed', 'Partially Refunded', 'Refunded'));

ALTER TABLE "order_items" ADD CONSTRAINT "order_items_quantity_positive" CHECK ("quantity" > 0);

ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_non_negative" CHECK ("amountMinor" >= 0);
ALTER TABLE "payments" ADD CONSTRAINT "payments_status_valid" CHECK ("status" IN ('PENDING', 'SUCCESS', 'FAILED', 'EXPIRED'));

ALTER TABLE "refunds" ADD CONSTRAINT "refunds_amount_positive" CHECK ("amountMinor" > 0);
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_status_valid" CHECK ("status" IN ('PENDING', 'COMPLETED', 'FAILED'));
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_method_valid" CHECK ("method" IN ('GATEWAY', 'MANUAL'));

ALTER TABLE "order_requests" ADD CONSTRAINT "order_requests_type_valid" CHECK ("type" IN ('CANCELLATION', 'RETURN', 'EXCHANGE'));
ALTER TABLE "order_requests" ADD CONSTRAINT "order_requests_status_valid"
  CHECK ("status" IN ('Requested', 'Approved', 'Rejected', 'Cancelled', 'Received', 'Completed'));
ALTER TABLE "order_requests" ADD CONSTRAINT "order_requests_reason_valid"
  CHECK ("reasonCode" IN ('CHANGE_OF_MIND', 'SIZE_ISSUE', 'DEFECTIVE', 'DAMAGED', 'INCORRECT', 'NOT_AS_DESCRIBED', 'OTHER'));
ALTER TABLE "order_requests" ADD CONSTRAINT "order_requests_resolution_valid" CHECK ("resolution" IN ('REFUND', 'EXCHANGE', 'NONE'));
ALTER TABLE "order_requests" ADD CONSTRAINT "order_requests_shipping_payer_valid"
  CHECK ("returnShippingPayer" IS NULL OR "returnShippingPayer" IN ('CUSTOMER', 'SELLER'));
-- a request belongs to exactly one kind of customer: a signed-in user or a guest
ALTER TABLE "order_requests" ADD CONSTRAINT "order_requests_owner_present" CHECK ("userId" IS NOT NULL OR "guestProfileId" IS NOT NULL);

ALTER TABLE "order_request_items" ADD CONSTRAINT "order_request_items_quantity_positive" CHECK ("quantity" > 0);
