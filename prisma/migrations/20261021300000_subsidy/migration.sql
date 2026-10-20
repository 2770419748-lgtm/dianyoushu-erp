-- 国补（2026-10-20，口径第 15 节）：政策、国补单；收款方式加“国补立减”。

-- CreateEnum
CREATE TYPE "subsidy_claim_status" AS ENUM ('PENDING', 'SUBMITTED', 'APPROVED', 'SETTLED', 'REJECTED', 'CANCELLED', 'RETURN_DUE', 'RETURNED');

-- AlterEnum
ALTER TYPE "payment_method" ADD VALUE 'SUBSIDY';

-- CreateTable
CREATE TABLE "subsidy_policies" (
    "id" SERIAL NOT NULL,
    "category_id" INTEGER NOT NULL,
    "rate_bp" INTEGER NOT NULL,
    "cap_fen" INTEGER NOT NULL,
    "price_cap_fen" INTEGER NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subsidy_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subsidy_claims" (
    "id" SERIAL NOT NULL,
    "claim_no" TEXT NOT NULL,
    "store_id" INTEGER NOT NULL,
    "sales_order_id" INTEGER NOT NULL,
    "sales_order_item_id" INTEGER NOT NULL,
    "customer_id" INTEGER NOT NULL,
    "device_id" INTEGER NOT NULL,
    "policy_id" INTEGER NOT NULL,
    "category_id" INTEGER NOT NULL,
    "biz_date" DATE NOT NULL,
    "base_price_fen" INTEGER NOT NULL,
    "subsidy_fen" INTEGER NOT NULL,
    "qualification_code" TEXT NOT NULL,
    "invoice_no" TEXT,
    "status" "subsidy_claim_status" NOT NULL DEFAULT 'PENDING',
    "submitted_at" TIMESTAMP(3),
    "reviewed_at" TIMESTAMP(3),
    "reject_reason" TEXT,
    "settled_at" TIMESTAMP(3),
    "settled_fen" INTEGER,
    "cancelled_at" TIMESTAMP(3),
    "returned_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subsidy_claims_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "subsidy_policies_category_id_key" ON "subsidy_policies"("category_id");

-- CreateIndex
CREATE UNIQUE INDEX "subsidy_claims_claim_no_key" ON "subsidy_claims"("claim_no");

-- CreateIndex
CREATE UNIQUE INDEX "subsidy_claims_sales_order_item_id_key" ON "subsidy_claims"("sales_order_item_id");

-- CreateIndex
CREATE INDEX "subsidy_claims_store_id_biz_date_idx" ON "subsidy_claims"("store_id", "biz_date");

-- CreateIndex
CREATE INDEX "subsidy_claims_customer_id_category_id_idx" ON "subsidy_claims"("customer_id", "category_id");

-- CreateIndex
CREATE INDEX "subsidy_claims_sales_order_id_idx" ON "subsidy_claims"("sales_order_id");

-- CreateIndex
CREATE INDEX "subsidy_claims_status_idx" ON "subsidy_claims"("status");

-- CreateIndex
CREATE INDEX "subsidy_claims_qualification_code_idx" ON "subsidy_claims"("qualification_code");

-- AddForeignKey
ALTER TABLE "subsidy_policies" ADD CONSTRAINT "subsidy_policies_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subsidy_claims" ADD CONSTRAINT "subsidy_claims_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subsidy_claims" ADD CONSTRAINT "subsidy_claims_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subsidy_claims" ADD CONSTRAINT "subsidy_claims_sales_order_item_id_fkey" FOREIGN KEY ("sales_order_item_id") REFERENCES "sales_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subsidy_claims" ADD CONSTRAINT "subsidy_claims_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subsidy_claims" ADD CONSTRAINT "subsidy_claims_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subsidy_claims" ADD CONSTRAINT "subsidy_claims_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "subsidy_policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subsidy_claims" ADD CONSTRAINT "subsidy_claims_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- 数据库兜底的检查约束（schema.prisma 写不了 CHECK）
ALTER TABLE "subsidy_policies" ADD CONSTRAINT "subsidy_policies_values" CHECK ("rate_bp" BETWEEN 1 AND 10000 AND "cap_fen" > 0 AND "price_cap_fen" > 0 AND "ends_on" >= "starts_on");
ALTER TABLE "subsidy_claims" ADD CONSTRAINT "subsidy_claims_amounts" CHECK ("subsidy_fen" > 0 AND "subsidy_fen" <= "base_price_fen" AND COALESCE("settled_fen", 0) >= 0);
