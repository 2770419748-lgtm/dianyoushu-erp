-- CreateEnum
CREATE TYPE "fixed_expense_category" AS ENUM ('RENT', 'UTILITIES', 'PROPERTY', 'OTHER');

-- CreateTable
CREATE TABLE "store_fixed_expenses" (
    "id" SERIAL NOT NULL,
    "store_id" INTEGER NOT NULL,
    "month" TEXT NOT NULL,
    "category" "fixed_expense_category" NOT NULL,
    "amount_fen" INTEGER NOT NULL,
    "note" TEXT,
    "updated_by_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "store_fixed_expenses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "store_fixed_expenses_month_idx" ON "store_fixed_expenses"("month");

-- CreateIndex
CREATE UNIQUE INDEX "store_fixed_expenses_store_id_month_category_key" ON "store_fixed_expenses"("store_id", "month", "category");

-- AddForeignKey
ALTER TABLE "store_fixed_expenses" ADD CONSTRAINT "store_fixed_expenses_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- 金额 0～10 万元；月份 YYYY-MM
ALTER TABLE "store_fixed_expenses" ADD CONSTRAINT "store_fixed_expenses_amount_check" CHECK ("amount_fen" >= 0 AND "amount_fen" <= 10000000);
ALTER TABLE "store_fixed_expenses" ADD CONSTRAINT "store_fixed_expenses_month_check" CHECK ("month" ~ '^\d{4}-(0[1-9]|1[0-2])$');
