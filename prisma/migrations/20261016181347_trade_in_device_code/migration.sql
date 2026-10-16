-- 回收单旧机字段改名：imei -> device_code（存旧机主码，规则同 devices.code）
ALTER TABLE "trade_in_orders" RENAME COLUMN "imei" TO "device_code";
