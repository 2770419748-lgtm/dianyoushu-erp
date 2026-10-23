-- 系统设置（一家一套部署的全局设置，一项一行）：先放个人信息钥匙核对记录（口径第 20 节），以后公司信息、试用到期也放这里
-- CreateTable
CREATE TABLE "system_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("key")
);

