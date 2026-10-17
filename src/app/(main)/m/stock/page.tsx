import { requireUser } from "@/server/auth/current-user";
import { lookupStock } from "@/server/sales/lookup";
import { MobileStockView } from "./mobile-stock-view";

export const dynamic = "force-dynamic";

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

// 手机查库存：扫串号 / 条码或输型号，看在哪家店、什么状态、还剩几件。按登录人的数据范围查。
export default async function MobileStockPage({ searchParams }: PageProps<"/m/stock">) {
  const user = await requireUser();
  const q = one((await searchParams).q).trim();
  const result = q ? await lookupStock(user, q) : null;
  return <MobileStockView key={q} q={q} result={result} />;
}
