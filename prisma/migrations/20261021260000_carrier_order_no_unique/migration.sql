-- 运营商业务复查记录项 4（2026-10-20）：同一运营商没作废的业务里，受理单号不能重复（对账按受理单号对，重复了只能对上一笔）。
-- 服务层先查一遍给好懂的提示，这个部分唯一索引兜两个人同时登记同一个单号的情况。
CREATE UNIQUE INDEX "carrier_business_carrier_order_no_active_key" ON "carrier_business" ("carrier", "carrier_order_no") WHERE "carrier_order_no" IS NOT NULL AND "status" <> 'VOIDED';
