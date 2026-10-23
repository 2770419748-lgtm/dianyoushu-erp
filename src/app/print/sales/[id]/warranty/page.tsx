import { notFound } from "next/navigation";
import { isDbId, toDbId } from "@/lib/paging";
import { requireUser } from "@/server/auth/current-user";
import { PermissionError } from "@/server/auth/scope";
import { getWarrantyData } from "@/server/print/print-service";
import { PrintToolbar, PAPER_STORAGE } from "../../../print-toolbar";
import { warrantyCss, type WarrantyPaper } from "../../../print-styles";

export const dynamic = "force-dynamic";

// 保修卡（口径第 23 节）：一台机器一张，默认 A5 竖版，也能用 80mm 小票纸打。作废的单、已经退货的机器不出卡。
export default async function WarrantyPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ paper?: string; auto?: string }> }) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const orderId = toDbId(id);
  if (!isDbId(orderId)) notFound();
  const user = await requireUser();
  const paper: WarrantyPaper = query.paper === "80" ? "80" : "a5";
  let data;
  try {
    data = await getWarrantyData(user, orderId);
  } catch (error) {
    if (error instanceof PermissionError) return <p style={{ padding: 24 }}>没有权限打印这张单。</p>;
    throw error;
  }
  if (!data) notFound();
  return (
    <>
      <style>{warrantyCss(paper)}</style>
      <PrintToolbar papers={[{ value: "a5", label: "A5" }, { value: "80", label: "80mm 小票纸" }]} current={paper} storageKey={PAPER_STORAGE.warranty} auto={query.auto === "1" && data.cards.length > 0} />
      <div className="sheet">
        {data.cards.length === 0 ? (
          <p>{data.voided ? "这张单已作废，不出保修卡。" : "这张单没有要出保修卡的机器（没有机器，或者机器都退货了）。"}</p>
        ) : (
          data.cards.map((c, i) => (
            <div className="card" key={i}>
              <h1>保修卡</h1>
              <div className="center title">{data.header.title}</div>
              <div className="center muted">
                {data.header.storeName}
                {data.header.phone ? `　电话 ${data.header.phone}` : ""}
              </div>
              <div className="rule" />
              <table>
                <tbody>
                  <tr>
                    <td>机型</td>
                    <td>{c.model}</td>
                  </tr>
                  {c.codes.map((code) => (
                    <tr key={code.label}>
                      <td>{code.label}</td>
                      <td className="code">{code.value}</td>
                    </tr>
                  ))}
                  <tr>
                    <td>购买日期</td>
                    <td>{data.purchasedOn}</td>
                  </tr>
                  <tr>
                    <td>销售单号</td>
                    <td className="code">{data.orderNo}</td>
                  </tr>
                  {data.customer ? (
                    <tr>
                      <td>客户</td>
                      <td>
                        {data.customer.name} {data.customer.phoneMasked}
                      </td>
                    </tr>
                  ) : null}
                  <tr>
                    <td>保修期</td>
                    <td>
                      {data.purchasedOn} 至 {data.warrantyUntil}（12 个月）
                    </td>
                  </tr>
                  {c.services.map((s, j) => (
                    <tr key={j}>
                      <td>{j === 0 ? "增值服务" : ""}</td>
                      <td>
                        {s.name}：{s.startedOn} 至 {s.expiresOn}
                        {s.status === "CLAIMED" ? "（已理赔）" : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="rule" />
              <div>保修期内非人为的质量问题免费维修；屏幕损坏、进水、摔坏等人为损坏不在保修范围（买了碎屏险、延保的按保险条款）。</div>
              <div>凭本卡和购买小票到任意门店售后。</div>
            </div>
          ))
        )}
      </div>
    </>
  );
}
