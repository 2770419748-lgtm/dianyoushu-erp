-- CreateEnum
CREATE TYPE "notice_scope" AS ENUM ('ALL', 'REGION', 'STORE');

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "notice_id" INTEGER;

-- CreateTable
CREATE TABLE "employee_profiles" (
    "user_id" INTEGER NOT NULL,
    "hire_date" DATE,
    "position" TEXT,
    "phone" TEXT,
    "base_salary_fen" INTEGER NOT NULL DEFAULT 0,
    "leave_date" DATE,
    "note" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_profiles_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "notices" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "scope" "notice_scope" NOT NULL,
    "region_id" INTEGER,
    "store_id" INTEGER,
    "author_id" INTEGER NOT NULL,
    "recipients" INTEGER NOT NULL DEFAULT 0,
    "withdrawn_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notice_reads" (
    "notice_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "read_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notice_reads_pkey" PRIMARY KEY ("notice_id","user_id")
);

-- CreateIndex
CREATE INDEX "notices_created_at_idx" ON "notices"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_user_id_notice_id_key" ON "notifications"("user_id", "notice_id");

-- AddForeignKey
ALTER TABLE "employee_profiles" ADD CONSTRAINT "employee_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notices" ADD CONSTRAINT "notices_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notice_reads" ADD CONSTRAINT "notice_reads_notice_id_fkey" FOREIGN KEY ("notice_id") REFERENCES "notices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notice_reads" ADD CONSTRAINT "notice_reads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_notice_id_fkey" FOREIGN KEY ("notice_id") REFERENCES "notices"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- 基本工资不为负；公告的范围和区域、门店对得上；一条消息要么是今日待办、要么是公告
ALTER TABLE "employee_profiles" ADD CONSTRAINT "employee_profiles_salary_check" CHECK ("base_salary_fen" >= 0);
ALTER TABLE "notices" ADD CONSTRAINT "notices_scope_check" CHECK (("scope" = 'REGION') = ("region_id" IS NOT NULL) AND ("scope" = 'STORE') = ("store_id" IS NOT NULL));
ALTER TABLE "notices" ADD CONSTRAINT "notices_recipients_check" CHECK ("recipients" >= 0);
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_source_check" CHECK (NOT ("digest_id" IS NOT NULL AND "notice_id" IS NOT NULL));
