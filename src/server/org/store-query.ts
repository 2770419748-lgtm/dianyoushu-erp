import "server-only";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/server/auth/current-user";
import type { Db } from "@/server/db-tx";
import { assertStoreAccess, storeTableWhere } from "@/server/auth/scope";

// 门店的只读查询，带数据范围：店员店长只有本店，区域经理是辖区，总部全部。

export async function listStoresInScope(user: CurrentUser, db: Db = prisma) {
  return db.store.findMany({
    where: storeTableWhere(user),
    orderBy: { code: "asc" },
    select: {
      id: true,
      code: true,
      name: true,
      address: true,
      isActive: true,
      region: { select: { name: true } },
      _count: { select: { users: { where: { isActive: true } } } },
    },
  });
}

export type StoreListItem = Awaited<ReturnType<typeof listStoresInScope>>[number];

/** 营业中的全部门店（采购收货门店、调拨收货门店的下拉选项；只有编码和名称） */
export async function listActiveStoreOptions() {
  const stores = await prisma.store.findMany({ where: { isActive: true }, orderBy: { code: "asc" }, select: { id: true, code: true, name: true } });
  return stores.map((s) => ({ id: s.id, label: `${s.code} ${s.name}` }));
}

/** 查不到返回 null；查得到但不在范围内抛 PermissionError */
export async function getStoreInScope(user: CurrentUser, id: number) {
  const store = await prisma.store.findUnique({
    where: { id },
    select: {
      id: true,
      code: true,
      name: true,
      address: true,
      isActive: true,
      regionId: true,
      region: { select: { name: true } },
      users: {
        where: { isActive: true },
        orderBy: { id: "asc" },
        select: { id: true, username: true, name: true, role: true },
      },
    },
  });
  if (!store) return null;
  assertStoreAccess(user, store);
  return store;
}

export type StoreDetail = NonNullable<Awaited<ReturnType<typeof getStoreInScope>>>;
