-- 退了机器、没退服务时，在权益上记“机器已退回”（2026-10-20 自检复查）：机器回库后可能再卖给别人，不能一台机器挂两个客户的有效保障。
ALTER TABLE "service_entitlements" ADD COLUMN "device_returned_at" TIMESTAMP(3);
