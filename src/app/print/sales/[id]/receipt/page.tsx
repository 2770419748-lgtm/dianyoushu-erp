import { notFound } from "next/navigation";
import { formatDateTime, formatFen } from "@/lib/format";
import { isDbId, toDbId } from "@/lib/paging";
import { requireUser } from "@/server/auth/current-user";
import { PermissionError } from "@/server/auth/scope";
import { getReceiptData } from "@/server/print/print-service";
import { PrintToolbar, PAPER_STORAGE } from "../../../print-toolbar";
import { receiptCss, type ReceiptPaper } from "../../../print-styles";

export const dynamic = "force-dynamic";

// 销售小票（口径第 23 节）：80mm / 58mm 热敏纸，浏览器打印。能看这张单的人才能打。
export default async function ReceiptPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ paper?: string; auto?: string }> }) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const orderId = toDbId(id);
  if (!isDbId(orderId)) notFound();
  const user = await requireUser();
  const paper: ReceiptPaper = query.paper === "58" ? "58" : "80";
  let data;
  try {
    data = await getReceiptData(user, orderId);
  } catch (error) {
    if (error instanceof PermissionError) return <p style={{ padding: 24 }}>没有权限打印这张单。</p>;
    throw error;
  }
  if (!data) notFound();
  const paid = data.payments.reduce((s, p) => s + p.amountFen, 0);
  return (
    <>
      <style>{receiptCss(paper)}</style>
      <PrintToolbar papers={[{ value: "80", label: "80mm" }, { value: "58", label: "58mm" }]} current={paper} storageKey={PAPER_STORAGE.receipt} auto={query.auto === "1"} />
      <div className="sheet">
        <div className="center title">{data.header.title}</div>
        <div className="center">{data.header.storeName}</div>
        {data.header.storeAddress ? <div className="center muted">{data.header.storeAddress}</div> : null}
        {data.header.phone ? <div className="center muted">电话 {data.header.phone}</div> : null}
        {data.voided ? <div className="stamp">已作废</div> : null}
        <div className="rule" />
        <div>
          单号 <span className="code">{data.orderNo}</span>
        </div>
        <div>
          营业日 {data.bizDate}　开单 {formatDateTime(data.createdAt).slice(11, 16)}
        </div>
        <div>开单人 {data.salesperson}</div>
        {data.customer ? (
          <div>
            客户 {data.customer.name} {data.customer.phoneMasked}
          </div>
        ) : null}
        <div className="rule" />
        <table>
          <tbody>
            {data.lines.map((l, i) => (
              <tr key={i}>
                <td>
                  <div>{l.name}</div>
                  {l.code ? <div className="code muted">{l.code}</div> : null}
                  {l.service ? (
                    <div className="muted">
                      {l.service.covers ? `保 ${l.service.covers} ` : ""}
                      {l.service.startedOn} 至 {l.service.expiresOn}
                      {l.service.status === "VOIDED" ? "（已退）" : ""}
                    </div>
                  ) : null}
                  <div className="muted">
                    {l.qty} × {formatFen(l.unitPriceFen)}
                  </div>
                </td>
                <td className="right">{formatFen(l.lineTotalFen)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="rule" />
        <table>
          <tbody>
            <tr>
              <td>商品合计</td>
              <td className="right">{formatFen(data.subtotalFen)}</td>
            </tr>
            {data.discountFen > 0 ? (
              <tr>
                <td>整单优惠</td>
                <td className="right">−{formatFen(data.discountFen)}</td>
              </tr>
            ) : null}
            <tr>
              <td className="title">应收</td>
              <td className="right title">{formatFen(data.totalFen)}</td>
            </tr>
            {data.payments.map((p, i) => (
              <tr key={i}>
                <td>{p.label}</td>
                <td className="right">{formatFen(p.amountFen)}</td>
              </tr>
            ))}
            {paid !== data.totalFen ? (
              <tr>
                <td>合计收款</td>
                <td className="right">{formatFen(paid)}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
        {data.returns.length > 0 ? (
          <>
            <div className="rule" />
            {data.returns.map((r) => (
              <div key={r.orderNo}>
                退货 <span className="code">{r.orderNo}</span> 退款 {formatFen(r.refundFen)}
              </div>
            ))}
          </>
        ) : null}
        <div className="rule" />
        <div>凭小票保修、退换。</div>
        {data.warrantyUntil ? <div>机器保修到 {data.warrantyUntil}（开单日起 12 个月），屏幕、进水等人为损坏不保。</div> : null}
        <div className="muted">打印时间 {formatDateTime(new Date())}</div>
      </div>
    </>
  );
}
