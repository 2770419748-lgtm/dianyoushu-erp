import type { PrismaClient } from "../src/generated/prisma/client";

// 对账自检：账对得上，数字才可信。模拟数据生成完会跑一遍；上线后每天跑一遍（pnpm db:check），对不上要告警。
// 1. 配件余额 = 这家店这个配件所有流水的累计（余额永远能从流水算出来），也等于最后一条流水记的变动后余额；有流水就要有余额行
// 2. 每家店在库机器数 = 机器流水的累计（在库、良品、回收、锁定都算在店里；在途的已经从发出店减掉）
// 3. 每张销售单的收款合计 = 应收（作废的单收款也还在，合计照样相等）
// 4. 已确认的日结，每种收款方式的系统数 = 当天这家店的收款汇总（销售收款 + 退货退款）
//    只查已确认的：没确认的日结白天还在开单，系统数会变，不算对不上。
// 5. 每台机器：状态和归属店 = 它最后一条流水记的状态和门店；没有流水的机器不该存在；
//    "已售"的机器要有一张没退的有效销售单，反过来不是"已售"的机器不该挂着没退的有效销售单
//    （例外：卖出去之后又被回收单收回来的，看那之后有没有回收入库流水）。
// 6. 服务权益：每个服务行有且只有一条权益；单作废了或服务退了，权益就该失效，反过来也一样（已理赔的算没失效）；
//    权益的门店、客户和销售单一致；保的机器退了、服务没退的要记“机器已退回”；服务类商品不该有库存余额和流水；
//    “已理赔”的碎屏险要有一张修好、用碎屏险付、已完结的维修单。
// 7. 维修单（口径第 13 节）：已完结的收款合计 = 客户应付，没完结的没有收款；作废、没完结的不该算营业日。
// 8. 运营商结算（口径第 14 节）：结算单的行数、对上 / 不符 / 没登记的笔数、佣金和扣回合计 = 它的明细；
//    “已结算”的业务要挂在一张结算单上、有实收，且那张单里有一行对上它；“已返销”的要有扣回金额；没结算过的不该有实收；
//    一笔业务最多在一行里拿佣金、最多被返销一次（并发对账把同一笔算两次就会被抓出来）。
// 9. 国补（口径第 15 节）：每张销售单的“国补立减”收款 = 它的国补单补贴合计；国补单的门店、客户、机器和销售单一致；
//    单作废了、机器退了，国补单要撤销（到账了的是需退回、已退回），反过来没作废没退的不该撤销；到账的要有到账金额，没到账的不该有。
// 10. 发票（口径第 16 节）：价税合计、税额 = 明细合计，明细都是这张销售单的商品，门店和销售单一致；
//     作废的单不该有待开票、已开票的；申请之后又退了货的，不该还是待开票、已开票（要撤回、红冲）；开了的要有号码和开具时间，红冲了的要有红字号码。
// 11. 审批单（口径第 17 节）：已通过的要有审批人、时间和做出来的单据，开单审批做出来的销售单是同一家店的；没做成的要有原因；
//     驳回的要有原因；待审批、撤回的不该有审批人和结果。
// 12. 企业微信（口径第 12 节第三步）：好友关系、客服会话认的客户，这个客户绑的微信要就是这个；接替完毕的继承，接手人名下要有这条好友关系；
//     继承的原跟进关系要是这个客户的；客服会话里“客户发消息后回了几条”不超过 5。
// 13. 人事 OA（口径第 19 节）：请假单、报销单和它的审批单对得上（审批中↔待审批，已批（待付款、已付款）↔已通过且做出来的就是这张单，驳回↔驳回，撤回↔撤回或批了没做成）；
//     同一个人审批中、已批的假日期不重叠；两级审批还在批的，前面几级的记录条数 = 现在是第几级 − 1。

export interface IntegrityResult {
  accessory: number;
  device: number;
  payment: number;
  dailyClose: number;
  deviceState: number;
  entitlement: number;
  repair: number;
  carrier: number;
  subsidy: number;
  invoice: number;
  approval: number;
  wecom: number;
  hr: number;
}

