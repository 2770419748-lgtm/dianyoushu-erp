-- 数据库兜底的检查约束（2026-10-17 代码审查）。业务代码已经先检查一遍，这三条是并发或代码出错时的最后一道防线。
-- Prisma 的 schema 写不了 CHECK 约束，所以只在迁移里加；schema.prisma 对应字段旁有注释。

-- 配件余额不能是负数（防超卖）
ALTER TABLE "accessory_stocks" ADD CONSTRAINT "accessory_stocks_qty_nonnegative" CHECK ("qty" >= 0);

-- 一条收款明细要么属于销售单、要么属于退货单，必须且只能二选一
ALTER TABLE "payments" ADD CONSTRAINT "payments_one_owner" CHECK (("sales_order_id" IS NULL) <> ("return_order_id" IS NULL));

-- 销售明细的已退数量在 0 到售出数量之间（防同一行退两次）
ALTER TABLE "sales_order_items" ADD CONSTRAINT "sales_order_items_returned_qty_range" CHECK ("returned_qty" >= 0 AND "returned_qty" <= "qty");
