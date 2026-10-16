-- CreateEnum
CREATE TYPE "sku_kind" AS ENUM ('DEVICE', 'ACCESSORY');

-- CreateEnum
CREATE TYPE "device_status" AS ENUM ('IN_TRANSIT', 'IN_STOCK', 'SOLD', 'RECYCLED', 'REFURBISHED', 'LOCKED', 'LOST');

-- CreateEnum
CREATE TYPE "purchase_order_status" AS ENUM ('DRAFT', 'SUBMITTED', 'RECEIVED', 'VOIDED');

-- CreateEnum
CREATE TYPE "transfer_status" AS ENUM ('REQUESTED', 'SHIPPED', 'RECEIVED', 'VOIDED');

-- CreateEnum
CREATE TYPE "stocktake_status" AS ENUM ('IN_PROGRESS', 'CONFIRMED', 'VOIDED');

-- CreateEnum
CREATE TYPE "sales_order_status" AS ENUM ('COMPLETED', 'VOIDED');

-- CreateEnum
CREATE TYPE "trade_in_status" AS ENUM ('COMPLETED', 'VOIDED');

-- CreateEnum
CREATE TYPE "daily_close_status" AS ENUM ('PENDING', 'CONFIRMED');

-- CreateEnum
CREATE TYPE "payment_method" AS ENUM ('CASH', 'WECHAT', 'ALIPAY', 'CARD', 'INSTALLMENT', 'TRADE_IN', 'OTHER');

-- CreateEnum
CREATE TYPE "ledger_doc_type" AS ENUM ('PURCHASE_RECEIPT', 'TRANSFER_LOCK', 'TRANSFER_UNLOCK', 'TRANSFER_OUT', 'TRANSFER_IN', 'STOCKTAKE_GAIN', 'STOCKTAKE_LOSS', 'SALE', 'SALE_VOID', 'RETURN', 'TRADE_IN', 'REFURBISH');

