import "server-only";
import { clampPage } from "@/lib/paging";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import type { DeviceStatus } from "@/generated/prisma/enums";
import { isValidIdCard, normalizeIdCard } from "@/lib/id-card";
import { canRefurbish, canSeeSellerId, canSell } from "@/server/auth/permissions";
import { assertStoreAccess, PermissionError, storeScopeWhere } from "@/server/auth/scope";
import { decryptPii, encryptPii, maskIdCard, piiFingerprint } from "@/server/pii/crypto";
import type { CurrentUser } from "@/server/auth/current-user";
import { writeAudit } from "@/server/audit";
import { asTx, type Db } from "@/server/db-tx";
import { nextDocNo } from "@/server/stock/doc-no";
import { DeviceStateError } from "@/server/stock/device-state";
import { DEVICE_STATUS_LABELS } from "@/lib/stock-labels";
import { parseDeviceCodeLines } from "@/server/stock/imei";
import { applyDeviceAction, receiveDevices, retakeSoldDevice, StockError } from "@/server/stock/stock-service";

// 回收单（以旧换新收旧机，口径第 7 节）：
// 估价店员手填；提交后旧机进本店回收库（串号状态"回收"，成本 = 估价）；
// 一张回收单只能抵扣一张销售单；店长或总部确认后"回收 → 良品"，良品可以再开单卖。
// 本系统卖出去的机器被客户拿回来（串号已在系统里、状态"已售"）：不新建机器，沿用原记录改成"回收"，机型以系统里的为准。
// 卖家身份（口径第 20 节）：姓名、身份证号必填；身份证号加密存，店员只看打码的，店长及以上点“显示完整号码”才看到（记日志）。

export class TradeInError extends Error {}

type Tx = Prisma.TransactionClient;

export const CONDITION_OPTIONS = ["全新", "95 新", "9 成新", "8 成新", "有损"] as const;

/** 种子里预置的"其他机型"回收 SKU：旧机对不上现有型号时选它，真实机型写在 modelName */
export const GENERIC_TRADE_IN_SKU_NAME = "回收机（其他机型）";

function wrap(error: unknown): never {
  if (error instanceof StockError || error instanceof DeviceStateError) throw new TradeInError(error.message);
  throw error;
}

export interface TradeInInput {
  storeId: unknown;
  customerId?: unknown;
  codesText: unknown; // 旧机的 SN / IMEI1 / IMEI2，一行，1 到 3 个
  skuId: unknown;
  modelName?: unknown;
  condition: unknown;
  appraisedFen: unknown;
  sellerName?: unknown;
  sellerIdNo?: unknown;
  note?: unknown;
}

/** 卖家身份：姓名 1～30 字，身份证号 18 位且校验位对 */
function parseSeller(input: TradeInInput) {
  const sellerName = typeof input.sellerName === "string" ? input.sellerName.trim() : "";
  if (!sellerName) throw new TradeInError("请填卖家姓名（收旧手机要登记卖家身份）");
  if (sellerName.length > 30) throw new TradeInError("卖家姓名最多 30 个字");
  const idNo = normalizeIdCard(typeof input.sellerIdNo === "string" ? input.sellerIdNo : "");
  if (!idNo) throw new TradeInError("请填卖家身份证号（收旧手机要登记卖家身份）");
  if (!isValidIdCard(idNo)) throw new TradeInError("身份证号不对：要 18 位，出生日期不能晚于今天、最后一位校验码要对得上（核对一下有没有输错）");
  return { sellerName, sellerIdEnc: encryptPii(idNo), sellerIdFp: piiFingerprint("idcard", idNo), sellerIdMasked: maskIdCard(idNo) };
}

