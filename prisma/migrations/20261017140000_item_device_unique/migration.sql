-- 一台机器在一次盘点、一张调拨单里只能有一行（2026-10-17 复查）。配件行 device_id 为空，PostgreSQL 唯一索引里空值互不冲突，不受影响。

-- CreateIndex
CREATE UNIQUE INDEX "stocktake_items_stocktake_id_device_id_key" ON "stocktake_items"("stocktake_id", "device_id");

-- CreateIndex
CREATE UNIQUE INDEX "transfer_items_transfer_id_device_id_key" ON "transfer_items"("transfer_id", "device_id");

