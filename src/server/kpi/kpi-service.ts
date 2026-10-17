import "server-only";
import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/server/audit";
import type { CurrentUser } from "@/server/auth/current-user";
import { canManageKpi } from "@/server/auth/permissions";
import { PermissionError } from "@/server/auth/scope";

// KPI 目标：门店 × 月一条，四个数（销售额、毛利、主机台数、回收台数）。总部录，看板按当月目标算完成率。

export class KpiError extends Error {}

export interface KpiTargetInput {
  storeId: number;
  salesTargetFen: number;
  profitTargetFen: number;
  deviceQtyTarget: number;
  tradeInQtyTarget: number;
}

function assertMonth(year: number, month: number) {
  if (!Number.isInteger(year) || year < 2020 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) throw new KpiError("月份不对");
}

function assertCount(value: unknown, label: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 2_000_000_000) throw new KpiError(`${label}要填不小于 0 的整数`);
  return n;
}

function previousMonth(year: number, month: number) {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

/** 某月所有在营门店的目标（没录的是 null），附带上月目标做参照 */
export async function listKpiTargets(year: number, month: number) {
  assertMonth(year, month);
  const prev = previousMonth(year, month);
  const [stores, targets, prevTargets] = await Promise.all([
    prisma.store.findMany({ where: { isActive: true }, orderBy: { code: "asc" }, select: { id: true, code: true, name: true, region: { select: { name: true } } } }),
    prisma.kpiTarget.findMany({ where: { year, month } }),
    prisma.kpiTarget.findMany({ where: prev }),
  ]);
  const pick = (t: (typeof targets)[number] | undefined) =>
    t ? { salesTargetFen: t.salesTargetFen, profitTargetFen: t.profitTargetFen, deviceQtyTarget: t.deviceQtyTarget, tradeInQtyTarget: t.tradeInQtyTarget } : null;
  return stores.map((s) => ({
    storeId: s.id,
    label: `${s.code} ${s.name}`,
    region: s.region.name,
    target: pick(targets.find((t) => t.storeId === s.id)),
    prevTarget: pick(prevTargets.find((t) => t.storeId === s.id)),
  }));
}

export type KpiRow = Awaited<ReturnType<typeof listKpiTargets>>[number];

/** 一次保存一个月多家门店的目标；有就改、没有就建，同一个事务里写完并记日志 */
export async function saveKpiTargets(user: CurrentUser, year: number, month: number, rows: KpiTargetInput[]) {
  if (!canManageKpi(user.role)) throw new PermissionError("只有总部能录 KPI 目标");
  assertMonth(year, month);
  if (rows.length === 0) throw new KpiError("没有要保存的门店");
  const clean = rows.map((r) => ({
    storeId: assertCount(r.storeId, "门店"),
    salesTargetFen: assertCount(r.salesTargetFen, "销售额目标"),
    profitTargetFen: assertCount(r.profitTargetFen, "毛利目标"),
    deviceQtyTarget: assertCount(r.deviceQtyTarget, "主机台数目标"),
    tradeInQtyTarget: assertCount(r.tradeInQtyTarget, "回收台数目标"),
  }));
  if (clean.some((r) => r.profitTargetFen > r.salesTargetFen)) throw new KpiError("毛利目标不能大于销售额目标");
  const storeIds = [...new Set(clean.map((r) => r.storeId))];
  const count = await prisma.store.count({ where: { id: { in: storeIds }, isActive: true } });
  if (count !== storeIds.length) throw new KpiError("有门店不存在或已停用");

  await prisma.$transaction(async (tx) => {
    for (const r of clean) {
      const { storeId, ...values } = r;
      await tx.kpiTarget.upsert({
        where: { storeId_year_month: { storeId, year, month } },
        create: { storeId, year, month, ...values },
        update: values,
      });
    }
    await writeAudit({ userId: user.id, action: "kpi.set", entity: "kpi_target", entityId: `${year}-${String(month).padStart(2, "0")}`, detail: { stores: clean.length } }, tx);
  });
  return { saved: clean.length };
}
