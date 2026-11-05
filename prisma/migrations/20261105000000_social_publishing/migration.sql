-- CreateTable
CREATE TABLE IF NOT EXISTS "social_accounts" (
    "id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "externalAccountId" TEXT,
    "accountName" TEXT NOT NULL,
    "accountType" TEXT NOT NULL DEFAULT 'business',
    "integrationMode" TEXT NOT NULL,
    "credentialSource" TEXT NOT NULL,
    "encryptedAccessToken" TEXT,
    "encryptedRefreshToken" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "grantedScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "appReviewStatus" TEXT NOT NULL DEFAULT 'pending',
    "connectionStatus" TEXT NOT NULL DEFAULT 'connected',
    "capabilities" JSONB,
    "apiVersion" TEXT,
    "lastVerifiedAt" TIMESTAMP(3),
    "lastHealthCheckAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "social_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "social_campaigns" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "social_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "social_campaign_products" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,

    CONSTRAINT "social_campaign_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "social_post_variants" (
    "id" TEXT NOT NULL,
    "campaignProductId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "caption" TEXT,
    "title" TEXT,
    "hashtags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "destinationUrl" TEXT,
    "settings" JSONB,
    "mediaSnapshot" JSONB,
    "validationStatus" TEXT NOT NULL DEFAULT 'pending',
    "validationErrors" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "social_post_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "social_publish_jobs" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "socialAccountId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "enqueuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMP(3),
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "externalPostId" TEXT,
    "externalPostUrl" TEXT,
    "providerContainerId" TEXT,
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "social_publish_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "social_publish_logs" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "providerRequestId" TEXT,
    "requestMeta" JSONB,
    "responseMeta" JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_publish_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "social_accounts_platform_key" ON "social_accounts"("platform");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "social_campaigns_status_createdAt_idx" ON "social_campaigns"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "social_campaign_products_campaignId_productId_key" ON "social_campaign_products"("campaignId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "social_post_variants_campaignProductId_platform_key" ON "social_post_variants"("campaignProductId", "platform");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "social_publish_jobs_variantId_key" ON "social_publish_jobs"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "social_publish_jobs_idempotencyKey_key" ON "social_publish_jobs"("idempotencyKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "social_publish_jobs_status_enqueuedAt_idx" ON "social_publish_jobs"("status", "enqueuedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "social_publish_jobs_socialAccountId_status_idx" ON "social_publish_jobs"("socialAccountId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "social_publish_logs_jobId_createdAt_idx" ON "social_publish_logs"("jobId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "social_campaigns" ADD CONSTRAINT "social_campaigns_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_campaign_products" ADD CONSTRAINT "social_campaign_products_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "social_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_campaign_products" ADD CONSTRAINT "social_campaign_products_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_post_variants" ADD CONSTRAINT "social_post_variants_campaignProductId_fkey" FOREIGN KEY ("campaignProductId") REFERENCES "social_campaign_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_publish_jobs" ADD CONSTRAINT "social_publish_jobs_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "social_post_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_publish_jobs" ADD CONSTRAINT "social_publish_jobs_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "social_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_publish_logs" ADD CONSTRAINT "social_publish_logs_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "social_publish_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

