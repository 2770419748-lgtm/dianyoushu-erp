import "server-only";
import { clampPage } from "@/lib/paging";
import { prisma } from "@/lib/prisma";
import type { DeviceStatus } from "@/generated/prisma/enums";
import { assertStoreAccess, storeScopeWhere } from "@/server/auth/scope";
import type { CurrentUser } from "@/server/auth/current-user";

// 库存只读查询，全部带数据范围（店员店长本店、区域经理辖区、总部全部）。

export const STOCK_PAGE_SIZE = 20;

export interface DeviceQuery {
  storeId?: number;
  q?: string; // 串号、商品名、型号
  status?: DeviceStatus;
  page?: number;
}

export async function listDevices(user: CurrentUser, query: DeviceQuery) {
  const page = clampPage(query.page);
  const text = (query.q ?? "").trim();
  const where = {
    AND: [
      storeScopeWhere(user),
      query.storeId ? { storeId: query.storeId } : {},
      query.status ? { status: query.status } : {},
      text
        ? {
            OR: [
              { code: { contains: text } },
              { sn: { contains: text } },
              { imei2: { contains: text } },
              { sku: { name: { contains: text, mode: "insensitive" as const } } },
              { sku: { model: { name: { contains: text, mode: "insensitive" as const } } } },
            ],
          }
        : {},
    ],
  };
  const [rows, total] = await Promise.all([
    prisma.device.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * STOCK_PAGE_SIZE,
      take: STOCK_PAGE_SIZE,
      include: {
        sku: { include: { model: { include: { brand: true } } } },
        store: { select: { code: true, name: true } },
      },
    }),
    prisma.device.count({ where }),
  ]);
  return { rows: rows.map((r) => ({ ...r, costFen: canSeeCost(user) ? r.costFen : 0, sku: hideSkuCost(r.sku, user) })), total, page, pageSize: STOCK_PAGE_SIZE };
}

export type DeviceRow = Awaited<ReturnType<typeof listDevices>>["rows"][number];

/** 机器成本（采购价 / 回收估价）只给店长以上：店员拿到的数据里就是 0，不只是页面不显示 */
function canSeeCost(user: CurrentUser): boolean {
  return user.role !== "STAFF";
}
/** 商品的参考成本只给总部（口径第 1 节）：店长、区域经理拿到的数据里也是 0 */
function hideSkuCost<T extends { costPriceFen: number }>(sku: T, user: CurrentUser): T {
  return user.role === "HQ" ? sku : { ...sku, costPriceFen: 0 };
}

export async function listAccessoryStocks(user: CurrentUser, query: { storeId?: number; q?: string }) {
  const text = (query.q ?? "").trim();
  const rows = await prisma.accessoryStock.findMany({
    where: {
      AND: [
        storeScopeWhere(user),
        query.storeId ? { storeId: query.storeId } : {},
        text
          ? {
              OR: [
                { sku: { name: { contains: text, mode: "insensitive" as const } } },
                { sku: { barcode: { contains: text } } },
              ],
            }
          : {},
      ],
    },
    orderBy: [{ storeId: "asc" }, { sku: { name: "asc" } }],
    include: {
      sku: { include: { model: { include: { brand: true } } } },
      store: { select: { code: true, name: true } },
    },
  });
  return rows.map((r) => ({ ...r, sku: hideSkuCost(r.sku, user) }));
}

export type AccessoryStockRow = Awaited<ReturnType<typeof listAccessoryStocks>>[number];

export async function listLedger(user: CurrentUser, query: { storeId?: number; q?: string; page?: number }) {
  const page = clampPage(query.page);
  const text = (query.q ?? "").trim();
  const where = {
    AND: [
      storeScopeWhere(user),
      query.storeId ? { storeId: query.storeId } : {},
      text
        ? {
            OR: [
              { docNo: { contains: text, mode: "insensitive" as const } },
              { device: { OR: [{ code: { contains: text } }, { sn: { contains: text } }, { imei2: { contains: text } }] } },
              { sku: { name: { contains: text, mode: "insensitive" as const } } },
            ],
          }
        : {},
    ],
  };
  const [rows, total] = await Promise.all([
    prisma.stockLedger.findMany({
      where,
      orderBy: { id: "desc" },
      skip: (page - 1) * STOCK_PAGE_SIZE,
      take: STOCK_PAGE_SIZE,
      include: {
        sku: { select: { name: true } },
        device: { select: { code: true } },
        store: { select: { code: true, name: true } },
        operator: { select: { name: true } },
      },
    }),
    prisma.stockLedger.count({ where }),
  ]);
  return { rows, total, page, pageSize: STOCK_PAGE_SIZE };
}

export type LedgerRow = Awaited<ReturnType<typeof listLedger>>["rows"][number];

/** 按任意一个码（主码、SN、IMEI1、IMEI2）查机器详情 + 全程流水；越权抛 PermissionError */
export async function getDeviceByCode(user: CurrentUser, code: string) {
  const device = await prisma.device.findFirst({
    where: { OR: [{ code }, { sn: code }, { imei1: code }, { imei2: code }] },
    include: {
      sku: { include: { model: { include: { brand: true, category: true } } } },
      store: { select: { id: true, code: true, name: true, regionId: true } },
      goodsReceipt: { select: { receiptNo: true, createdAt: true } },
      ledgers: {
        orderBy: { id: "asc" },
        include: { store: { select: { code: true, name: true } }, operator: { select: { name: true } } },
      },
    },
  });
  if (!device) return null;
  assertStoreAccess(user, { id: device.store.id, regionId: device.store.regionId });
  return { ...device, costFen: canSeeCost(user) ? device.costFen : 0, sku: hideSkuCost(device.sku, user) };
}

export type DeviceDetail = NonNullable<Awaited<ReturnType<typeof getDeviceByCode>>>;

/** 门店库存汇总：每个状态多少台、配件多少件 */
export async function stockSummary(user: CurrentUser, storeId?: number) {
  const where = { AND: [storeScopeWhere(user), storeId ? { storeId } : {}] };
  const [byStatus, accessories] = await Promise.all([
    prisma.device.groupBy({ by: ["status"], where, _count: { _all: true } }),
    prisma.accessoryStock.aggregate({ where, _sum: { qty: true } }),
  ]);
  return {
    byStatus: Object.fromEntries(byStatus.map((g) => [g.status, g._count._all])) as Partial<Record<DeviceStatus, number>>,
    accessoryQty: accessories._sum.qty ?? 0,
  };
}
