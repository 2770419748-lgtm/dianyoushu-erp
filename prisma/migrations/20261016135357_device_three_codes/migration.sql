-- 大件三个码：imei 列改名为 imei1（可空），新增 sn、imei2，新增主码 code（非空，用 imei1 回填）
ALTER TABLE "devices" RENAME COLUMN "imei" TO "imei1";
ALTER INDEX "devices_imei_key" RENAME TO "devices_imei1_key";
ALTER TABLE "devices" ALTER COLUMN "imei1" DROP NOT NULL;
ALTER TABLE "devices" ADD COLUMN "sn" TEXT;
ALTER TABLE "devices" ADD COLUMN "imei2" TEXT;
ALTER TABLE "devices" ADD COLUMN "code" TEXT;
UPDATE "devices" SET "code" = "imei1";
ALTER TABLE "devices" ALTER COLUMN "code" SET NOT NULL;
CREATE UNIQUE INDEX "devices_code_key" ON "devices"("code");
CREATE UNIQUE INDEX "devices_sn_key" ON "devices"("sn");
CREATE UNIQUE INDEX "devices_imei2_key" ON "devices"("imei2");
