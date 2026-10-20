-- 国补复查记录项 1（2026-10-20）：一个资格码只能补一台。服务层先查一遍给好懂的提示，
-- 两家店同时用同一个码时都查不到，这个部分唯一索引兜底（撤销、已退回的不占码）。
CREATE UNIQUE INDEX "subsidy_claims_code_active_key" ON "subsidy_claims" ("qualification_code") WHERE "status" NOT IN ('CANCELLED', 'RETURNED');
