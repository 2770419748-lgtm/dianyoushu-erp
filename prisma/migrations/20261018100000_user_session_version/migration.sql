-- 用户会话版本号（2026-10-18 复审）：改密码、总部重置密码、停用 / 启用时 +1，之前签发的登录令牌立刻作废。
-- 旧令牌里没有版本号，按 0 算，和默认值一致，所以上线这条迁移不会把在线的人踢下线。
ALTER TABLE "users" ADD COLUMN "session_version" INTEGER NOT NULL DEFAULT 0;
