-- 开户的管理员、总部新建或重置过密码的人：下次登录先改密码（口径第 21 节）
-- AlterTable
ALTER TABLE "users" ADD COLUMN     "must_change_password" BOOLEAN NOT NULL DEFAULT false;

