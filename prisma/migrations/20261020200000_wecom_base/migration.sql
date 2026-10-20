-- 企业微信底座（2026-10-20，口径第 12 节）：员工企微账号、客户企微身份、跟进关系、标签、开单绑定码、回调事件、令牌缓存。

-- CreateEnum
CREATE TYPE "wecom_follow_status" AS ENUM ('ACTIVE', 'DELETED');

-- CreateEnum
CREATE TYPE "wecom_event_status" AS ENUM ('PENDING', 'PROCESSED', 'FAILED');

-- CreateEnum
CREATE TYPE "wecom_tag_source" AS ENUM ('AUTO', 'MANUAL', 'WECOM');

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "wecom_avatar_url" TEXT,
ADD COLUMN     "wecom_bound_at" TIMESTAMP(3),
ADD COLUMN     "wecom_external_userid" TEXT,
ADD COLUMN     "wecom_nickname" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "wecom_userid" TEXT;

-- CreateTable
CREATE TABLE "wecom_follows" (
    "id" SERIAL NOT NULL,
    "external_userid" TEXT NOT NULL,
    "wecom_userid" TEXT NOT NULL,
    "user_id" INTEGER,
    "customer_id" INTEGER,
    "status" "wecom_follow_status" NOT NULL DEFAULT 'ACTIVE',
    "deleted_by" TEXT,
    "state" TEXT,
    "first_add_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wecom_follows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wecom_tags" (
    "id" SERIAL NOT NULL,
    "group_name" TEXT NOT NULL,
    "tag_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wecom_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wecom_customer_tags" (
    "customer_id" INTEGER NOT NULL,
    "tag_id" INTEGER NOT NULL,
    "source" "wecom_tag_source" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wecom_customer_tags_pkey" PRIMARY KEY ("customer_id","tag_id")
);

-- CreateTable
CREATE TABLE "wecom_bind_codes" (
    "code" TEXT NOT NULL,
    "customer_id" INTEGER NOT NULL,
    "sales_order_id" INTEGER NOT NULL,
    "store_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "config_id" TEXT,
    "qr_code_url" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "contact_way_deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wecom_bind_codes_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "wecom_events" (
    "id" SERIAL NOT NULL,
    "event_key" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "event_type" TEXT NOT NULL,
    "change_type" TEXT,
    "payload" JSONB NOT NULL,
    "status" "wecom_event_status" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "wecom_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wecom_token_cache" (
    "key" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wecom_token_cache_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "wecom_follows_customer_id_idx" ON "wecom_follows"("customer_id");

-- CreateIndex
CREATE INDEX "wecom_follows_user_id_status_idx" ON "wecom_follows"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "wecom_follows_external_userid_wecom_userid_key" ON "wecom_follows"("external_userid", "wecom_userid");

-- CreateIndex
CREATE UNIQUE INDEX "wecom_tags_tag_id_key" ON "wecom_tags"("tag_id");

-- CreateIndex
CREATE UNIQUE INDEX "wecom_bind_codes_config_id_key" ON "wecom_bind_codes"("config_id");

-- CreateIndex
CREATE INDEX "wecom_bind_codes_sales_order_id_idx" ON "wecom_bind_codes"("sales_order_id");

-- CreateIndex
CREATE INDEX "wecom_bind_codes_expires_at_idx" ON "wecom_bind_codes"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "wecom_events_event_key_key" ON "wecom_events"("event_key");

-- CreateIndex
CREATE INDEX "wecom_events_status_received_at_idx" ON "wecom_events"("status", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "customers_wecom_external_userid_key" ON "customers"("wecom_external_userid");

-- CreateIndex
CREATE UNIQUE INDEX "users_wecom_userid_key" ON "users"("wecom_userid");

-- AddForeignKey
ALTER TABLE "wecom_follows" ADD CONSTRAINT "wecom_follows_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wecom_follows" ADD CONSTRAINT "wecom_follows_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wecom_customer_tags" ADD CONSTRAINT "wecom_customer_tags_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wecom_customer_tags" ADD CONSTRAINT "wecom_customer_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "wecom_tags"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wecom_bind_codes" ADD CONSTRAINT "wecom_bind_codes_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wecom_bind_codes" ADD CONSTRAINT "wecom_bind_codes_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wecom_bind_codes" ADD CONSTRAINT "wecom_bind_codes_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wecom_bind_codes" ADD CONSTRAINT "wecom_bind_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