-- CreateTable
CREATE TABLE "categories" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "sku_kind" NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brands" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "brands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_models" (
    "id" SERIAL NOT NULL,
    "brand_id" INTEGER NOT NULL,
    "category_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skus" (
    "id" SERIAL NOT NULL,
    "model_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "storage" TEXT,
    "barcode" TEXT,
    "guide_price_fen" INTEGER NOT NULL,
    "cost_price_fen" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "skus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_prices" (
    "id" SERIAL NOT NULL,
    "store_id" INTEGER NOT NULL,
    "sku_id" INTEGER NOT NULL,
    "price_fen" INTEGER NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "store_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" SERIAL NOT NULL,
    "imei" TEXT NOT NULL,
    "sku_id" INTEGER NOT NULL,
    "store_id" INTEGER NOT NULL,
    "status" "device_status" NOT NULL,
    "cost_fen" INTEGER NOT NULL,
    "condition" TEXT,
    "goods_receipt_id" INTEGER,
    "trade_in_order_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accessory_stocks" (
    "id" SERIAL NOT NULL,
    "store_id" INTEGER NOT NULL,
    "sku_id" INTEGER NOT NULL,
    "qty" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accessory_stocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_ledgers" (
    "id" SERIAL NOT NULL,
    "doc_type" "ledger_doc_type" NOT NULL,
    "doc_no" TEXT NOT NULL,
    "store_id" INTEGER NOT NULL,
    "sku_id" INTEGER NOT NULL,
    "device_id" INTEGER,
    "qty_delta" INTEGER NOT NULL,
    "balance_after" INTEGER,
    "status_before" "device_status",
    "status_after" "device_status",
    "operator_id" INTEGER NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_ledgers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_orders" (
    "id" SERIAL NOT NULL,
    "order_no" TEXT NOT NULL,
    "store_id" INTEGER NOT NULL,
    "status" "purchase_order_status" NOT NULL DEFAULT 'DRAFT',
    "supplier_name" TEXT,
    "note" TEXT,
    "created_by_id" INTEGER NOT NULL,
    "submitted_at" TIMESTAMP(3),
    "received_at" TIMESTAMP(3),
    "voided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_items" (
    "id" SERIAL NOT NULL,
    "order_id" INTEGER NOT NULL,
    "sku_id" INTEGER NOT NULL,
    "qty" INTEGER NOT NULL,
    "unit_cost_fen" INTEGER NOT NULL,
    "received_qty" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "purchase_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_receipts" (
    "id" SERIAL NOT NULL,
    "receipt_no" TEXT NOT NULL,
    "purchase_order_id" INTEGER NOT NULL,
    "store_id" INTEGER NOT NULL,
    "received_by_id" INTEGER NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goods_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_receipt_items" (
    "id" SERIAL NOT NULL,
    "receipt_id" INTEGER NOT NULL,
    "sku_id" INTEGER NOT NULL,
    "qty" INTEGER NOT NULL,
    "unit_cost_fen" INTEGER NOT NULL,

    CONSTRAINT "goods_receipt_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transfer_orders" (
    "id" SERIAL NOT NULL,
    "order_no" TEXT NOT NULL,
    "from_store_id" INTEGER NOT NULL,
    "to_store_id" INTEGER NOT NULL,
    "status" "transfer_status" NOT NULL DEFAULT 'REQUESTED',
    "note" TEXT,
    "requested_by_id" INTEGER NOT NULL,
    "shipped_by_id" INTEGER,
    "received_by_id" INTEGER,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "shipped_at" TIMESTAMP(3),
    "received_at" TIMESTAMP(3),
    "voided_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transfer_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transfer_items" (
    "id" SERIAL NOT NULL,
    "transfer_id" INTEGER NOT NULL,
    "sku_id" INTEGER NOT NULL,
    "device_id" INTEGER,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "received_qty" INTEGER NOT NULL DEFAULT 0,
    "received_at" TIMESTAMP(3),

    CONSTRAINT "transfer_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stocktakes" (
    "id" SERIAL NOT NULL,
    "stocktake_no" TEXT NOT NULL,
    "store_id" INTEGER NOT NULL,
    "status" "stocktake_status" NOT NULL DEFAULT 'IN_PROGRESS',
    "note" TEXT,
    "created_by_id" INTEGER NOT NULL,
    "confirmed_by_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMP(3),
    "voided_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stocktakes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stocktake_items" (
    "id" SERIAL NOT NULL,
    "stocktake_id" INTEGER NOT NULL,
    "sku_id" INTEGER NOT NULL,
    "device_id" INTEGER,
    "expected_qty" INTEGER NOT NULL,
    "counted_qty" INTEGER,
    "diff_qty" INTEGER,

    CONSTRAINT "stocktake_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_orders" (
    "id" SERIAL NOT NULL,
    "order_no" TEXT NOT NULL,
    "store_id" INTEGER NOT NULL,
    "customer_id" INTEGER,
    "salesperson_id" INTEGER NOT NULL,
    "status" "sales_order_status" NOT NULL DEFAULT 'COMPLETED',
    "biz_date" DATE NOT NULL,
    "subtotal_fen" INTEGER NOT NULL,
    "discount_fen" INTEGER NOT NULL DEFAULT 0,
    "total_fen" INTEGER NOT NULL,
    "trade_in_order_id" INTEGER,
    "daily_close_id" INTEGER,
    "note" TEXT,
    "voided_by_id" INTEGER,
    "voided_at" TIMESTAMP(3),
    "void_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_order_items" (
    "id" SERIAL NOT NULL,
    "order_id" INTEGER NOT NULL,
    "sku_id" INTEGER NOT NULL,
    "device_id" INTEGER,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "unit_price_fen" INTEGER NOT NULL,
    "discount_fen" INTEGER NOT NULL DEFAULT 0,
    "line_total_fen" INTEGER NOT NULL,
    "cost_fen" INTEGER NOT NULL,
    "returned_qty" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "sales_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" SERIAL NOT NULL,
    "sales_order_id" INTEGER,
    "return_order_id" INTEGER,
    "method" "payment_method" NOT NULL,
    "amount_fen" INTEGER NOT NULL,
    "trade_in_order_id" INTEGER,
    "reference" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "return_orders" (
    "id" SERIAL NOT NULL,
    "order_no" TEXT NOT NULL,
    "store_id" INTEGER NOT NULL,
    "sales_order_id" INTEGER NOT NULL,
    "customer_id" INTEGER,
    "handled_by_id" INTEGER NOT NULL,
    "biz_date" DATE NOT NULL,
    "refund_fen" INTEGER NOT NULL,
    "reason" TEXT,
    "daily_close_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "return_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "return_order_items" (
    "id" SERIAL NOT NULL,
    "return_order_id" INTEGER NOT NULL,
    "sales_item_id" INTEGER NOT NULL,
    "sku_id" INTEGER NOT NULL,
    "device_id" INTEGER,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "refund_fen" INTEGER NOT NULL,

    CONSTRAINT "return_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trade_in_orders" (
    "id" SERIAL NOT NULL,
    "order_no" TEXT NOT NULL,
    "store_id" INTEGER NOT NULL,
    "customer_id" INTEGER,
    "handled_by_id" INTEGER NOT NULL,
    "imei" TEXT NOT NULL,
    "model_name" TEXT NOT NULL,
    "sku_id" INTEGER,
    "condition" TEXT NOT NULL,
    "appraised_fen" INTEGER NOT NULL,
    "status" "trade_in_status" NOT NULL DEFAULT 'COMPLETED',
    "note" TEXT,
    "voided_by_id" INTEGER,
    "voided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trade_in_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_closes" (
    "id" SERIAL NOT NULL,
    "close_no" TEXT NOT NULL,
    "store_id" INTEGER NOT NULL,
    "biz_date" DATE NOT NULL,
    "status" "daily_close_status" NOT NULL DEFAULT 'PENDING',
    "confirmed_by_id" INTEGER,
    "confirmed_at" TIMESTAMP(3),
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daily_closes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_close_lines" (
    "id" SERIAL NOT NULL,
    "daily_close_id" INTEGER NOT NULL,
    "method" "payment_method" NOT NULL,
    "system_fen" INTEGER NOT NULL,
    "actual_fen" INTEGER,
    "diff_fen" INTEGER,

    CONSTRAINT "daily_close_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kpi_targets" (
    "id" SERIAL NOT NULL,
    "store_id" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "sales_target_fen" INTEGER NOT NULL,
    "profit_target_fen" INTEGER NOT NULL,
    "device_qty_target" INTEGER NOT NULL,
    "trade_in_qty_target" INTEGER NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kpi_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER,
    "action" TEXT NOT NULL,
    "entity" TEXT,
    "entity_id" TEXT,
    "detail" JSONB,
    "ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doc_counters" (
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "doc_counters_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "categories_name_key" ON "categories"("name");

-- CreateIndex
CREATE UNIQUE INDEX "brands_name_key" ON "brands"("name");

-- CreateIndex
CREATE INDEX "product_models_category_id_idx" ON "product_models"("category_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_models_brand_id_name_key" ON "product_models"("brand_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "skus_barcode_key" ON "skus"("barcode");

-- CreateIndex
CREATE INDEX "skus_model_id_idx" ON "skus"("model_id");

-- CreateIndex
CREATE UNIQUE INDEX "store_prices_store_id_sku_id_key" ON "store_prices"("store_id", "sku_id");

-- CreateIndex
CREATE UNIQUE INDEX "devices_imei_key" ON "devices"("imei");

-- CreateIndex
CREATE UNIQUE INDEX "devices_trade_in_order_id_key" ON "devices"("trade_in_order_id");

-- CreateIndex
CREATE INDEX "devices_store_id_status_idx" ON "devices"("store_id", "status");

-- CreateIndex
CREATE INDEX "devices_sku_id_idx" ON "devices"("sku_id");

-- CreateIndex
CREATE UNIQUE INDEX "accessory_stocks_store_id_sku_id_key" ON "accessory_stocks"("store_id", "sku_id");

-- CreateIndex
CREATE INDEX "stock_ledgers_store_id_sku_id_created_at_idx" ON "stock_ledgers"("store_id", "sku_id", "created_at");

-- CreateIndex
CREATE INDEX "stock_ledgers_device_id_idx" ON "stock_ledgers"("device_id");

-- CreateIndex
CREATE INDEX "stock_ledgers_doc_type_doc_no_idx" ON "stock_ledgers"("doc_type", "doc_no");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_order_no_key" ON "purchase_orders"("order_no");

-- CreateIndex
CREATE INDEX "purchase_orders_store_id_status_idx" ON "purchase_orders"("store_id", "status");

-- CreateIndex
CREATE INDEX "purchase_order_items_order_id_idx" ON "purchase_order_items"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipts_receipt_no_key" ON "goods_receipts"("receipt_no");

-- CreateIndex
CREATE INDEX "goods_receipts_purchase_order_id_idx" ON "goods_receipts"("purchase_order_id");

-- CreateIndex
CREATE INDEX "goods_receipt_items_receipt_id_idx" ON "goods_receipt_items"("receipt_id");

-- CreateIndex
CREATE UNIQUE INDEX "transfer_orders_order_no_key" ON "transfer_orders"("order_no");

-- CreateIndex
CREATE INDEX "transfer_orders_from_store_id_status_idx" ON "transfer_orders"("from_store_id", "status");

-- CreateIndex
CREATE INDEX "transfer_orders_to_store_id_status_idx" ON "transfer_orders"("to_store_id", "status");

-- CreateIndex
CREATE INDEX "transfer_items_transfer_id_idx" ON "transfer_items"("transfer_id");

-- CreateIndex
CREATE UNIQUE INDEX "stocktakes_stocktake_no_key" ON "stocktakes"("stocktake_no");

-- CreateIndex
CREATE INDEX "stocktakes_store_id_status_idx" ON "stocktakes"("store_id", "status");

-- CreateIndex
CREATE INDEX "stocktake_items_stocktake_id_idx" ON "stocktake_items"("stocktake_id");

-- CreateIndex
CREATE UNIQUE INDEX "customers_phone_key" ON "customers"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "sales_orders_order_no_key" ON "sales_orders"("order_no");

-- CreateIndex
CREATE UNIQUE INDEX "sales_orders_trade_in_order_id_key" ON "sales_orders"("trade_in_order_id");

-- CreateIndex
CREATE INDEX "sales_orders_store_id_biz_date_idx" ON "sales_orders"("store_id", "biz_date");

-- CreateIndex
CREATE INDEX "sales_orders_salesperson_id_biz_date_idx" ON "sales_orders"("salesperson_id", "biz_date");

-- CreateIndex
CREATE INDEX "sales_order_items_order_id_idx" ON "sales_order_items"("order_id");

-- CreateIndex
CREATE INDEX "sales_order_items_device_id_idx" ON "sales_order_items"("device_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_trade_in_order_id_key" ON "payments"("trade_in_order_id");

-- CreateIndex
CREATE INDEX "payments_sales_order_id_idx" ON "payments"("sales_order_id");

-- CreateIndex
CREATE INDEX "payments_return_order_id_idx" ON "payments"("return_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "return_orders_order_no_key" ON "return_orders"("order_no");

-- CreateIndex
CREATE INDEX "return_orders_store_id_biz_date_idx" ON "return_orders"("store_id", "biz_date");

-- CreateIndex
CREATE INDEX "return_orders_sales_order_id_idx" ON "return_orders"("sales_order_id");

-- CreateIndex
CREATE INDEX "return_order_items_return_order_id_idx" ON "return_order_items"("return_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "trade_in_orders_order_no_key" ON "trade_in_orders"("order_no");

-- CreateIndex
CREATE INDEX "trade_in_orders_store_id_created_at_idx" ON "trade_in_orders"("store_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "daily_closes_close_no_key" ON "daily_closes"("close_no");

-- CreateIndex
CREATE UNIQUE INDEX "daily_closes_store_id_biz_date_key" ON "daily_closes"("store_id", "biz_date");

-- CreateIndex
CREATE UNIQUE INDEX "daily_close_lines_daily_close_id_method_key" ON "daily_close_lines"("daily_close_id", "method");

-- CreateIndex
CREATE UNIQUE INDEX "kpi_targets_store_id_year_month_key" ON "kpi_targets"("store_id", "year", "month");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "audit_logs_entity_entity_id_idx" ON "audit_logs"("entity", "entity_id");

-- AddForeignKey
ALTER TABLE "product_models" ADD CONSTRAINT "product_models_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_models" ADD CONSTRAINT "product_models_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skus" ADD CONSTRAINT "skus_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "product_models"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_prices" ADD CONSTRAINT "store_prices_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_prices" ADD CONSTRAINT "store_prices_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "skus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "skus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_goods_receipt_id_fkey" FOREIGN KEY ("goods_receipt_id") REFERENCES "goods_receipts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_trade_in_order_id_fkey" FOREIGN KEY ("trade_in_order_id") REFERENCES "trade_in_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accessory_stocks" ADD CONSTRAINT "accessory_stocks_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accessory_stocks" ADD CONSTRAINT "accessory_stocks_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "skus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_ledgers" ADD CONSTRAINT "stock_ledgers_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_ledgers" ADD CONSTRAINT "stock_ledgers_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "skus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_ledgers" ADD CONSTRAINT "stock_ledgers_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_ledgers" ADD CONSTRAINT "stock_ledgers_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "skus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_received_by_id_fkey" FOREIGN KEY ("received_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_items" ADD CONSTRAINT "goods_receipt_items_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "goods_receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_items" ADD CONSTRAINT "goods_receipt_items_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "skus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_orders" ADD CONSTRAINT "transfer_orders_from_store_id_fkey" FOREIGN KEY ("from_store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_orders" ADD CONSTRAINT "transfer_orders_to_store_id_fkey" FOREIGN KEY ("to_store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_orders" ADD CONSTRAINT "transfer_orders_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_orders" ADD CONSTRAINT "transfer_orders_shipped_by_id_fkey" FOREIGN KEY ("shipped_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_orders" ADD CONSTRAINT "transfer_orders_received_by_id_fkey" FOREIGN KEY ("received_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_items" ADD CONSTRAINT "transfer_items_transfer_id_fkey" FOREIGN KEY ("transfer_id") REFERENCES "transfer_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_items" ADD CONSTRAINT "transfer_items_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "skus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_items" ADD CONSTRAINT "transfer_items_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktakes" ADD CONSTRAINT "stocktakes_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktakes" ADD CONSTRAINT "stocktakes_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktakes" ADD CONSTRAINT "stocktakes_confirmed_by_id_fkey" FOREIGN KEY ("confirmed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktake_items" ADD CONSTRAINT "stocktake_items_stocktake_id_fkey" FOREIGN KEY ("stocktake_id") REFERENCES "stocktakes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktake_items" ADD CONSTRAINT "stocktake_items_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "skus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktake_items" ADD CONSTRAINT "stocktake_items_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_salesperson_id_fkey" FOREIGN KEY ("salesperson_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_voided_by_id_fkey" FOREIGN KEY ("voided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_trade_in_order_id_fkey" FOREIGN KEY ("trade_in_order_id") REFERENCES "trade_in_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_daily_close_id_fkey" FOREIGN KEY ("daily_close_id") REFERENCES "daily_closes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_items" ADD CONSTRAINT "sales_order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_items" ADD CONSTRAINT "sales_order_items_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "skus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_items" ADD CONSTRAINT "sales_order_items_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_return_order_id_fkey" FOREIGN KEY ("return_order_id") REFERENCES "return_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_trade_in_order_id_fkey" FOREIGN KEY ("trade_in_order_id") REFERENCES "trade_in_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_orders" ADD CONSTRAINT "return_orders_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_orders" ADD CONSTRAINT "return_orders_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_orders" ADD CONSTRAINT "return_orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_orders" ADD CONSTRAINT "return_orders_handled_by_id_fkey" FOREIGN KEY ("handled_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_orders" ADD CONSTRAINT "return_orders_daily_close_id_fkey" FOREIGN KEY ("daily_close_id") REFERENCES "daily_closes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_order_items" ADD CONSTRAINT "return_order_items_return_order_id_fkey" FOREIGN KEY ("return_order_id") REFERENCES "return_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_order_items" ADD CONSTRAINT "return_order_items_sales_item_id_fkey" FOREIGN KEY ("sales_item_id") REFERENCES "sales_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_order_items" ADD CONSTRAINT "return_order_items_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "skus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_order_items" ADD CONSTRAINT "return_order_items_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_in_orders" ADD CONSTRAINT "trade_in_orders_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_in_orders" ADD CONSTRAINT "trade_in_orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_in_orders" ADD CONSTRAINT "trade_in_orders_handled_by_id_fkey" FOREIGN KEY ("handled_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_in_orders" ADD CONSTRAINT "trade_in_orders_voided_by_id_fkey" FOREIGN KEY ("voided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_in_orders" ADD CONSTRAINT "trade_in_orders_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "skus"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_closes" ADD CONSTRAINT "daily_closes_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_closes" ADD CONSTRAINT "daily_closes_confirmed_by_id_fkey" FOREIGN KEY ("confirmed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_close_lines" ADD CONSTRAINT "daily_close_lines_daily_close_id_fkey" FOREIGN KEY ("daily_close_id") REFERENCES "daily_closes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kpi_targets" ADD CONSTRAINT "kpi_targets_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
