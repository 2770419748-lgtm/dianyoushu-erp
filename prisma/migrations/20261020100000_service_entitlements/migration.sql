-- 服务权益（2026-10-20，口径第 12 节）：服务类商品开单生成权益，到期提醒每档只发一次。

-- CreateEnum
CREATE TYPE "entitlement_status" AS ENUM ('ACTIVE', 'VOIDED');

-- CreateEnum
CREATE TYPE "reminder_stage" AS ENUM ('T30', 'T7');

-- AlterTable
ALTER TABLE "skus" ADD COLUMN     "is_service" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "service_months" INTEGER;

-- CreateTable
CREATE TABLE "service_entitlements" (
    "id" SERIAL NOT NULL,
    "customer_id" INTEGER NOT NULL,
    "store_id" INTEGER NOT NULL,
    "sales_order_id" INTEGER NOT NULL,
    "sales_order_item_id" INTEGER NOT NULL,
    "sku_id" INTEGER NOT NULL,
    "device_id" INTEGER,
    "started_on" DATE NOT NULL,
    "expires_on" DATE NOT NULL,
    "status" "entitlement_status" NOT NULL DEFAULT 'ACTIVE',
    "voided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_entitlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entitlement_reminders" (
    "id" SERIAL NOT NULL,
    "entitlement_id" INTEGER NOT NULL,
    "stage" "reminder_stage" NOT NULL,
    "contacted_at" TIMESTAMP(3),
    "contacted_by_id" INTEGER,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entitlement_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "service_entitlements_sales_order_item_id_key" ON "service_entitlements"("sales_order_item_id");

-- CreateIndex
CREATE INDEX "service_entitlements_customer_id_status_idx" ON "service_entitlements"("customer_id", "status");

-- CreateIndex
CREATE INDEX "service_entitlements_store_id_expires_on_idx" ON "service_entitlements"("store_id", "expires_on");

-- CreateIndex
CREATE INDEX "service_entitlements_expires_on_status_idx" ON "service_entitlements"("expires_on", "status");

-- CreateIndex
CREATE UNIQUE INDEX "entitlement_reminders_entitlement_id_stage_key" ON "entitlement_reminders"("entitlement_id", "stage");

-- AddForeignKey
ALTER TABLE "service_entitlements" ADD CONSTRAINT "service_entitlements_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_entitlements" ADD CONSTRAINT "service_entitlements_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_entitlements" ADD CONSTRAINT "service_entitlements_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_entitlements" ADD CONSTRAINT "service_entitlements_sales_order_item_id_fkey" FOREIGN KEY ("sales_order_item_id") REFERENCES "sales_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_entitlements" ADD CONSTRAINT "service_entitlements_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "skus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_entitlements" ADD CONSTRAINT "service_entitlements_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entitlement_reminders" ADD CONSTRAINT "entitlement_reminders_entitlement_id_fkey" FOREIGN KEY ("entitlement_id") REFERENCES "service_entitlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entitlement_reminders" ADD CONSTRAINT "entitlement_reminders_contacted_by_id_fkey" FOREIGN KEY ("contacted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- 数据库兜底的检查约束（schema.prisma 写不了 CHECK，对应字段旁有注释）
-- 服务类商品必须有 1～120 个月的期限
ALTER TABLE "skus" ADD CONSTRAINT "skus_service_months_range" CHECK (NOT "is_service" OR ("service_months" BETWEEN 1 AND 120));

-- 到期日不早于生效日
ALTER TABLE "service_entitlements" ADD CONSTRAINT "service_entitlements_dates" CHECK ("expires_on" >= "started_on");
