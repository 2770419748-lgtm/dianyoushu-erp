-- 2026-10-17 全面自检后的修复。

-- 销售明细记开单时的原价（门店售价），和成交单价不同就是改过价；旧数据为空
ALTER TABLE "sales_order_items" ADD COLUMN "list_price_fen" INTEGER;

-- 已到 / 已收数量在 0 到应到数量之间（防并发时重复入库、重复收货；业务代码在锁内已检查，这里兜底）
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_received_qty_range" CHECK ("received_qty" >= 0 AND "received_qty" <= "qty");
ALTER TABLE "transfer_items" ADD CONSTRAINT "transfer_items_received_qty_range" CHECK ("received_qty" >= 0 AND "received_qty" <= "qty");