export async function createTradeInTx(tx: Tx, user: CurrentUser, input: TradeInInput) {
  if (!canSell(user.role)) throw new TradeInError("你的角色不能开回收单");
  const storeId = Number(input.storeId);
  const store = await tx.store.findUnique({ where: { id: storeId }, select: { id: true, regionId: true, isActive: true } });
  if (!store || !store.isActive) throw new TradeInError("门店不存在或已停用");
  assertStoreAccess(user, store);

  const parsed = parseDeviceCodeLines(typeof input.codesText === "string" ? input.codesText : "");
  if (parsed.errors.length > 0) throw new TradeInError(parsed.errors[0]!);
  if (parsed.devices.length !== 1) throw new TradeInError("一张回收单收一台旧机：填这台的 SN / IMEI1 / IMEI2，至少一个，写在一行");
  const codes = parsed.devices[0]!;
  const sold = await findSoldDevice(tx, codes);

  const skuId = Number(input.skuId);
  const chosen = Number.isInteger(skuId) && skuId > 0 ? await tx.sku.findUnique({ where: { id: skuId }, include: { model: { include: { brand: true, category: true } } } }) : null;
  // 收回本系统卖出的机器：系统知道它是什么机型，以系统为准（也就不会落到指导价 0 的“其他机型”上）
  const sku = sold ? sold.sku : chosen;
  if (!sku) throw new TradeInError("请选旧机机型（对不上就选“回收机（其他机型）”并写清机型）");
  if (sku.model.category.kind !== "DEVICE") throw new TradeInError("回收的必须是大件");
  const typedModel = typeof input.modelName === "string" ? input.modelName.trim().slice(0, 60) : "";
  const modelName = (sold ? "" : typedModel) || `${sku.model.brand.name} ${sku.name}`;
  if (!sold && sku.name === GENERIC_TRADE_IN_SKU_NAME && !typedModel) throw new TradeInError("选了“其他机型”要写清旧机是什么型号");

  const condition = typeof input.condition === "string" ? input.condition : "";
  if (!(CONDITION_OPTIONS as readonly string[]).includes(condition)) throw new TradeInError("请选成色");
  const appraisedFen = Number(input.appraisedFen);
  if (!Number.isInteger(appraisedFen) || appraisedFen <= 0) throw new TradeInError("估价要大于 0");
  if (appraisedFen > 5_000_000) throw new TradeInError("估价太大了，检查一下");
  const seller = parseSeller(input);

  let customerId: number | null = null;
  if (input.customerId) {
    customerId = Number(input.customerId);
    const customer = await tx.customer.findUnique({ where: { id: customerId }, select: { id: true } });
    if (!customer) throw new TradeInError("客户不存在");
  }
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 200) || null : null;

  const orderNo = await nextDocNo(tx, "RC");
  const deviceCode = sold ? sold.device.code : codes.code;
  const order = await tx.tradeInOrder.create({
    data: { orderNo, storeId, customerId, handledById: user.id, deviceCode, modelName, skuId: sku.id, condition, appraisedFen, note, ...seller },
  });
  try {
    if (sold) {
      await retakeSoldDevice(tx, {
        deviceId: sold.device.id,
        storeId,
        costFen: appraisedFen,
        condition,
        tradeInOrderId: order.id,
        fillCodes: sold.fillCodes,
        docNo: orderNo,
        operatorId: user.id,
        note: `${modelName}（本系统卖出的机器收回）`,
      });
    } else await receiveDevices(tx, {
      storeId,
      skuId: sku.id,
      devices: [{ sn: codes.sn, imei1: codes.imei1, imei2: codes.imei2 }],
      costFen: appraisedFen,
      docType: "TRADE_IN",
      docNo: orderNo,
      operatorId: user.id,
      tradeInOrderId: order.id,
      condition,
      note: modelName,
    });
  } catch (error) {
    wrap(error);
  }
  await writeAudit({ userId: user.id, action: "trade_in.create", entity: "trade_in_order", entityId: order.id, detail: { orderNo, appraisedFen, deviceCode, retake: sold !== null, sellerName: seller.sellerName, sellerIdMasked: seller.sellerIdMasked } }, tx);
  return { id: order.id, orderNo, appraisedFen, deviceCode, modelName };
}

/**
 * 回收单填的码在系统里已经有了：只有“已售”（本系统卖出去、客户又拿回来）能收，返回那台机器和要补填的码；
 * 系统里没有返回 null（按新机器入回收库）；其他状态、码对不上、几个码分属不同机器都拒绝。
 */
