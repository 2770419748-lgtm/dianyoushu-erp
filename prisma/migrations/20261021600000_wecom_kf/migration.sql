-- CreateEnum
CREATE TYPE "wecom_kf_session_state" AS ENUM ('AUTO', 'HUMAN');

-- CreateEnum
CREATE TYPE "wecom_kf_direction" AS ENUM ('IN', 'OUT');

-- CreateTable
CREATE TABLE "wecom_kf_cursors" (
    "open_kfid" TEXT NOT NULL,
    "cursor" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wecom_kf_cursors_pkey" PRIMARY KEY ("open_kfid")
);

-- CreateTable
CREATE TABLE "wecom_kf_sessions" (
    "id" SERIAL NOT NULL,
    "open_kfid" TEXT NOT NULL,
    "external_userid" TEXT NOT NULL,
    "customer_id" INTEGER,
    "state" "wecom_kf_session_state" NOT NULL DEFAULT 'AUTO',
    "last_in_at" TIMESTAMP(3),
    "out_since_in" INTEGER NOT NULL DEFAULT 0,
    "miss_count" INTEGER NOT NULL DEFAULT 0,
    "human_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wecom_kf_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wecom_kf_messages" (
    "id" SERIAL NOT NULL,
    "msgid" TEXT NOT NULL,
    "session_id" INTEGER NOT NULL,
    "direction" "wecom_kf_direction" NOT NULL,
    "msg_type" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "intent" TEXT,
    "delivered" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "sent_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wecom_kf_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "wecom_kf_sessions_updated_at_idx" ON "wecom_kf_sessions"("updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "wecom_kf_sessions_open_kfid_external_userid_key" ON "wecom_kf_sessions"("open_kfid", "external_userid");

-- CreateIndex
CREATE UNIQUE INDEX "wecom_kf_messages_msgid_key" ON "wecom_kf_messages"("msgid");

-- CreateIndex
CREATE INDEX "wecom_kf_messages_session_id_sent_at_idx" ON "wecom_kf_messages"("session_id", "sent_at");

-- CreateIndex
CREATE INDEX "wecom_kf_messages_sent_at_idx" ON "wecom_kf_messages"("sent_at");

-- AddForeignKey
ALTER TABLE "wecom_kf_sessions" ADD CONSTRAINT "wecom_kf_sessions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wecom_kf_messages" ADD CONSTRAINT "wecom_kf_messages_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "wecom_kf_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- 企业微信规定客户每发一次最多回 5 条；连着没听懂的句数不为负
ALTER TABLE "wecom_kf_sessions" ADD CONSTRAINT "wecom_kf_sessions_out_since_in_check" CHECK ("out_since_in" BETWEEN 0 AND 5);
ALTER TABLE "wecom_kf_sessions" ADD CONSTRAINT "wecom_kf_sessions_miss_count_check" CHECK ("miss_count" >= 0);
