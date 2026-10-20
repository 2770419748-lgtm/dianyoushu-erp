-- 审批（2026-10-20，口径第 17 节）：审批规则（默认全关）、审批单。

-- CreateEnum
CREATE TYPE "approval_rule_kind" AS ENUM ('SALE_DISCOUNT', 'SALE_BELOW_COST', 'RETURN_REFUND', 'SALE_VOID', 'TRANSFER', 'STOCKTAKE_LOSS');

-- CreateEnum
CREATE TYPE "approval_action" AS ENUM ('SALE', 'RETURN', 'SALE_VOID', 'TRANSFER', 'STOCKTAKE');

-- CreateEnum
CREATE TYPE "approval_status" AS ENUM ('PENDING', 'EXECUTED', 'FAILED', 'REJECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "approval_rules" (
    "id" SERIAL NOT NULL,
    "kind" "approval_rule_kind" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "threshold_fen" INTEGER,
    "threshold_bp" INTEGER,
    "approver_role" "role" NOT NULL,
    "note" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approval_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_requests" (
    "id" SERIAL NOT NULL,
    "request_no" TEXT NOT NULL,
    "action" "approval_action" NOT NULL,
    "store_id" INTEGER NOT NULL,
    "requested_by_id" INTEGER NOT NULL,
    "approver_role" "role" NOT NULL,
    "status" "approval_status" NOT NULL DEFAULT 'PENDING',
    "summary" TEXT NOT NULL,
    "reasons" JSONB NOT NULL,
    "amount_fen" INTEGER NOT NULL,
    "note" TEXT,
    "payload" JSONB NOT NULL,
    "dedupe_key" TEXT,
    "decided_by_id" INTEGER,
    "decided_at" TIMESTAMP(3),
    "decision_note" TEXT,
    "result_id" INTEGER,
    "result_no" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "approval_rules_kind_key" ON "approval_rules"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "approval_requests_request_no_key" ON "approval_requests"("request_no");

-- CreateIndex
CREATE INDEX "approval_requests_status_approver_role_idx" ON "approval_requests"("status", "approver_role");

-- CreateIndex
CREATE INDEX "approval_requests_store_id_created_at_idx" ON "approval_requests"("store_id", "created_at");

-- CreateIndex
CREATE INDEX "approval_requests_requested_by_id_idx" ON "approval_requests"("requested_by_id");

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;



-- 数据库兜底的约束（schema.prisma 写不了 CHECK 和部分唯一索引）
ALTER TABLE "approval_rules" ADD CONSTRAINT "approval_rules_values" CHECK (COALESCE("threshold_fen", 0) >= 0 AND COALESCE("threshold_bp", 0) BETWEEN 0 AND 10000 AND "approver_role" IN ('STORE_MANAGER', 'HQ'));
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_values" CHECK ("amount_fen" >= 0 AND "approver_role" IN ('STORE_MANAGER', 'HQ'));
-- 同一件事（同一张盘点单、同一张销售单的作废）同时只能有一张待审批
CREATE UNIQUE INDEX "approval_requests_one_pending" ON "approval_requests" ("dedupe_key") WHERE "status" = 'PENDING' AND "dedupe_key" IS NOT NULL;
