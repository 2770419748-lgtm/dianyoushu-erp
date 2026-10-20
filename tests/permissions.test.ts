import { describe, expect, it } from "vitest";
import { canAccessStore, canSeeWecomFollow, getDataScope, getMenuForRole } from "@/server/auth/permissions";

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

describe("企业微信跟进关系谁能看（口径第 12 节）", () => {
  const follow = { userId: 7, storeId: 3, regionId: 1 };
  it("员工本人、本店店长、辖区区域经理、总部能看；别人看不到", () => {
    expect(canSeeWecomFollow({ id: 7, role: "STAFF", storeId: 3, regionId: null }, follow)).toBe(true);
    expect(canSeeWecomFollow({ id: 8, role: "STAFF", storeId: 3, regionId: null }, follow)).toBe(false);
    expect(canSeeWecomFollow({ id: 9, role: "STORE_MANAGER", storeId: 3, regionId: null }, follow)).toBe(true);
    expect(canSeeWecomFollow({ id: 9, role: "STORE_MANAGER", storeId: 4, regionId: null }, follow)).toBe(false);
    expect(canSeeWecomFollow({ id: 10, role: "REGIONAL_MANAGER", storeId: null, regionId: 1 }, follow)).toBe(true);
    expect(canSeeWecomFollow({ id: 10, role: "REGIONAL_MANAGER", storeId: null, regionId: 2 }, follow)).toBe(false);
    expect(canSeeWecomFollow({ id: 1, role: "HQ", storeId: null, regionId: null }, follow)).toBe(true);
  });
  it("还没对上 ERP 员工的跟进关系只有总部看得到", () => {
    const orphan = { userId: null, storeId: null, regionId: null };
    expect(canSeeWecomFollow({ id: 9, role: "STORE_MANAGER", storeId: 3, regionId: null }, orphan)).toBe(false);
    expect(canSeeWecomFollow({ id: 1, role: "HQ", storeId: null, regionId: null }, orphan)).toBe(true);
  });
  it("企业微信对接开着时总部菜单多“企微对接”，店员店长多“企微侧边栏”（第三步），区域经理不变", () => {
    expect(getMenuForRole("HQ").some((m) => m.key === "wecom")).toBe(false);
    expect(getMenuForRole("HQ", { wecom: true }).some((m) => m.key === "wecom")).toBe(true);
    expect(getMenuForRole("STAFF", { wecom: true }).filter((m) => m.key !== "wecom-sidebar")).toEqual(getMenuForRole("STAFF"));
    expect(getMenuForRole("REGIONAL_MANAGER", { wecom: true })).toEqual(getMenuForRole("REGIONAL_MANAGER"));
  });
});
