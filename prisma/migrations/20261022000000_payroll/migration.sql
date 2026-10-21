-- CreateEnum
CREATE TYPE "payroll_status" AS ENUM ('DRAFT', 'PUBLISHED', 'VOIDED');

-- AlterTable
ALTER TABLE "employee_profiles" ADD COLUMN     "commission_plan_id" INTEGER;

-- CreateTable
CREATE TABLE "commission_plans" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "sales_rate_bp" INTEGER NOT NULL DEFAULT 0,
    "per_device_fen" INTEGER NOT NULL DEFAULT 0,
    "per_service_fen" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "commission_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_runs" (
    "id" SERIAL NOT NULL,
    "month" TEXT NOT NULL,
    "status" "payroll_status" NOT NULL DEFAULT 'DRAFT',
    "slip_count" INTEGER NOT NULL DEFAULT 0,
    "gross_fen" INTEGER NOT NULL DEFAULT 0,
    "generated_by_id" INTEGER NOT NULL,
    "generated_at" TIMESTAMP(3) NOT NULL,
    "published_by_id" INTEGER,
    "published_at" TIMESTAMP(3),
    "voided_by_id" INTEGER,
    "voided_at" TIMESTAMP(3),
    "void_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_slips" (
    "id" SERIAL NOT NULL,
    "run_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "store_id" INTEGER,
    "plan_name" TEXT,
    "base_salary_fen" INTEGER NOT NULL,
    "days_in_month" INTEGER NOT NULL,
    "employed_days" INTEGER NOT NULL,
    "base_fen" INTEGER NOT NULL,
    "absent_days" INTEGER NOT NULL,
    "absence_deduction_fen" INTEGER NOT NULL,
    "sales_fen" INTEGER NOT NULL,
    "device_qty" INTEGER NOT NULL,
    "service_qty" INTEGER NOT NULL,
    "sales_commission_fen" INTEGER NOT NULL,
    "device_commission_fen" INTEGER NOT NULL,
    "service_commission_fen" INTEGER NOT NULL,
    "commission_fen" INTEGER NOT NULL,
    "adjustment_fen" INTEGER NOT NULL DEFAULT 0,
    "adjustment_note" TEXT,
    "gross_fen" INTEGER NOT NULL,
    "store_days" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_slips_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "commission_plans_name_key" ON "commission_plans"("name");

-- CreateIndex
CREATE INDEX "payroll_runs_month_idx" ON "payroll_runs"("month");

-- CreateIndex
CREATE INDEX "payroll_slips_user_id_idx" ON "payroll_slips"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_slips_run_id_user_id_key" ON "payroll_slips"("run_id", "user_id");

-- AddForeignKey
ALTER TABLE "employee_profiles" ADD CONSTRAINT "employee_profiles_commission_plan_id_fkey" FOREIGN KEY ("commission_plan_id") REFERENCES "commission_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_slips" ADD CONSTRAINT "payroll_slips_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "payroll_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_slips" ADD CONSTRAINT "payroll_slips_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_slips" ADD CONSTRAINT "payroll_slips_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- 同一个月只能有一份没作废的工资；月份 YYYY-MM；发布了要有发布人和时间、作废了要有原因
CREATE UNIQUE INDEX "payroll_runs_one_open_per_month" ON "payroll_runs"("month") WHERE "status" <> 'VOIDED';
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_month_check" CHECK ("month" ~ '^\d{4}-(0[1-9]|1[0-2])$');
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_published_check" CHECK (("status" = 'DRAFT') OR ("published_at" IS NOT NULL OR "status" = 'VOIDED'));
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_voided_check" CHECK (("status" = 'VOIDED') = ("voided_at" IS NOT NULL AND "void_reason" IS NOT NULL));
-- 工资条的数对得上：提成 = 三样之和，应发 = 折算后基本工资 + 提成 − 缺勤扣款 + 奖惩；奖惩不为 0 要写原因
ALTER TABLE "payroll_slips" ADD CONSTRAINT "payroll_slips_commission_check" CHECK ("commission_fen" = "sales_commission_fen" + "device_commission_fen" + "service_commission_fen");
ALTER TABLE "payroll_slips" ADD CONSTRAINT "payroll_slips_gross_check" CHECK ("gross_fen" = "base_fen" + "commission_fen" - "absence_deduction_fen" + "adjustment_fen");
ALTER TABLE "payroll_slips" ADD CONSTRAINT "payroll_slips_adjustment_check" CHECK ("adjustment_fen" = 0 OR "adjustment_note" IS NOT NULL);
ALTER TABLE "payroll_slips" ADD CONSTRAINT "payroll_slips_days_check" CHECK ("employed_days" BETWEEN 0 AND "days_in_month" AND "absent_days" >= 0 AND "base_fen" >= 0 AND "absence_deduction_fen" >= 0);
-- 提成方案：比例 0～100%，每台、每份不为负
ALTER TABLE "commission_plans" ADD CONSTRAINT "commission_plans_values_check" CHECK ("sales_rate_bp" BETWEEN 0 AND 10000 AND "per_device_fen" >= 0 AND "per_service_fen" >= 0);
