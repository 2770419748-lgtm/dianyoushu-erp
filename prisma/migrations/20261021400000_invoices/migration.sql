-- 发票（2026-10-20，口径第 16 节）：公司开票信息、开票申请 / 发票、发票明细。

-- CreateEnum
CREATE TYPE "invoice_kind" AS ENUM ('E_NORMAL', 'E_SPECIAL', 'PAPER_NORMAL');

-- CreateEnum
CREATE TYPE "invoice_title_type" AS ENUM ('PERSONAL', 'COMPANY');

-- CreateEnum
CREATE TYPE "invoice_status" AS ENUM ('REQUESTED', 'ISSUED', 'RED_PENDING', 'REDDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "invoice_issue_source" AS ENUM ('SIMULATED', 'MANUAL');

-- CreateTable
CREATE TABLE "invoice_seller" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "name" TEXT NOT NULL,
    "tax_no" TEXT NOT NULL,
    "address_phone" TEXT NOT NULL,
    "bank_account" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoice_seller_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" SERIAL NOT NULL,
    "request_no" TEXT NOT NULL,
    "store_id" INTEGER NOT NULL,
    "sales_order_id" INTEGER NOT NULL,
    "customer_id" INTEGER,
    "kind" "invoice_kind" NOT NULL,
    "title_type" "invoice_title_type" NOT NULL,
    "title_name" TEXT NOT NULL,
    "buyer_tax_no" TEXT,
    "buyer_address_phone" TEXT,
    "buyer_bank_account" TEXT,
    "receiver" TEXT,
    "amount_fen" INTEGER NOT NULL,
    "tax_fen" INTEGER NOT NULL,
    "status" "invoice_status" NOT NULL DEFAULT 'REQUESTED',
    "requested_by_id" INTEGER NOT NULL,
    "invoice_number" TEXT,
    "issue_source" "invoice_issue_source",
    "issued_at" TIMESTAMP(3),
    "issued_by_id" INTEGER,
    "seller_snapshot" JSONB,
    "delivered_at" TIMESTAMP(3),
    "red_number" TEXT,
    "red_at" TIMESTAMP(3),
    "red_by_id" INTEGER,
    "red_reason" TEXT,
    "cancelled_at" TIMESTAMP(3),
    "cancel_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_lines" (
    "id" SERIAL NOT NULL,
    "invoice_id" INTEGER NOT NULL,
    "sales_order_item_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "spec" TEXT,
    "qty" INTEGER NOT NULL,
    "amount_fen" INTEGER NOT NULL,
    "tax_rate_bp" INTEGER NOT NULL,
    "tax_fen" INTEGER NOT NULL,

    CONSTRAINT "invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "invoices_request_no_key" ON "invoices"("request_no");

-- CreateIndex
CREATE INDEX "invoices_store_id_created_at_idx" ON "invoices"("store_id", "created_at");

-- CreateIndex
CREATE INDEX "invoices_sales_order_id_idx" ON "invoices"("sales_order_id");

-- CreateIndex
CREATE INDEX "invoices_status_idx" ON "invoices"("status");

-- CreateIndex
CREATE INDEX "invoice_lines_invoice_id_idx" ON "invoice_lines"("invoice_id");

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_issued_by_id_fkey" FOREIGN KEY ("issued_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_red_by_id_fkey" FOREIGN KEY ("red_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_sales_order_item_id_fkey" FOREIGN KEY ("sales_order_item_id") REFERENCES "sales_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- 数据库兜底的约束（schema.prisma 写不了 CHECK 和部分唯一索引）
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_amounts" CHECK ("amount_fen" > 0 AND "tax_fen" >= 0 AND "tax_fen" <= "amount_fen");
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_amounts" CHECK ("qty" > 0 AND "amount_fen" > 0 AND "tax_rate_bp" BETWEEN 0 AND 10000 AND "tax_fen" >= 0 AND "tax_fen" <= "amount_fen");
ALTER TABLE "invoice_seller" ADD CONSTRAINT "invoice_seller_single_row" CHECK ("id" = 1);
-- 一张销售单同时只能有一张在办的发票
CREATE UNIQUE INDEX "invoices_one_active_per_order" ON "invoices" ("sales_order_id") WHERE "status" IN ('REQUESTED', 'ISSUED', 'RED_PENDING');
-- 发票号码不重复
CREATE UNIQUE INDEX "invoices_invoice_number_key" ON "invoices" ("invoice_number") WHERE "invoice_number" IS NOT NULL;