async function findSoldDevice(tx: Tx, codes: { sn: string | null; imei1: string | null; imei2: string | null; code: string }) {
  const list = [codes.sn, codes.imei1, codes.imei2].filter((c): c is string => !!c);
  const found = await tx.device.findMany({
    where: { OR: [{ code: { in: list } }, { sn: { in: list } }, { imei1: { in: list } }, { imei2: { in: list } }] },
    include: { sku: { include: { model: { include: { brand: true, category: true } } } } },
  });
  if (found.length === 0) return null;
  if (found.length > 1) throw new TradeInError(`填的几个码在系统里分属 ${found.length} 台不同的机器（${found.map((d) => d.code).join("、")}），检查一下有没有填错`);
  const device = found[0]!;
  if (device.status !== "SOLD") {
    throw new TradeInError(`${device.code} 已经在系统里，现在是“${DEVICE_STATUS_LABELS[device.status]}”，不能回收（只有卖出去的机器才能回收）`);
  }
  const fillCodes: { sn?: string; imei1?: string; imei2?: string } = {};
  for (const key of ["sn", "imei1", "imei2"] as const) {
    const typed = codes[key];
    if (!typed) continue;
    if (device[key] && device[key] !== typed) throw new TradeInError(`填的 ${key.toUpperCase()} 和系统里这台（${device.code}）对不上，检查一下有没有填错`);
    if (!device[key]) fillCodes[key] = typed;
  }
  return { device, sku: device.sku, fillCodes };
}

export async function createTradeIn(user: CurrentUser, input: TradeInInput) {
  return prisma.$transaction((tx) => createTradeInTx(tx, user, input));
}

/** 回收机转良品：回收 → 良品，数量不变，写一条流水（口径第 4 节） */
export async function refurbishTx(tx: Tx, user: CurrentUser, deviceId: number) {
  if (!canRefurbish(user.role)) throw new TradeInError("只有店长和总部能把回收机转良品");
  const device = await tx.device.findUnique({ where: { id: deviceId }, include: { store: { select: { id: true, regionId: true } }, tradeInOrder: { select: { orderNo: true } } } });
  if (!device) throw new TradeInError("机器不存在");
  assertStoreAccess(user, device.store);
  if (device.status !== "RECYCLED") throw new TradeInError("只有“回收”状态的机器能转良品");
  try {
    await applyDeviceAction(tx, { deviceId, action: "REFURBISH", docType: "REFURBISH", docNo: device.tradeInOrder?.orderNo ?? device.code, operatorId: user.id, note: "检测合格转良品" });
  } catch (error) {
    wrap(error);
  }
  await writeAudit({ userId: user.id, action: "trade_in.refurbish", entity: "device", entityId: deviceId, detail: { code: device.code } }, tx);
}

export async function refurbish(user: CurrentUser, deviceId: number) {
  return prisma.$transaction((tx) => refurbishTx(tx, user, deviceId));
}

// ---------- 查询 ----------

export const TRADE_IN_PAGE_SIZE = 20;

export async function listTradeIns(user: CurrentUser, page = 1) {
  const current = clampPage(page);
  const where = storeScopeWhere(user);
  const [rows, total] = await Promise.all([
    prisma.tradeInOrder.findMany({
      where,
      orderBy: { id: "desc" },
      skip: (current - 1) * TRADE_IN_PAGE_SIZE,
      take: TRADE_IN_PAGE_SIZE,
      include: {
        store: { select: { code: true, name: true } },
        customer: { select: { name: true, phoneMasked: true } },
        handledBy: { select: { name: true } },
        device: { select: { code: true, status: true } },
        salesOrder: { select: { id: true, orderNo: true, status: true } },
      },
      omit: { sellerIdEnc: true, sellerIdFp: true }, // 完整身份证号不出服务端，要看走 revealSellerId
    }),
    prisma.tradeInOrder.count({ where }),
  ]);
  return {
    rows: rows.map((r) => ({ ...r, customer: r.customer ? { name: r.customer.name, phoneMasked: r.customer.phoneMasked } : null })),
    total,
    page: current,
    pageSize: TRADE_IN_PAGE_SIZE,
    canSeeSellerId: canSeeSellerId(user.role),
  };
}

