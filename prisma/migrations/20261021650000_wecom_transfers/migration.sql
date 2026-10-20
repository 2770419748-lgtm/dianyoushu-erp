-- CreateEnum
CREATE TYPE "wecom_transfer_kind" AS ENUM ('ON_JOB', 'RESIGNED');

-- CreateEnum
CREATE TYPE "wecom_transfer_status" AS ENUM ('WAITING_DELETE', 'SUBMITTED', 'DONE', 'REFUSED', 'FAILED');

-- CreateTable
CREATE TABLE "wecom_transfers" (
    "id" SERIAL NOT NULL,
    "kind" "wecom_transfer_kind" NOT NULL,
    "follow_id" INTEGER NOT NULL,
    "external_userid" TEXT NOT NULL,
    "customer_id" INTEGER,
    "from_user_id" INTEGER,
    "from_wecom_userid" TEXT NOT NULL,
    "to_user_id" INTEGER NOT NULL,
    "to_wecom_userid" TEXT NOT NULL,
    "status" "wecom_transfer_status" NOT NULL,
    "created_by_id" INTEGER NOT NULL,
    "submitted_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wecom_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "wecom_transfers_status_idx" ON "wecom_transfers"("status");

-- CreateIndex
CREATE INDEX "wecom_transfers_external_userid_created_at_idx" ON "wecom_transfers"("external_userid", "created_at");

-- CreateIndex
CREATE INDEX "wecom_transfers_from_user_id_idx" ON "wecom_transfers"("from_user_id");

-- AddForeignKey
ALTER TABLE "wecom_transfers" ADD CONSTRAINT "wecom_transfers_follow_id_fkey" FOREIGN KEY ("follow_id") REFERENCES "wecom_follows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wecom_transfers" ADD CONSTRAINT "wecom_transfers_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wecom_transfers" ADD CONSTRAINT "wecom_transfers_from_user_id_fkey" FOREIGN KEY ("from_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wecom_transfers" ADD CONSTRAINT "wecom_transfers_to_user_id_fkey" FOREIGN KEY ("to_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wecom_transfers" ADD CONSTRAINT "wecom_transfers_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- 同一条跟进关系同时只能有一个没办完的继承（等删除成员、已提交）
CREATE UNIQUE INDEX "wecom_transfers_one_open_per_follow" ON "wecom_transfers"("follow_id") WHERE "status" IN ('WAITING_DELETE', 'SUBMITTED');
-- 接手人不能是原跟进人；提交过的才有提交时间，办完的才有完成时间
ALTER TABLE "wecom_transfers" ADD CONSTRAINT "wecom_transfers_not_self_check" CHECK ("from_wecom_userid" <> "to_wecom_userid");
ALTER TABLE "wecom_transfers" ADD CONSTRAINT "wecom_transfers_submitted_check" CHECK (("status" = 'WAITING_DELETE') OR ("status" = 'FAILED') OR ("submitted_at" IS NOT NULL));
ALTER TABLE "wecom_transfers" ADD CONSTRAINT "wecom_transfers_finished_check" CHECK (("status" IN ('WAITING_DELETE', 'SUBMITTED')) = ("finished_at" IS NULL));
