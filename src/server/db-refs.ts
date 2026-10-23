import type { Prisma } from "@/generated/prisma/client";

// 整批删除前查“还有没有单据用着这些记录”（数据导入的撤销用，口径第 22 节，2026-10-23 复查第 72 条）。
// 不能只靠数据库外键挡：机器、客户的外键多数是“删了就置空”，删掉以后盘点单、回收单上的机器、客户会被悄悄清空。
// 用到哪些表从数据库目录里查（以后加了新表也不会漏），一张表一条查询，查到一处就停。

const TABLE_LABELS: Record<string, string> = {
  stocktake_items: "盘点单",
  transfer_items: "调拨单",
  repair_orders: "维修单",
  service_entitlements: "服务权益（碎屏险、延保）",
  return_order_items: "退货单",
  return_orders: "退货单",
  sales_order_items: "销售单",
  sales_orders: "销售单",
  subsidy_claims: "国补单",
  trade_in_orders: "回收单",
  carrier_business: "运营商业务",
  invoices: "发票",
  wecom_follows: "企业微信好友",
  wecom_customer_tags: "企业微信标签",
  wecom_bind_codes: "加企业微信二维码",
  wecom_kf_sessions: "微信客服会话",
  wecom_transfers: "客户继承",
  entitlement_reminders: "到期提醒",
};

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** 返回第一张用着这些记录的表（中文名），没有返回 null；ignore 里的表不算（比如机器自己的库存流水） */
export async function findReferences(tx: Prisma.TransactionClient, table: string, ids: number[], ignore: string[] = []): Promise<string | null> {
  if (ids.length === 0) return null;
  const fks = await tx.$queryRaw<{ tbl: string; col: string }[]>`
    SELECT r.relname AS tbl, a.attname AS col
    FROM pg_constraint c
    JOIN pg_class r ON r.oid = c.conrelid
    JOIN pg_class t ON t.oid = c.confrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    WHERE c.contype = 'f' AND t.relname = ${table} AND n.nspname = 'public' AND array_length(c.conkey, 1) = 1
    ORDER BY r.relname, a.attname`;
  for (const fk of fks) {
    if (ignore.includes(fk.tbl)) continue;
    const hit = await tx.$queryRawUnsafe<{ x: number }[]>(`SELECT 1 AS x FROM ${quote(fk.tbl)} WHERE ${quote(fk.col)} = ANY($1::int[]) LIMIT 1`, ids);
    if (hit.length > 0) return TABLE_LABELS[fk.tbl] ?? fk.tbl;
  }
  return null;
}
