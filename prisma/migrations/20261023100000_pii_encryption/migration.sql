-- 个人信息加密（口径第 20 节）：手机号、发票接收方从明文换成密文 + 指纹 + 打码号码；回收单加卖家身份。
-- 明文没法在 SQL 里加密（密钥只在应用里），这次之前也没有真实数据，所以直接换列。
-- 库里已经有数据的（本机、演示库）这次迁移会失败并被 Prisma 记为失败：先 prisma migrate resolve --rolled-back 这个迁移，
-- 再 pnpm exec tsx prisma/reset.ts 清空、prisma migrate deploy、pnpm db:reset（直接重跑会报 P3009）。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM customers) OR EXISTS (SELECT 1 FROM carrier_business) OR EXISTS (SELECT 1 FROM carrier_settlement_lines)
     OR EXISTS (SELECT 1 FROM employee_profiles WHERE phone IS NOT NULL) OR EXISTS (SELECT 1 FROM invoices WHERE receiver IS NOT NULL) THEN
    RAISE EXCEPTION '库里已经有手机号明文数据：这是演示库就按顺序跑 pnpm exec prisma migrate resolve --rolled-back 20261023100000_pii_encryption、pnpm exec tsx prisma/reset.ts、pnpm exec prisma migrate deploy、pnpm db:reset；真实数据不能直接迁，先联系开发加密导入';
  END IF;
END $$;

-- DropIndex
DROP INDEX "carrier_business_phone_idx";

-- DropIndex
DROP INDEX "customers_phone_key";

-- AlterTable
ALTER TABLE "carrier_business" DROP COLUMN "phone",
ADD COLUMN     "phone_enc" TEXT NOT NULL,
ADD COLUMN     "phone_fp" TEXT NOT NULL,
ADD COLUMN     "phone_masked" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "carrier_settlement_lines" DROP COLUMN "phone",
ADD COLUMN     "phone_enc" TEXT,
ADD COLUMN     "phone_masked" TEXT;

-- AlterTable
ALTER TABLE "customers" DROP COLUMN "phone",
ADD COLUMN     "phone_enc" TEXT NOT NULL,
ADD COLUMN     "phone_fp" TEXT NOT NULL,
ADD COLUMN     "phone_masked" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "employee_profiles" DROP COLUMN "phone",
ADD COLUMN     "phone_enc" TEXT,
ADD COLUMN     "phone_masked" TEXT;

-- AlterTable
ALTER TABLE "invoices" DROP COLUMN "receiver",
ADD COLUMN     "receiver_enc" TEXT;

-- AlterTable
ALTER TABLE "trade_in_orders" ADD COLUMN     "seller_id_enc" TEXT,
ADD COLUMN     "seller_id_fp" TEXT,
ADD COLUMN     "seller_id_masked" TEXT,
ADD COLUMN     "seller_name" TEXT;

-- CreateIndex
CREATE INDEX "carrier_business_phone_fp_idx" ON "carrier_business"("phone_fp");

-- CreateIndex
CREATE UNIQUE INDEX "customers_phone_fp_key" ON "customers"("phone_fp");

-- CreateIndex
CREATE INDEX "trade_in_orders_seller_id_fp_idx" ON "trade_in_orders"("seller_id_fp");

-- 打码号码只能是“前 3 后 4、中间 *”的样子，防止哪里不小心把明文写进来；密文都带 v1. 前缀
ALTER TABLE "customers" ADD CONSTRAINT "customers_phone_masked_check" CHECK (phone_masked ~ '^1\d{2}\*{4}\d{4}$'),
  ADD CONSTRAINT "customers_phone_enc_check" CHECK (phone_enc LIKE 'v1.%');
ALTER TABLE "carrier_business" ADD CONSTRAINT "carrier_business_phone_masked_check" CHECK (phone_masked ~ '^1\d{2}\*{4}\d{4}$'),
  ADD CONSTRAINT "carrier_business_phone_enc_check" CHECK (phone_enc LIKE 'v1.%');
-- 结算单的号码来自运营商的表格，格式不一定规整：只要求不是一串明文数字
ALTER TABLE "carrier_settlement_lines" ADD CONSTRAINT "carrier_settlement_lines_phone_check"
  CHECK ((phone_enc IS NULL AND phone_masked IS NULL) OR (phone_enc LIKE 'v1.%' AND phone_masked IS NOT NULL AND phone_masked !~ '^\d{7,}$'));
ALTER TABLE "employee_profiles" ADD CONSTRAINT "employee_profiles_phone_check"
  CHECK ((phone_enc IS NULL AND phone_masked IS NULL) OR (phone_enc LIKE 'v1.%' AND phone_masked ~ '^1\d{2}\*{4}\d{4}$'));
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_receiver_enc_check" CHECK (receiver_enc IS NULL OR receiver_enc LIKE 'v1.%');
-- 卖家身份四样一起有或一起没有（老单没有）
ALTER TABLE "trade_in_orders" ADD CONSTRAINT "trade_in_orders_seller_check"
  CHECK ((seller_name IS NULL AND seller_id_enc IS NULL AND seller_id_fp IS NULL AND seller_id_masked IS NULL)
      OR (seller_name IS NOT NULL AND seller_id_enc LIKE 'v1.%' AND seller_id_fp IS NOT NULL AND seller_id_masked ~ '^\d{3}\*{11}[\dX]{4}$'));
