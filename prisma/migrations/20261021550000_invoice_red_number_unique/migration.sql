-- 红字发票号码也不能重复（发票复查记录项 3）：和发票号码一样用部分唯一索引兜底；
-- 发票号和红字号互相撞号由服务层按号码排队检查，对账自检第 10 类也查。
CREATE UNIQUE INDEX "invoices_red_number_key" ON "invoices" ("red_number") WHERE "red_number" IS NOT NULL;
