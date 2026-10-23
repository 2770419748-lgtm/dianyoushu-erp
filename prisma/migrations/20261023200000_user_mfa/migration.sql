-- 二次验证（口径第 20 节）：店长及以上用手机验证器 App 的 6 位动态码登录
-- AlterTable
ALTER TABLE "users" ADD COLUMN     "mfa_enabled_at" TIMESTAMP(3),
ADD COLUMN     "mfa_last_step" INTEGER,
ADD COLUMN     "mfa_secret_enc" TEXT;


-- 二次验证（口径第 20 节）：密钥只能是密文；开启了就一定有密钥
ALTER TABLE "users" ADD CONSTRAINT "users_mfa_check"
  CHECK ((mfa_secret_enc IS NULL OR mfa_secret_enc LIKE 'v1.%') AND (mfa_enabled_at IS NULL OR mfa_secret_enc IS NOT NULL));
