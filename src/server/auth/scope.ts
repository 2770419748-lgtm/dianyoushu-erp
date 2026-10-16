import { canAccessStore, getDataScope, type Actor } from "./permissions";

// 数据范围落到查询上：所有按门店过滤的查询都从这里拿 where 条件，越权访问直接抛 PermissionError。
// 页面和 Server Function 捕获 PermissionError 后显示"没有权限"，不要自己拼 storeId 条件。

export class PermissionError extends Error {
  constructor(message = "没有权限访问这家门店的数据") {
    super(message);
    this.name = "PermissionError";
  }
}

/** 给带 storeId 列的表（库存、单据等）用的 where 片段 */
export type StoreScopeWhere = Record<string, never> | { storeId: number } | { store: { regionId: number } };

export function storeScopeWhere(actor: Actor): StoreScopeWhere {
  const scope = getDataScope(actor);
  switch (scope.kind) {
    case "all":
      return {};
    case "region":
      return { store: { regionId: scope.regionId } };
    case "store":
      return { storeId: scope.storeId };
    case "none":
      return { storeId: -1 }; // 没分配门店的人什么都查不到
  }
}

/** 给 stores 表本身用的 where 片段 */
export type StoreTableWhere = Record<string, never> | { id: number } | { regionId: number };

export function storeTableWhere(actor: Actor): StoreTableWhere {
  const scope = getDataScope(actor);
  switch (scope.kind) {
    case "all":
      return {};
    case "region":
      return { regionId: scope.regionId };
    case "store":
      return { id: scope.storeId };
    case "none":
      return { id: -1 };
  }
}

/** 看某家门店之前先调它；越权就抛错 */
export function assertStoreAccess(actor: Actor, store: { id: number; regionId: number }): void {
  if (!canAccessStore(actor, store)) throw new PermissionError();
}
