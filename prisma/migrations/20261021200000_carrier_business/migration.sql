-- 运营商业务（2026-10-20，口径第 14 节）：佣金政策、业务单、按月结算单。

-- CreateEnum
CREATE TYPE "carrier" AS ENUM ('CMCC', 'CUCC', 'CTCC', 'CBN');

-- CreateEnum
CREATE TYPE "carrier_biz_type" AS ENUM ('NEW_LINE', 'PORT_IN', 'CONTRACT_PHONE', 'BROADBAND', 'PLAN_UPGRADE');

-- CreateEnum
CREATE TYPE "carrier_biz_status" AS ENUM ('SUBMITTED', 'ACTIVATED', 'FAILED', 'SETTLED', 'CLAWED_BACK', 'VOIDED');

-- CreateEnum
CREATE TYPE "carrier_settlement_source" AS ENUM ('FILE', 'SIMULATED');

-- CreateEnum
CREATE TYPE "carrier_line_result" AS ENUM ('MATCHED', 'DIFF', 'UNMATCHED');

-- CreateTable
CREATE TABLE "carrier_commission_rules" (
    "id" SERIAL NOT NULL,
    "carrier" "carrier" NOT NULL,
    "biz_type" "carrier_biz_type" NOT NULL,
    "commission_fen" INTEGER NOT NULL,
    "clawback_months" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "carrier_commission_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "carrier_business" (
    "id" SERIAL NOT NULL,
    "order_no" TEXT NOT NULL,
    "store_id" INTEGER NOT NULL,
    "handled_by_id" INTEGER NOT NULL,
    "customer_id" INTEGER,
    "carrier" "carrier" NOT NULL,
    "biz_type" "carrier_biz_type" NOT NULL,
    "phone" TEXT NOT NULL,
    "package_name" TEXT NOT NULL,
    "monthly_fee_fen" INTEGER,
    "carrier_order_no" TEXT,
    "sales_order_id" INTEGER,
    "biz_date" DATE NOT NULL,
    "expected_commission_fen" INTEGER NOT NULL,
    "clawback_months" INTEGER NOT NULL,
    "status" "carrier_biz_status" NOT NULL DEFAULT 'SUBMITTED',
    "activated_at" TIMESTAMP(3),
    "failed_reason" TEXT,
    "settlement_id" INTEGER,
    "settled_fen" INTEGER,
    "clawback_fen" INTEGER,
    "voided_at" TIMESTAMP(3),
    "voided_by_id" INTEGER,
    "void_reason" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "carrier_business_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "carrier_settlements" (
    "id" SERIAL NOT NULL,
    "settlement_no" TEXT NOT NULL,
    "carrier" "carrier" NOT NULL,
    "month" TEXT NOT NULL,
    "source" "carrier_settlement_source" NOT NULL,
    "imported_by_id" INTEGER NOT NULL,
    "line_count" INTEGER NOT NULL,
    "matched_count" INTEGER NOT NULL,
    "diff_count" INTEGER NOT NULL,
    "unmatched_count" INTEGER NOT NULL,
    "missing_count" INTEGER NOT NULL,
    "total_commission_fen" INTEGER NOT NULL,
    "total_clawback_fen" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "carrier_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "carrier_settlement_lines" (
    "id" SERIAL NOT NULL,
    "settlement_id" INTEGER NOT NULL,
    "carrier_order_no" TEXT,
    "phone" TEXT,
    "biz_type" "carrier_biz_type",
    "commission_fen" INTEGER NOT NULL,
    "clawback_fen" INTEGER NOT NULL,
    "business_id" INTEGER,
    "result" "carrier_line_result" NOT NULL,

    CONSTRAINT "carrier_settlement_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "carrier_commission_rules_carrier_biz_type_key" ON "carrier_commission_rules"("carrier", "biz_type");

-- CreateIndex
CREATE UNIQUE INDEX "carrier_business_order_no_key" ON "carrier_business"("order_no");

-- CreateIndex
CREATE INDEX "carrier_business_store_id_biz_date_idx" ON "carrier_business"("store_id", "biz_date");

-- CreateIndex
CREATE INDEX "carrier_business_carrier_status_idx" ON "carrier_business"("carrier", "status");

-- CreateIndex
CREATE INDEX "carrier_business_carrier_order_no_idx" ON "carrier_business"("carrier_order_no");

-- CreateIndex
CREATE INDEX "carrier_business_phone_idx" ON "carrier_business"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "carrier_settlements_settlement_no_key" ON "carrier_settlements"("settlement_no");

-- CreateIndex
CREATE UNIQUE INDEX "carrier_settlements_carrier_month_key" ON "carrier_settlements"("carrier", "month");

-- CreateIndex
CREATE INDEX "carrier_settlement_lines_settlement_id_idx" ON "carrier_settlement_lines"("settlement_id");

-- AddForeignKey
ALTER TABLE "carrier_business" ADD CONSTRAINT "carrier_business_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_business" ADD CONSTRAINT "carrier_business_handled_by_id_fkey" FOREIGN KEY ("handled_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_business" ADD CONSTRAINT "carrier_business_voided_by_id_fkey" FOREIGN KEY ("voided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_business" ADD CONSTRAINT "carrier_business_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_business" ADD CONSTRAINT "carrier_business_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_business" ADD CONSTRAINT "carrier_business_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "carrier_settlements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_settlements" ADD CONSTRAINT "carrier_settlements_imported_by_id_fkey" FOREIGN KEY ("imported_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_settlement_lines" ADD CONSTRAINT "carrier_settlement_lines_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "carrier_settlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_settlement_lines" ADD CONSTRAINT "carrier_settlement_lines_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "carrier_business"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- 数据库兜底的检查约束（schema.prisma 写不了 CHECK）
ALTER TABLE "carrier_commission_rules" ADD CONSTRAINT "carrier_rules_amounts" CHECK ("commission_fen" >= 0 AND "clawback_months" BETWEEN 0 AND 24);
ALTER TABLE "carrier_business" ADD CONSTRAINT "carrier_business_amounts" CHECK ("expected_commission_fen" >= 0 AND COALESCE("settled_fen", 0) >= 0 AND COALESCE("clawback_fen", 0) >= 0 AND COALESCE("monthly_fee_fen", 0) >= 0);
ALTER TABLE "carrier_settlement_lines" ADD CONSTRAINT "carrier_lines_amounts" CHECK ("commission_fen" >= 0 AND "clawback_fen" >= 0);
