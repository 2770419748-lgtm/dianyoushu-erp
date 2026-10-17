import type { NextRequest } from "next/server";
import { getCurrentUser } from "@/server/auth/current-user";
import { cashierReport, DailyCloseError } from "@/server/dailyclose/daily-close-service";
import { parseReportRange } from "@/server/dailyclose/report-query";
import { DAILY_CLOSE_METHODS } from "@/server/dailyclose/summary";
import { toCsv } from "@/lib/csv";
import { PAYMENT_METHOD_LABELS } from "@/lib/sales-labels";

// 收银日报导出：CSV（带 BOM，Excel 双击直接打开不乱码）。权限和页面一样：店员不能导。

const yuan = (fen: number) => (fen / 100).toFixed(2);

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return new Response("请先登录", { status: 401 });
  if (user.role === "STAFF") return new Response("没有权限", { status: 403 });

  const params = request.nextUrl.searchParams;
  let range: ReturnType<typeof parseReportRange>;
  try {
    range = parseReportRange(params.get("from") ?? "", params.get("to") ?? "");
  } catch (error) {
    if (error instanceof DailyCloseError) return new Response(error.message, { status: 400 });
    throw error;
  }
  const storeText = params.get("storeId");
  const storeId = storeText ? Number(storeText) : undefined;
  if (storeId !== undefined && (!Number.isInteger(storeId) || storeId <= 0 || storeId > 2147483647)) return new Response("门店参数不对", { status: 400 });
  const rows = await cashierReport(user, { from: range.from, to: range.to, storeId });

  const header = ["营业日", "门店", ...DAILY_CLOSE_METHODS.map((m) => `${PAYMENT_METHOD_LABELS[m]}（元）`), "实收不含抵扣（元）", "日结状态"];
  const lines = rows.map((r) => [
    r.bizDate,
    r.storeLabel,
    ...DAILY_CLOSE_METHODS.map((m) => yuan(r.amounts[m])),
    yuan(r.cashFen),
    r.closeStatus === "CONFIRMED" ? (r.hasDiff ? "已确认（有差异）" : "已确认") : r.closeStatus === "PENDING" ? "未确认" : "未日结",
  ]);
  const csv = toCsv([header, ...lines]);
  const filename = `收银日报_${range.fromText}_${range.toText}.csv`;

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="cashier_${range.fromText}_${range.toText}.csv"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "no-store",
    },
  });
}
