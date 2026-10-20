-- 延保起算日复查记录项 4（2026-10-20）：延保改成从保修到期次日起算后，按旧到期日生成的到期提醒不作数了，删掉，
-- 新到期日到了每日任务会重新生成。延保在生效日之前不会有提醒（提醒只在到期前 30 天内生成），所以生效日之前建的提醒都是旧的。
DELETE FROM "entitlement_reminders" r
USING "service_entitlements" e, "skus" k
WHERE r."entitlement_id" = e."id"
  AND k."id" = e."sku_id"
  AND k."service_kind" = 'EXTENDED_WARRANTY'
  AND r."created_at" < e."started_on";