export async function runIntegrityChecks(prisma: PrismaClient): Promise<IntegrityResult> {
  const [accessory] = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*)::bigint AS n FROM accessory_stocks a
    LEFT JOIN (SELECT store_id, sku_id, SUM(qty_delta) AS s FROM stock_ledgers WHERE device_id IS NULL GROUP BY store_id, sku_id) l
      ON l.store_id = a.store_id AND l.sku_id = a.sku_id
    WHERE a.qty <> COALESCE(l.s, 0)`;
  const [accessoryLast] = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*)::bigint AS n FROM accessory_stocks a
    JOIN (SELECT DISTINCT ON (store_id, sku_id) store_id, sku_id, balance_after FROM stock_ledgers WHERE device_id IS NULL ORDER BY store_id, sku_id, id DESC) l
      ON l.store_id = a.store_id AND l.sku_id = a.sku_id
    WHERE l.balance_after IS DISTINCT FROM a.qty`;
  const [accessoryOrphan] = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*)::bigint AS n FROM (SELECT DISTINCT store_id, sku_id FROM stock_ledgers WHERE device_id IS NULL) l
    WHERE NOT EXISTS (SELECT 1 FROM accessory_stocks a WHERE a.store_id = l.store_id AND a.sku_id = l.sku_id)`;
  const [device] = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*)::bigint AS n FROM (
      SELECT store_id, COUNT(*) AS c FROM devices WHERE status IN ('IN_STOCK','REFURBISHED','RECYCLED','LOCKED') GROUP BY store_id
    ) d FULL JOIN (
      SELECT store_id, SUM(qty_delta) AS s FROM stock_ledgers WHERE device_id IS NOT NULL GROUP BY store_id
    ) l ON l.store_id = d.store_id
    WHERE COALESCE(d.c, 0) <> COALESCE(l.s, 0)`;
  const [payment] = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*)::bigint AS n FROM sales_orders o
    JOIN (SELECT sales_order_id, SUM(amount_fen) AS s FROM payments WHERE sales_order_id IS NOT NULL GROUP BY sales_order_id) p ON p.sales_order_id = o.id
    WHERE o.total_fen <> p.s`;
  const closeRows = await prisma.$queryRaw<{ id: number }[]>`
    SELECT l.id FROM daily_close_lines l
    JOIN daily_closes c ON c.id = l.daily_close_id AND c.status = 'CONFIRMED'
    LEFT JOIN (
      SELECT o.store_id, o.biz_date, p.method, SUM(p.amount_fen) AS s FROM payments p JOIN sales_orders o ON o.id = p.sales_order_id WHERE o.status = 'COMPLETED' GROUP BY 1, 2, 3
      UNION ALL
      SELECT r.store_id, r.biz_date, p.method, SUM(p.amount_fen) FROM payments p JOIN return_orders r ON r.id = p.return_order_id GROUP BY 1, 2, 3
      UNION ALL
      SELECT w.store_id, w.biz_date, p.method, SUM(p.amount_fen) FROM payments p JOIN repair_orders w ON w.id = p.repair_order_id WHERE w.status = 'CLOSED' GROUP BY 1, 2, 3
    ) x ON x.store_id = c.store_id AND x.biz_date = c.biz_date AND x.method = l.method
    GROUP BY l.id, l.system_fen
    HAVING l.system_fen <> COALESCE(SUM(x.s), 0)`;
  const [deviceLedger] = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*)::bigint AS n FROM devices d
    LEFT JOIN (SELECT DISTINCT ON (device_id) device_id, status_after, store_id FROM stock_ledgers WHERE device_id IS NOT NULL ORDER BY device_id, id DESC) x
      ON x.device_id = d.id
    WHERE x.device_id IS NULL OR x.status_after IS DISTINCT FROM d.status OR x.store_id <> d.store_id`;
  const [deviceSale] = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*)::bigint AS n FROM devices d
    WHERE (d.status = 'SOLD' AND NOT EXISTS (
        SELECT 1 FROM sales_order_items si JOIN sales_orders o ON o.id = si.order_id
        WHERE si.device_id = d.id AND o.status = 'COMPLETED' AND si.returned_qty < si.qty))
      OR (d.status <> 'SOLD' AND EXISTS (
        SELECT 1 FROM sales_order_items si JOIN sales_orders o ON o.id = si.order_id
        WHERE si.device_id = d.id AND o.status = 'COMPLETED' AND si.returned_qty < si.qty
          AND NOT EXISTS (SELECT 1 FROM stock_ledgers l WHERE l.device_id = d.id AND l.doc_type = 'TRADE_IN' AND l.created_at > o.created_at)))`;
  const [entitlement] = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT (
      (SELECT COUNT(*) FROM sales_order_items si JOIN skus k ON k.id = si.sku_id
        WHERE k.is_service AND NOT EXISTS (SELECT 1 FROM service_entitlements e WHERE e.sales_order_item_id = si.id))
      + (SELECT COUNT(*) FROM service_entitlements e
        JOIN sales_order_items si ON si.id = e.sales_order_item_id
        JOIN sales_orders o ON o.id = e.sales_order_id
        WHERE si.order_id <> e.sales_order_id
          OR (e.status = 'VOIDED') = (o.status = 'COMPLETED' AND si.returned_qty < si.qty)
          OR e.store_id <> o.store_id OR e.customer_id IS DISTINCT FROM o.customer_id)
      + (SELECT COUNT(*) FROM service_entitlements e
        JOIN sales_order_items di ON di.order_id = e.sales_order_id AND di.device_id = e.device_id
        WHERE e.status = 'ACTIVE' AND di.returned_qty > 0 AND e.device_returned_at IS NULL)
      + (SELECT COUNT(*) FROM service_entitlements e WHERE e.status = 'CLAIMED' AND NOT EXISTS (
          SELECT 1 FROM repair_orders r WHERE r.entitlement_id = e.id AND r.status = 'CLOSED' AND r.outcome = 'REPAIRED' AND r.payer = 'SCREEN_INSURANCE'))
      + (SELECT COUNT(*) FROM stock_ledgers l JOIN skus k ON k.id = l.sku_id WHERE k.is_service)
      + (SELECT COUNT(*) FROM accessory_stocks a JOIN skus k ON k.id = a.sku_id WHERE k.is_service)
    )::bigint AS n`;
  const [repair] = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT (
      (SELECT COUNT(*) FROM repair_orders r
        LEFT JOIN (SELECT repair_order_id, SUM(amount_fen) AS s FROM payments WHERE repair_order_id IS NOT NULL GROUP BY repair_order_id) p ON p.repair_order_id = r.id
        WHERE (r.status = 'CLOSED' AND COALESCE(p.s, 0) <> r.charge_fen)
          OR (r.status <> 'CLOSED' AND p.s IS NOT NULL)
          OR ((r.status = 'CLOSED') <> (r.biz_date IS NOT NULL)))
    )::bigint AS n`;
  const [carrier] = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT (
      (SELECT COUNT(*) FROM carrier_settlements s
        LEFT JOIN (SELECT settlement_id, COUNT(*) AS c,
            COUNT(*) FILTER (WHERE result = 'MATCHED') AS m, COUNT(*) FILTER (WHERE result = 'DIFF') AS d, COUNT(*) FILTER (WHERE result = 'UNMATCHED') AS u,
            SUM(commission_fen) AS cf, SUM(clawback_fen) AS kf
          FROM carrier_settlement_lines GROUP BY settlement_id) l ON l.settlement_id = s.id
        WHERE s.line_count <> COALESCE(l.c, 0) OR s.matched_count <> COALESCE(l.m, 0) OR s.diff_count <> COALESCE(l.d, 0) OR s.unmatched_count <> COALESCE(l.u, 0)
          OR s.total_commission_fen <> COALESCE(l.cf, 0) OR s.total_clawback_fen <> COALESCE(l.kf, 0))
      + (SELECT COUNT(*) FROM carrier_business b
        WHERE (b.status = 'SETTLED' AND (b.settlement_id IS NULL OR b.settled_fen IS NULL OR NOT EXISTS (
            SELECT 1 FROM carrier_settlement_lines l WHERE l.settlement_id = b.settlement_id AND l.business_id = b.id AND l.result IN ('MATCHED', 'DIFF') AND l.commission_fen = b.settled_fen)))
          OR (b.status = 'CLAWED_BACK' AND COALESCE(b.clawback_fen, 0) <= 0)
          OR (b.status NOT IN ('SETTLED', 'CLAWED_BACK') AND (b.settlement_id IS NOT NULL OR b.settled_fen IS NOT NULL OR b.clawback_fen IS NOT NULL)))
      + (SELECT COUNT(*) FROM (SELECT business_id FROM carrier_settlement_lines WHERE business_id IS NOT NULL AND result IN ('MATCHED', 'DIFF') AND clawback_fen = 0 GROUP BY business_id HAVING COUNT(*) > 1) dup_commission)
      + (SELECT COUNT(*) FROM (SELECT business_id FROM carrier_settlement_lines WHERE business_id IS NOT NULL AND clawback_fen > 0 GROUP BY business_id HAVING COUNT(*) > 1) dup_clawback)
    )::bigint AS n`;
  const [subsidy] = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT (
      (SELECT COUNT(*) FROM sales_orders o
        LEFT JOIN (SELECT sales_order_id, SUM(amount_fen) AS s FROM payments WHERE method = 'SUBSIDY' AND sales_order_id IS NOT NULL GROUP BY sales_order_id) p ON p.sales_order_id = o.id
        LEFT JOIN (SELECT sales_order_id, SUM(subsidy_fen) AS s FROM subsidy_claims GROUP BY sales_order_id) c ON c.sales_order_id = o.id
        WHERE COALESCE(p.s, 0) <> COALESCE(c.s, 0))
      + (SELECT COUNT(*) FROM subsidy_claims c
        JOIN sales_orders o ON o.id = c.sales_order_id
        JOIN sales_order_items i ON i.id = c.sales_order_item_id
        WHERE i.order_id <> c.sales_order_id OR c.store_id <> o.store_id OR c.customer_id IS DISTINCT FROM o.customer_id OR i.device_id IS DISTINCT FROM c.device_id
          OR ((o.status = 'VOIDED' OR i.returned_qty > 0) <> (c.status IN ('CANCELLED', 'RETURN_DUE', 'RETURNED')))
          OR ((c.status IN ('SETTLED', 'RETURN_DUE', 'RETURNED')) <> (c.settled_fen IS NOT NULL))
          OR (c.status IN ('PENDING', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED') AND c.settled_at IS NOT NULL))
    )::bigint AS n`;
  const [invoice] = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT (
      (SELECT COUNT(*) FROM invoices i
        LEFT JOIN (SELECT invoice_id, SUM(amount_fen) AS a, SUM(tax_fen) AS t FROM invoice_lines GROUP BY invoice_id) l ON l.invoice_id = i.id
        WHERE i.amount_fen <> COALESCE(l.a, 0) OR i.tax_fen <> COALESCE(l.t, 0))
      + (SELECT COUNT(*) FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id JOIN sales_order_items si ON si.id = l.sales_order_item_id WHERE si.order_id <> i.sales_order_id)
      + (SELECT COUNT(*) FROM invoices i JOIN sales_orders o ON o.id = i.sales_order_id
        WHERE i.store_id <> o.store_id OR (o.status = 'VOIDED' AND i.status IN ('REQUESTED', 'ISSUED')))
      + (SELECT COUNT(*) FROM invoices i WHERE i.status IN ('REQUESTED', 'ISSUED')
        AND EXISTS (SELECT 1 FROM return_orders r WHERE r.sales_order_id = i.sales_order_id AND r.created_at > i.created_at))
      + (SELECT COUNT(*) FROM invoices i
        WHERE (i.status IN ('ISSUED', 'RED_PENDING', 'REDDED')) <> (i.invoice_number IS NOT NULL AND i.issued_at IS NOT NULL)
          OR (i.status = 'REDDED') <> (i.red_number IS NOT NULL AND i.red_at IS NOT NULL))
      + (SELECT COUNT(*) FROM invoices a JOIN invoices b ON a.red_number = b.invoice_number)
      + (SELECT COUNT(*) FROM invoices a JOIN invoices b ON a.red_number = b.red_number AND a.id < b.id)
    )::bigint AS n`;
  const [approval] = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT (
      (SELECT COUNT(*) FROM approval_requests a
        WHERE (a.status = 'EXECUTED' AND (a.decided_by_id IS NULL OR a.decided_at IS NULL OR a.result_id IS NULL))
          OR (a.status = 'FAILED' AND (a.error IS NULL OR a.decided_at IS NULL))
          OR (a.status = 'REJECTED' AND (a.decision_note IS NULL OR a.decided_by_id IS NULL))
          OR (a.status IN ('PENDING', 'CANCELLED') AND (a.decided_by_id IS NOT NULL OR a.result_id IS NOT NULL)))
      + (SELECT COUNT(*) FROM approval_requests a
        WHERE a.status = 'EXECUTED' AND a.action = 'SALE'
          AND NOT EXISTS (SELECT 1 FROM sales_orders o WHERE o.id = a.result_id AND o.store_id = a.store_id))
    )::bigint AS n`;
  const [wecom] = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT (
      (SELECT COUNT(*) FROM wecom_follows f JOIN customers c ON c.id = f.customer_id WHERE c.wecom_external_userid IS DISTINCT FROM f.external_userid)
      + (SELECT COUNT(*) FROM wecom_kf_sessions k JOIN customers c ON c.id = k.customer_id WHERE c.wecom_external_userid IS DISTINCT FROM k.external_userid)
      + (SELECT COUNT(*) FROM wecom_transfers t
          WHERE t.status = 'DONE' AND NOT EXISTS (SELECT 1 FROM wecom_follows f WHERE f.external_userid = t.external_userid AND f.wecom_userid = t.to_wecom_userid))
      + (SELECT COUNT(*) FROM wecom_transfers t JOIN wecom_follows f ON f.id = t.follow_id WHERE f.external_userid <> t.external_userid OR f.wecom_userid <> t.from_wecom_userid)
    )::bigint AS n`;
  const [hr] = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT (
      (SELECT COUNT(*) FROM leave_requests l LEFT JOIN approval_requests a ON a.id = l.approval_request_id
        WHERE a.id IS NULL OR a.action <> 'LEAVE' OR (a.payload->>'leaveId')::int IS DISTINCT FROM l.id
          OR NOT ((l.status = 'PENDING' AND a.status = 'PENDING')
            OR (l.status = 'APPROVED' AND a.status = 'EXECUTED' AND a.result_id = l.id)
            OR (l.status = 'REJECTED' AND a.status = 'REJECTED')
            OR (l.status = 'CANCELLED' AND a.status IN ('CANCELLED', 'FAILED'))))
      + (SELECT COUNT(*) FROM leave_requests x JOIN leave_requests y ON x.user_id = y.user_id AND x.id < y.id
          WHERE x.status IN ('PENDING', 'APPROVED') AND y.status IN ('PENDING', 'APPROVED') AND x.start_date <= y.end_date AND y.start_date <= x.end_date)
      + (SELECT COUNT(*) FROM approval_requests a
          WHERE a.status = 'PENDING' AND cardinality(a.chain) > 1 AND COALESCE(jsonb_array_length(a.step_log), 0) <> a.step - 1)
      + (SELECT COUNT(*) FROM expense_claims e LEFT JOIN approval_requests a ON a.id = e.approval_request_id
        WHERE a.id IS NULL OR a.action <> 'EXPENSE' OR (a.payload->>'claimId')::int IS DISTINCT FROM e.id OR a.amount_fen <> e.amount_fen
          OR NOT ((e.status = 'PENDING' AND a.status = 'PENDING')
            OR (e.status IN ('APPROVED', 'PAID') AND a.status = 'EXECUTED' AND a.result_id = e.id)
            OR (e.status = 'REJECTED' AND a.status = 'REJECTED')
            OR (e.status = 'CANCELLED' AND a.status IN ('CANCELLED', 'FAILED'))))
    )::bigint AS n`;
  return {
    accessory: Number(accessory!.n) + Number(accessoryLast!.n) + Number(accessoryOrphan!.n),
    device: Number(device!.n),
    payment: Number(payment!.n),
    dailyClose: closeRows.length,
    deviceState: Number(deviceLedger!.n) + Number(deviceSale!.n),
    entitlement: Number(entitlement!.n),
    repair: Number(repair!.n),
    carrier: Number(carrier!.n),
    subsidy: Number(subsidy!.n),
    invoice: Number(invoice!.n),
    approval: Number(approval!.n),
    wecom: Number(wecom!.n),
    hr: Number(hr!.n),
  };
}

export function describeIntegrity(r: IntegrityResult): string {
  return `配件余额对不上 ${r.accessory} 处，机器数对不上 ${r.device} 处，收款 ≠ 应收 ${r.payment} 单，日结系统数对不上 ${r.dailyClose} 行，机器状态和流水、销售单对不上 ${r.deviceState} 台，服务权益和单据对不上 ${r.entitlement} 处，维修单收款对不上 ${r.repair} 张，运营商结算对不上 ${r.carrier} 处，国补对不上 ${r.subsidy} 处，发票对不上 ${r.invoice} 处，审批单对不上 ${r.approval} 张，企业微信对不上 ${r.wecom} 处，请假报销和审批对不上 ${r.hr} 处。`;
}

export function integrityOk(r: IntegrityResult): boolean {
  return r.accessory + r.device + r.payment + r.dailyClose + r.deviceState + r.entitlement + r.repair + r.carrier + r.subsidy + r.invoice + r.approval + r.wecom + r.hr === 0;
}
