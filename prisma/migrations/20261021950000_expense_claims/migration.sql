-- CreateEnum
CREATE TYPE "expense_category" AS ENUM ('TRANSPORT', 'OFFICE', 'REPAIR_PARTS', 'ENTERTAINMENT', 'LOGISTICS', 'OTHER');

-- CreateEnum
CREATE TYPE "expense_status" AS ENUM ('PENDING', 'APPROVED', 'PAID', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "expense_pay_method" AS ENUM ('CASH', 'BANK', 'WECHAT', 'ALIPAY');

-- CreateTable
CREATE TABLE "expense_claims" (
    "id" SERIAL NOT NULL,
    "claim_no" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "store_id" INTEGER,
    "category" "expense_category" NOT NULL,
    "amount_fen" INTEGER NOT NULL,
    "occurred_on" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "status" "expense_status" NOT NULL DEFAULT 'PENDING',
    "approval_request_id" INTEGER,
    "paid_on" DATE,
    "pay_method" "expense_pay_method",
    "pay_note" TEXT,
    "paid_by_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expense_claims_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "expense_claims_claim_no_key" ON "expense_claims"("claim_no");

-- CreateIndex
CREATE UNIQUE INDEX "expense_claims_approval_request_id_key" ON "expense_claims"("approval_request_id");

-- CreateIndex
CREATE INDEX "expense_claims_store_id_paid_on_idx" ON "expense_claims"("store_id", "paid_on");

-- CreateIndex
CREATE INDEX "expense_claims_user_id_created_at_idx" ON "expense_claims"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "expense_claims_status_idx" ON "expense_claims"("status");

-- AddForeignKey
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_paid_by_id_fkey" FOREIGN KEY ("paid_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- 金额 0.01～5 万元；付款信息和“已付款”同进同出
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_amount_check" CHECK ("amount_fen" > 0 AND "amount_fen" <= 5000000);
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_paid_check" CHECK (("status" = 'PAID') = ("paid_on" IS NOT NULL AND "pay_method" IS NOT NULL AND "paid_by_id" IS NOT NULL));
