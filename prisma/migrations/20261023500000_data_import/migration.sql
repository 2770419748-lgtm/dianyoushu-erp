
-- CreateEnum
CREATE TYPE "import_kind" AS ENUM ('STORES', 'USERS', 'PRODUCTS', 'DEVICES', 'ACCESSORIES', 'CUSTOMERS');

-- CreateEnum
CREATE TYPE "import_status" AS ENUM ('DONE', 'REVOKED');

-- AlterEnum
ALTER TYPE "ledger_doc_type" ADD VALUE 'OPENING';

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "import_batch_id" INTEGER;

-- CreateTable
CREATE TABLE "import_batches" (
    "id" SERIAL NOT NULL,
    "batch_no" TEXT NOT NULL,
    "kind" "import_kind" NOT NULL,
    "status" "import_status" NOT NULL DEFAULT 'DONE',
    "file_name" TEXT,
    "row_count" INTEGER NOT NULL,
    "created_count" INTEGER NOT NULL,
    "summary" JSONB,
    "created_by_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_by_id" INTEGER,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "import_batches_batch_no_key" ON "import_batches"("batch_no");

-- CreateIndex
CREATE INDEX "import_batches_kind_created_at_idx" ON "import_batches"("kind", "created_at");

-- CreateIndex
CREATE INDEX "customers_import_batch_id_idx" ON "customers"("import_batch_id");

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "import_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_revoked_by_id_fkey" FOREIGN KEY ("revoked_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- 数据导入（口径第 22 节）：条数不为负、新建的不多于表里的行数；撤销的要记谁、什么时候撤的
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_counts_check" CHECK ("row_count" >= 0 AND "created_count" >= 0 AND "created_count" <= "row_count");
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_revoked_check" CHECK (("status" = 'REVOKED') = ("revoked_at" IS NOT NULL AND "revoked_by_id" IS NOT NULL));
