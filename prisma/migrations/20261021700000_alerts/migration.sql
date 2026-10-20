-- CreateEnum
CREATE TYPE "alert_kind" AS ENUM ('STALE_DEVICES', 'LOW_ACCESSORY', 'KPI_BEHIND', 'DAILY_CLOSE', 'TRANSFER_PENDING', 'STOCKTAKE_OPEN', 'TRADE_IN_IDLE', 'APPROVAL_PENDING', 'TRANSFER_SUGGEST', 'INTEGRITY');

-- CreateEnum
CREATE TYPE "alert_scope" AS ENUM ('STORE', 'REGION', 'HQ');

-- CreateEnum
CREATE TYPE "alert_digest_source" AS ENUM ('MODEL', 'SIMULATED', 'TEMPLATE');

-- AlterTable
ALTER TABLE "stores" ADD COLUMN     "wecom_webhook_url" TEXT;

-- CreateTable
CREATE TABLE "alert_items" (
    "id" SERIAL NOT NULL,
    "biz_date" DATE NOT NULL,
    "kind" "alert_kind" NOT NULL,
    "scope" "alert_scope" NOT NULL,
    "scope_key" TEXT NOT NULL,
    "store_id" INTEGER,
    "region_id" INTEGER,
    "severity" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "link" TEXT,
    "facts" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alert_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_digests" (
    "id" SERIAL NOT NULL,
    "biz_date" DATE NOT NULL,
    "scope" "alert_scope" NOT NULL,
    "scope_key" TEXT NOT NULL,
    "store_id" INTEGER,
    "region_id" INTEGER,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "source" "alert_digest_source" NOT NULL,
    "fallback_reason" TEXT,
    "item_count" INTEGER NOT NULL,
    "push_status" TEXT,
    "push_error" TEXT,
    "pushed_at" TIMESTAMP(3),
    "generated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alert_digests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "digest_id" INTEGER,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "alert_items_scope_key_biz_date_idx" ON "alert_items"("scope_key", "biz_date");

-- CreateIndex
CREATE UNIQUE INDEX "alert_items_biz_date_kind_scope_key_key" ON "alert_items"("biz_date", "kind", "scope_key");

-- CreateIndex
CREATE UNIQUE INDEX "alert_digests_biz_date_scope_key_key" ON "alert_digests"("biz_date", "scope_key");

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_idx" ON "notifications"("user_id", "read_at");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_user_id_digest_id_key" ON "notifications"("user_id", "digest_id");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_digest_id_fkey" FOREIGN KEY ("digest_id") REFERENCES "alert_digests"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- 轻重只有 1～3；条数不为负；门店群地址只能是企业微信官方的 webhook（防填内网地址让服务器去请求）
ALTER TABLE "alert_items" ADD CONSTRAINT "alert_items_severity_check" CHECK ("severity" BETWEEN 1 AND 3);
ALTER TABLE "alert_items" ADD CONSTRAINT "alert_items_scope_check" CHECK (("scope" = 'STORE') = ("store_id" IS NOT NULL) AND ("scope" = 'REGION') = ("region_id" IS NOT NULL));
ALTER TABLE "alert_digests" ADD CONSTRAINT "alert_digests_item_count_check" CHECK ("item_count" >= 0);
ALTER TABLE "stores" ADD CONSTRAINT "stores_wecom_webhook_url_check" CHECK ("wecom_webhook_url" IS NULL OR "wecom_webhook_url" LIKE 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=%');