/** 看回收单卖家的完整身份证号：店长及以上、本范围的单；每看一次记操作日志（口径第 20 节） */
export async function revealSellerId(user: CurrentUser, tradeInId: number, db: Db = prisma): Promise<string> {
  if (!canSeeSellerId(user.role)) throw new TradeInError("店员只能看打码的身份证号，完整号码找店长看");
  const order = await db.tradeInOrder.findUnique({ where: { id: tradeInId }, select: { id: true, orderNo: true, sellerIdEnc: true, store: { select: { id: true, regionId: true } } } });
  if (!order) throw new TradeInError("回收单不存在");
  try {
    assertStoreAccess(user, order.store);
  } catch (error) {
    if (error instanceof PermissionError) throw new TradeInError("这张回收单不在你的范围内");
    throw error;
  }
  if (!order.sellerIdEnc) throw new TradeInError("这张回收单没有登记卖家身份（2026-10-23 以前开的）");
  const idNo = decryptPii(order.sellerIdEnc);
  await writeAudit({ userId: user.id, action: "trade_in.reveal_id", entity: "trade_in_order", entityId: order.id, detail: { orderNo: order.orderNo } }, asTx(db));
  return idNo;
}

export type TradeInRow = Awaited<ReturnType<typeof listTradeIns>>["rows"][number];

export const RECYCLED_PAGE_SIZE = 20;

/** 回收库存：本范围内状态为"回收"（等待检测）和"良品"的机器，分页（总部能看到几百台） */
export async function listRecycledDevices(user: CurrentUser, page = 1) {
  const where = { AND: [storeScopeWhere(user), { status: { in: ["RECYCLED", "REFURBISHED"] as DeviceStatus[] } }] };
  const current = clampPage(page);
  const [rows, total] = await Promise.all([
    prisma.device.findMany({
      where,
      orderBy: [{ status: "asc" }, { id: "desc" }],
      skip: (current - 1) * RECYCLED_PAGE_SIZE,
      take: RECYCLED_PAGE_SIZE,
      include: {
        sku: { select: { name: true } },
        store: { select: { code: true, name: true } },
        tradeInOrder: { select: { orderNo: true, modelName: true, appraisedFen: true, createdAt: true } },
      },
    }),
    prisma.device.count({ where }),
  ]);
  return { rows, total, page: current, pageSize: RECYCLED_PAGE_SIZE };
}

export type RecycledDeviceRow = Awaited<ReturnType<typeof listRecycledDevices>>["rows"][number];

/** 开单时可抵扣的回收单：本店、已完成、还没被任何销售单用过 */
export async function listAvailableTradeIns(user: CurrentUser, storeId: number) {
  const store = await prisma.store.findUnique({ where: { id: storeId }, select: { id: true, regionId: true } });
  if (!store) return [];
  assertStoreAccess(user, store);
  const rows = await prisma.tradeInOrder.findMany({
    where: { storeId, status: "COMPLETED", salesOrder: null },
    orderBy: { id: "desc" },
    take: 30,
    include: { customer: { select: { name: true, phoneMasked: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    orderNo: r.orderNo,
    modelName: r.modelName,
    deviceCode: r.deviceCode,
    appraisedFen: r.appraisedFen,
    customer: r.customer ? `${r.customer.name} ${r.customer.phoneMasked}` : null,
  }));
}

export type AvailableTradeIn = Awaited<ReturnType<typeof listAvailableTradeIns>>[number];

/** 回收单可选的旧机机型：在售大件 SKU，"其他机型"排最前 */
export async function listTradeInSkuOptions() {
  const skus = await prisma.sku.findMany({
    where: { isActive: true, model: { category: { kind: "DEVICE" } } },
    orderBy: [{ model: { brand: { name: "asc" } } }, { name: "asc" }],
    select: { id: true, name: true, model: { select: { brand: { select: { name: true } } } } },
  });
  return skus
    .map((s) => ({ id: s.id, label: s.name === GENERIC_TRADE_IN_SKU_NAME ? s.name : `${s.model.brand.name} ${s.name}`, generic: s.name === GENERIC_TRADE_IN_SKU_NAME }))
    .sort((a, b) => Number(b.generic) - Number(a.generic));
}
