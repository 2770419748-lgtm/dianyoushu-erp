-- 延保改成从保修到期次日起算（2026-10-20 坤总定，口径第 12 节）：已有的延保按新规则重算生效日和到期日。
-- 生效日 = 开单营业日 + 12 个月（月底按当月最后一天，和 src/lib/entitlement.ts 的 addMonthsClamped 一致），到期日 = 生效日 + 服务期限 − 1 天。
-- 只改还是旧规则（生效日 = 营业日）的行，重复执行不会再改。
UPDATE "service_entitlements" e
SET "started_on" = (o."biz_date" + INTERVAL '12 months')::date,
    "expires_on" = ((o."biz_date" + INTERVAL '12 months')::date + make_interval(months => k."service_months") - INTERVAL '1 day')::date
FROM "sales_orders" o, "skus" k
WHERE o."id" = e."sales_order_id"
  AND k."id" = e."sku_id"
  AND k."service_kind" = 'EXTENDED_WARRANTY'
  AND e."started_on" = o."biz_date";
