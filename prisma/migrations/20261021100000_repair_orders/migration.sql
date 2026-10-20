-- 售后维修（2026-10-20，口径第 13 节）：维修单、服务种类（碎屏险 / 延保 / 其他）、碎屏险“已理赔”、收款可以属于维修单。

-- CreateEnum
CREATE TYPE "service_kind" AS ENUM ('SCREEN_INSURANCE', 'EXTENDED_WARRANTY', 'OTHER');

-- CreateEnum
CREATE TYPE "repair_status" AS ENUM ('RECEIVED', 'QUOTED', 'REPAIRING', 'READY', 'CLOSED', 'VOIDED');

-- CreateEnum
CREATE TYPE "repair_payer" AS ENUM ('CUSTOMER', 'WARRANTY', 'SCREEN_INSURANCE', 'EXTENDED_WARRANTY');

-- CreateEnum
CREATE TYPE "repair_outcome" AS ENUM ('REPAIRED', 'NOT_REPAIRED');

-- CreateEnum
CREATE TYPE "fault_category" AS ENUM ('SCREEN', 'BATTERY', 'BOARD', 'CAMERA', 'WATER', 'SOFTWARE', 'OTHER');

-- AlterEnum
ALTER TYPE "entitlement_status" ADD VALUE 'CLAIMED';

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "repair_order_id" INTEGER;

-- AlterTable
ALTER TABLE "skus" ADD COLUMN     "service_kind" "service_kind";

-- CreateTable
CREATE TABLE "repair_orders" (
    "id" SERIAL NOT NULL,
    "order_no" TEXT NOT NULL,
    "store_id" INTEGER NOT NULL,
    "customer_id" INTEGER NOT NULL,
    "received_by_id" INTEGER NOT NULL,
    "device_id" INTEGER,
    "device_code" TEXT NOT NULL,
    "model_name" TEXT NOT NULL,
    "sales_order_id" INTEGER,
    "purchased_on" DATE,
    "fault_category" "fault_category" NOT NULL,
    "fault_description" TEXT NOT NULL,
    "appearance" TEXT,
    "status" "repair_status" NOT NULL DEFAULT 'RECEIVED',
    "parts_fen" INTEGER,
    "labor_fen" INTEGER,
    "cost_fen" INTEGER,
    "payer" "repair_payer",
    "entitlement_id" INTEGER,
    "charge_fen" INTEGER NOT NULL DEFAULT 0,
    "outcome" "repair_outcome",
    "repair_note" TEXT,
    "quoted_at" TIMESTAMP(3),
    "approved_at" TIMESTAMP(3),
    "ready_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "closed_by_id" INTEGER,
    "biz_date" DATE,
    "daily_close_id" INTEGER,
    "voided_at" TIMESTAMP(3),
    "voided_by_id" INTEGER,
    "void_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "repair_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "repair_orders_order_no_key" ON "repair_orders"("order_no");

-- CreateIndex
CREATE INDEX "repair_orders_store_id_status_idx" ON "repair_orders"("store_id", "status");

-- CreateIndex
CREATE INDEX "repair_orders_store_id_biz_date_idx" ON "repair_orders"("store_id", "biz_date");

-- CreateIndex
CREATE INDEX "repair_orders_device_code_idx" ON "repair_orders"("device_code");

-- CreateIndex
CREATE INDEX "repair_orders_customer_id_idx" ON "repair_orders"("customer_id");

-- CreateIndex
CREATE INDEX "payments_repair_order_id_idx" ON "payments"("repair_order_id");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_repair_order_id_fkey" FOREIGN KEY ("repair_order_id") REFERENCES "repair_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_orders" ADD CONSTRAINT "repair_orders_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_orders" ADD CONSTRAINT "repair_orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_orders" ADD CONSTRAINT "repair_orders_received_by_id_fkey" FOREIGN KEY ("received_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_orders" ADD CONSTRAINT "repair_orders_closed_by_id_fkey" FOREIGN KEY ("closed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_orders" ADD CONSTRAINT "repair_orders_voided_by_id_fkey" FOREIGN KEY ("voided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_orders" ADD CONSTRAINT "repair_orders_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_orders" ADD CONSTRAINT "repair_orders_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_orders" ADD CONSTRAINT "repair_orders_entitlement_id_fkey" FOREIGN KEY ("entitlement_id") REFERENCES "service_entitlements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_orders" ADD CONSTRAINT "repair_orders_daily_close_id_fkey" FOREIGN KEY ("daily_close_id") REFERENCES "daily_closes"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- 已有的服务类商品按名字补上服务种类
UPDATE "skus" SET "service_kind" = (CASE WHEN "name" LIKE '%碎屏%' THEN 'SCREEN_INSURANCE' WHEN "name" LIKE '%延保%' THEN 'EXTENDED_WARRANTY' ELSE 'OTHER' END)::"service_kind" WHERE "is_service";

-- 数据库兜底的检查约束（schema.prisma 写不了 CHECK，对应字段旁有注释）
-- 服务类商品必须有服务种类，普通商品没有
ALTER TABLE "skus" ADD CONSTRAINT "skus_service_kind_matches" CHECK ("is_service" = ("service_kind" IS NOT NULL));

-- 一条收款明细属于销售单、退货单、维修单之一，有且只有一个
ALTER TABLE "payments" DROP CONSTRAINT "payments_one_owner";
ALTER TABLE "payments" ADD CONSTRAINT "payments_one_owner" CHECK (num_nonnulls("sales_order_id", "return_order_id", "repair_order_id") = 1);

-- 维修的金额都不能是负数
ALTER TABLE "repair_orders" ADD CONSTRAINT "repair_orders_amounts" CHECK ("charge_fen" >= 0 AND COALESCE("parts_fen", 0) >= 0 AND COALESCE("labor_fen", 0) >= 0 AND COALESCE("cost_fen", 0) >= 0);
