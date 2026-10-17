import "server-only";
import { prisma } from "@/lib/prisma";

// 库存流水里的单号 → 能点开的页面地址（机器全程流水、流水列表用）。
// 单号前缀：RI 入库单（跳到它的采购单）、TR 调拨单、ST 盘点、SO 销售单、RT 退货单（跳到原销售单）。
// RC 回收单没有详情页，不给链接。只查这一批单号，一种前缀一条查询。

export async function docLinks(docNos: string[], opts: { canViewPurchase: boolean }): Promise<Record<string, string>> {
  const unique = [...new Set(docNos)].filter((n) => opts.canViewPurchase || !n.startsWith("RI"));
  const pick = (prefix: string) => unique.filter((n) => n.startsWith(prefix));
  const [receipts, transfers, stocktakes, sales, returns] = await Promise.all([
    pick("RI").length ? prisma.goodsReceipt.findMany({ where: { receiptNo: { in: pick("RI") } }, select: { receiptNo: true, purchaseOrderId: true } }) : [],
    pick("TR").length ? prisma.transferOrder.findMany({ where: { orderNo: { in: pick("TR") } }, select: { orderNo: true, id: true } }) : [],
    pick("ST").length ? prisma.stocktake.findMany({ where: { stocktakeNo: { in: pick("ST") } }, select: { stocktakeNo: true, id: true } }) : [],
    pick("SO").length ? prisma.salesOrder.findMany({ where: { orderNo: { in: pick("SO") } }, select: { orderNo: true, id: true } }) : [],
    pick("RT").length ? prisma.returnOrder.findMany({ where: { orderNo: { in: pick("RT") } }, select: { orderNo: true, salesOrderId: true } }) : [],
  ]);
  const links: Record<string, string> = {};
  for (const r of receipts) links[r.receiptNo] = `/purchase/${r.purchaseOrderId}`;
  for (const t of transfers) links[t.orderNo] = `/transfers/${t.id}`;
  for (const s of stocktakes) links[s.stocktakeNo] = `/stocktakes/${s.id}`;
  for (const o of sales) links[o.orderNo] = `/sales/${o.id}`;
  for (const r of returns) links[r.orderNo] = `/sales/${r.salesOrderId}`;
  return links;
}
