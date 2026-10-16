import { describe, expect, it } from "vitest";
import { canAccessStore, getDataScope, getMenuForRole } from "@/server/auth/permissions";

const storeA = { id: 1, regionId: 10 }; // 华东区 A 店
const storeB = { id: 2, regionId: 10 }; // 华东区 B 店
const storeC = { id: 3, regionId: 20 }; // 华南区 C 店

describe("数据权限：canAccessStore", () => {
  it("店员只能看本店", () => {
    const staff = { role: "STAFF" as const, storeId: 1, regionId: null };
    expect(canAccessStore(staff, storeA)).toBe(true);
    expect(canAccessStore(staff, storeB)).toBe(false);
    expect(canAccessStore(staff, storeC)).toBe(false);
  });

  it("店长只能看本店", () => {
    const manager = { role: "STORE_MANAGER" as const, storeId: 2, regionId: null };
    expect(canAccessStore(manager, storeB)).toBe(true);
    expect(canAccessStore(manager, storeA)).toBe(false);
  });

  it("区域经理能看辖区所有门店，看不了别的区域", () => {
    const regional = { role: "REGIONAL_MANAGER" as const, storeId: null, regionId: 10 };
    expect(canAccessStore(regional, storeA)).toBe(true);
    expect(canAccessStore(regional, storeB)).toBe(true);
    expect(canAccessStore(regional, storeC)).toBe(false);
  });

  it("总部能看全部", () => {
    const hq = { role: "HQ" as const, storeId: null, regionId: null };
    expect(canAccessStore(hq, storeA)).toBe(true);
    expect(canAccessStore(hq, storeC)).toBe(true);
  });

  it("没分配门店或区域的人什么都看不了", () => {
    expect(getDataScope({ role: "STAFF", storeId: null, regionId: null })).toEqual({ kind: "none" });
    expect(getDataScope({ role: "REGIONAL_MANAGER", storeId: null, regionId: null })).toEqual({ kind: "none" });
    expect(canAccessStore({ role: "STAFF", storeId: null, regionId: null }, storeA)).toBe(false);
  });
});

describe("菜单：getMenuForRole", () => {
  it("四种角色的菜单各不相同", () => {
    const keys = (["STAFF", "STORE_MANAGER", "REGIONAL_MANAGER", "HQ"] as const).map((r) =>
      getMenuForRole(r)
        .map((m) => m.key)
        .join(","),
    );
    expect(new Set(keys).size).toBe(4);
  });

  it("店员菜单里没有日结，店长有", () => {
    expect(getMenuForRole("STAFF").some((m) => m.key === "daily-close")).toBe(false);
    expect(getMenuForRole("STORE_MANAGER").some((m) => m.key === "daily-close")).toBe(true);
  });
});
