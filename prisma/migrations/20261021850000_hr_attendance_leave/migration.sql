-- CreateEnum
CREATE TYPE "shift_kind" AS ENUM ('MORNING', 'MIDDLE', 'EVENING', 'OFF');

-- CreateEnum
CREATE TYPE "punch_kind" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "leave_kind" AS ENUM ('PERSONAL', 'SICK', 'ANNUAL', 'COMPENSATORY');

-- CreateEnum
CREATE TYPE "oa_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "approval_action" ADD VALUE 'LEAVE';
ALTER TYPE "approval_action" ADD VALUE 'EXPENSE';

-- DropForeignKey
ALTER TABLE "approval_requests" DROP CONSTRAINT "approval_requests_store_id_fkey";

-- AlterTable
ALTER TABLE "approval_requests" ADD COLUMN     "chain" "role"[] DEFAULT ARRAY[]::"role"[],
ADD COLUMN     "step" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "step_log" JSONB,
ALTER COLUMN "store_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "shift_schedules" (
    "id" SERIAL NOT NULL,
    "store_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "shift" "shift_kind" NOT NULL,
    "updated_by_id" INTEGER NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shift_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_punches" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "store_id" INTEGER,
    "date" DATE NOT NULL,
    "kind" "punch_kind" NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "manual" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "created_by_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_punches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_requests" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "store_id" INTEGER,
    "kind" "leave_kind" NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "days" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "oa_status" NOT NULL DEFAULT 'PENDING',
    "approval_request_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leave_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shift_schedules_store_id_date_idx" ON "shift_schedules"("store_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "shift_schedules_user_id_date_key" ON "shift_schedules"("user_id", "date");

-- CreateIndex
CREATE INDEX "attendance_punches_user_id_date_idx" ON "attendance_punches"("user_id", "date");

-- CreateIndex
CREATE INDEX "attendance_punches_store_id_date_idx" ON "attendance_punches"("store_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "leave_requests_approval_request_id_key" ON "leave_requests"("approval_request_id");

-- CreateIndex
CREATE INDEX "leave_requests_user_id_start_date_idx" ON "leave_requests"("user_id", "start_date");

-- CreateIndex
CREATE INDEX "leave_requests_store_id_start_date_idx" ON "leave_requests"("store_id", "start_date");

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_schedules" ADD CONSTRAINT "shift_schedules_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_punches" ADD CONSTRAINT "attendance_punches_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- 只有 OA 事项（请假、报销）能不挂门店；第几级不超过审批链长度；请假天数和日期对得上；补录要写原因
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_store_check" CHECK ("store_id" IS NOT NULL OR "action"::text IN ('LEAVE', 'EXPENSE'));
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_step_check" CHECK ("step" >= 1 AND "step" <= GREATEST(1, cardinality("chain")));
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_days_check" CHECK ("end_date" >= "start_date" AND "days" = ("end_date" - "start_date" + 1));
ALTER TABLE "attendance_punches" ADD CONSTRAINT "attendance_punches_manual_check" CHECK (NOT "manual" OR "note" IS NOT NULL);

-- AddForeignKey
ALTER TABLE "shift_schedules" ADD CONSTRAINT "shift_schedules_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_punches" ADD CONSTRAINT "attendance_punches_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_punches" ADD CONSTRAINT "attendance_punches_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE SET NULL ON UPDATE CASCADE;

