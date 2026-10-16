import { describe, expect, it } from "vitest";
import { assertStoreAccess, PermissionError, storeScopeWhere, storeTableWhere } from "@/server/auth/scope";

// 四种角色各一条：范围过滤条件对不对，越权是不是会被拒。

const staff = { role: "STAFF" as const, storeId: 1, regionId: null };
const manager = { role: "STORE_MANAGER" as const, storeId: 2, regionId: null };
const regional = { role: "REGIONAL_MANAGER" as const, storeId: null, regionId: 10 };
const hq = { role: "HQ" as const, storeId: null, regionId: null };

const ownStore = { id: 1, regionId: 10 };
const otherStoreSameRegion = { id: 2, regionId: 10 };
const otherRegionStore = { id: 3, regionId: 20 };

describe("数据范围：查询条件", () => {
  it("店员只查本店", () => {
    expect(storeScopeWhere(staff)).toEqual({ storeId: 1 });
    expect(storeTableWhere(staff)).toEqual({ id: 1 });
  });

  it("店长只查本店", () => {
    expect(storeScopeWhere(manager)).toEqual({ storeId: 2 });
    expect(storeTableWhere(manager)).toEqual({ id: 2 });
  });

  it("区域经理查辖区", () => {
    expect(storeScopeWhere(regional)).toEqual({ store: { regionId: 10 } });
    expect(storeTableWhere(regional)).toEqual({ regionId: 10 });
  });

  it("总部不加条件", () => {
    expect(storeScopeWhere(hq)).toEqual({});
    expect(storeTableWhere(hq)).toEqual({});
  });

  it("没分配门店的店员什么都查不到", () => {
    expect(storeScopeWhere({ role: "STAFF", storeId: null, regionId: null })).toEqual({ storeId: -1 });
  });
});

describe("数据范围：越权拒绝", () => {
  it("店员看别家店被拒，看本店放行", () => {
    expect(() => assertStoreAccess(staff, otherStoreSameRegion)).toThrow(PermissionError);
    expect(() => assertStoreAccess(staff, ownStore)).not.toThrow();
  });

  it("店长看别家店被拒", () => {
    expect(() => assertStoreAccess(manager, ownStore)).toThrow(PermissionError);
  });

  it("区域经理看别的区域被拒，看辖区放行", () => {
    expect(() => assertStoreAccess(regional, otherRegionStore)).toThrow(PermissionError);
    expect(() => assertStoreAccess(regional, otherStoreSameRegion)).not.toThrow();
  });

  it("总部都放行", () => {
    expect(() => assertStoreAccess(hq, otherRegionStore)).not.toThrow();
  });
});
